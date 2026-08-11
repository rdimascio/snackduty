# 0009 — Events: materialized recurrence, wall-time storage, attendance, and private calendar feeds

- Status: Accepted
- Date: 2026-08-03

## Context

Events (practices and games) are the last prerequisite for duties, which will attach per-occurrence
work to the schedule. The slice needs recurring series, per-occurrence cancellation, per-child
attendance, and calendar interop (subscribable feeds plus single-event export) — without ever
putting child roster data somewhere less protected than the authorized APIs.

## Decision

### Recurrence is materialized, whole-series, at write time

An event series stores its schedule (frequency `once` or `weekly`, weekdays, start/until dates) and
every occurrence is a durable row created inside the same transaction — one row per date, unique on
`(series_id, local_date)`. Nothing derives instances at read time: attendance, cancellation, a
moved practice, and later duties all need a stable row id to attach to.

**Horizon:** the WHOLE series is materialized up front. A weekly series requires an until date, and
a series may not expand to more than 200 occurrences (a 6-month season of daily events fits; the
cap answers a coded 422, mirroring the roster import's `too_many_rows`). There is no background
materializer to run, crash, or lag: what the manager created is exactly what exists.

**Series edit** replaces the whole definition (same schema as create) and reconciles occurrences
deterministically, keyed by `local_date`:

- A date present in both old and new schedules KEEPS its occurrence row (same id — attendance and
  cancellation state survive), with time-of-day, duration, and the derived instant recomputed.
- A date only in the new schedule gets a fresh occurrence.
- A FUTURE occurrence whose date left the schedule is CANCELLED with the reserved reason
  `Removed by schedule change` — never deleted, so recorded attendance and the visible history
  survive. Past occurrences are left untouched whatever the new schedule says.
- A kept date whose row a PRIOR edit already cancelled with that reserved reason is REINSTATED —
  the date is back in the schedule, so the machine-made cancellation that removed it is undone.
  Only FUTURE rows are reinstated, and only machine cancellations: a manager's own cancellation
  (any other reason) and every past occurrence stay exactly as they are, so an edit can never
  quietly un-cancel a practice a human called off. "Future" is judged on the instant the row is
  moving TO, not the one it is moving from — the same edit may change the time of day or the zone,
  and deciding on the stale value would either mark a now-past occurrence `scheduled` or strand a
  now-future one cancelled under a reason that is no longer true.
- Cancelling an ALREADY-cancelled occurrence is an idempotent no-op that preserves a human's
  reason. The reserved marker is the one exception: a manager cancelling over it takes ownership
  and their reason replaces it, because leaving the marker in place would let the next edit
  reinstate an occurrence they explicitly called off. The reserved reason is itself refused at the
  cancel endpoint (coded 422), so a human can never write the marker directly.

An edit therefore cannot orphan (removed dates become visibly cancelled rows, still attached to the
series) and cannot duplicate (the `local_date` key plus a unique index make re-generation converge
on the existing rows).

### Time is stored as wall time plus IANA zone; instants are derived per occurrence

The series stores `time_zone` (validated IANA name), `local_time` (HH:MM), and duration. Each
occurrence stores its local date AND the derived UTC instant (`starts_at_utc`), recomputed whenever
the schedule changes. Deriving per-occurrence means a 5:00pm practice is 5:00pm local on BOTH sides
of a DST transition — the UTC instants differ by an hour, which is the point. The derivation
(`event-time.ts`) uses the Intl API with a two-pass offset fix-up; tests cross the real
`America/Los_Angeles` spring-forward and fall-back boundaries.

### Cancellation is a state, attendance is an upsert

Cancelling an occurrence sets `status = cancelled` with a required reason; the row stays visible
and re-cancelling is an idempotent no-op that preserves the original reason. Attendance is one row
per (occurrence, child) — `yes` / `no` / `maybe` — upserted, recording which adult wrote it
(audit column only; never projected). Attendance on a cancelled occurrence is refused (409).

**Authorization** goes through the existing seams, hiding 404 everywhere, never a 403: a manager
(`manageableActiveTeam`) records attendance for any child rostered on the series' season; a
guardian records it for children they hold an ACTIVE `guardian_relationships` edge to. Reads:
managers see every child's attendance, a guardian sees their own children's entries, every team
reader sees counts only — attendance is a per-child fact about a minor, so the default is the
narrow one (an operator decision may widen it later).

### Calendar feeds carry the schedule, never the roster

The bearer-credential rule (a credential never appears in a Snackday request line) CANNOT hold for
a calendar subscription: Apple and Google poll a plain GET URL. We accept that collision narrowly
and explicitly:

- The feed token is per-adult, per-team, random 32 bytes, stored HASH-ONLY like invitation tokens.
  Minting again ROTATES (the old URL dies); revoke kills the feed outright. A feed whose adult has
  lost team access answers the hiding 404 — byte-identical for unknown, revoked, rotated-away, and
  no-longer-authorized tokens.
- Responses carry `X-Robots-Tag: noindex, nofollow` and `Cache-Control: private, no-store`, and
  the URL is not guessable from any team or person id. The path shape `/calendar/feed/:token` is
  registered in the access-log redaction rules — but that seam is NOT installed on the tier that
  serves the feed; see the known gap below.
- The feed body is DELIBERATELY child-free: team name, event title/kind, time, location, notes,
  and cancellation state (`STATUS:CANCELLED`) — never a child's name, never attendance, never
  guardian data. A leaked feed URL exposes a practice schedule, not a roster of minors. The tests
  and the acceptance leg that assert this UNFOLD the served body before scanning it, because ICS
  folds content lines mid-word and a name straddling a fold would otherwise walk past the scan.
- Single-event ICS export is an AUTHENTICATED download (session cookie, readable team), not a
  pollable URL, and is equally child-free.

ICS output is RFC 5545-shaped: CRLF lines folded at 75 octets, escaped text values, stable
per-occurrence UIDs, UTC instants (each occurrence carries its own derived instant, so zone
correctness never depends on a client honoring VTIMEZONE). TEXT escaping covers ALL THREE
line-ending forms — CRLF, a bare LF, and a bare CR — because a manager types notes in a browser
textarea and a lone CR left raw would end the content line, letting the rest of the note be read
as forged iCalendar properties.

### Known gap: the node tier logs the feed token verbatim

The redaction seam in `access-log.ts` is installed in exactly ONE place: `worker.ts`, the
Cloudflare edge handler, because `@lesto/cloudflare`'s `toFetchHandler` accepts a `logRequest`
option. That edge app registers four PAGE routes and no database — it never serves
`/calendar/feed/:token` at all. The tier that does serve the feed (`lesto dev` and `lesto serve`)
is booted by the Lesto CLI from `LestoAppConfig` — `db`, `app`, `migrations`, `dialect`, `ui`,
`durable`, `schemas`, `secure` — which exposes no logging seam, so it keeps `@lesto/runtime`'s
`defaultLogRequest` and writes the pathname verbatim:

```
{"level":"info","event":"http.access","method":"GET","path":"/calendar/feed/<live 64-hex token>",…}
```

So, plainly:

- The redaction rule for the feed is INERT today. There is no in-repo fix: installing it on the
  node tier means calling `@lesto/runtime`'s `serve()` ourselves and re-implementing health, serve
  limits, tracing, and graceful shutdown — not warranted while no node deployment exists. The fix
  belongs upstream, as a `logRequest` seam on `LestoAppConfig`.
- Realized exposure is therefore limited to developer terminals and the acceptance harness's
  captured server log. It becomes live exposure the moment Snackday is served from the node tier;
  that is the trigger to block on the framework seam (or to accept the credential in the logs
  deliberately, as an operator decision).
- A `logRequest` seam would not close the whole path anyway: with OTLP tracing enabled BOTH tiers
  put the raw pathname in the `http.path` span attribute, which no access-log sink can reach. Any
  credential that travels in a request line must be assumed to reach the trace backend too.
- This is a RECURRING class in this codebase, not a one-off. The same defect was found and fixed
  for invitation tokens by moving the credential into the URL fragment (`/invite#<token>`), which
  no client ever transmits. A calendar client cannot use a fragment — it polls exactly the URL it
  was handed — so the feed cannot take that escape, and rotation plus revocation remain its only
  containment.

A documented control that does not run is worse than a known gap, because it buys confidence
nothing earned. Until the seam exists, this section IS the control.

## Non-goals

- Duties (the consumer this model exists for) — separate task.
- Per-child feed content or any child data in ICS anywhere.
- Un-cancelling an occurrence, per-occurrence reschedule endpoints, and notification fan-out —
  the data model supports them (occurrences own their time fields), but no surface exists yet.
- Cross-process double-submit safety beyond `@lesto/db`'s single-connection serialization.
