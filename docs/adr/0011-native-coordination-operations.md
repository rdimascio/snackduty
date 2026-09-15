# 0011 — First native coordination journey

- Status: Accepted for implementation; external release evidence remains open
- Date: 2026-09-14

## Decision

Extend existing event, attendance and duty behavior for the selected season.
Keep the team-wide event route for existing web/calendar callers. The new native
journey uses explicit application operations with injected database and time.
Each operation validates input, revalidates the exact active account/person pair
and authorizes its target inside its transaction. No caller-supplied role or
selection grants authority. Existing canonical domain policy remains authoritative.

Creating an event may include one snack slot for a single occurrence. Both commit
together. A client-generated UUID requestId is retained across retries; migration
013 records its account/team/season scope, canonical request hash and created
series/slot. Matching retries reauthorize and return the existing records; a
different request under that key returns request_id_conflict. This guarantees
one creation, not an immutable historical response after a subsequent edit.
No delivery service or notification is added by this journey.

Attendance reads add responseOptions derived from the active season roster and
participant.manage policy, independent of existing responses. A parent can
therefore answer for their own child the first time without seeing peer children.
Writes reauthorize. Snack claims remain adult self-assignment through the existing
conditional update; they confer no child authority.

Native coordination state is separate from authentication state. Its context
includes the adult person, team, season, time zone and server capability hint.
Context changes cancel pending work and discard stale replies. Session loss
clears context. Loading, empty, failure, cancelled events and mutation outcomes
are explicit. Native creation uses the selected season's wall clock/time zone,
and the server validates/materializes the actual instant.

## Frozen seams

- Domain schemas: packages/domain/src/coordination-contracts.ts.
- Application interface: web server coordination-contracts.ts.
- Swift DTOs, transport/controller protocols: CoordinationContracts.swift.
- Shared JSON fixtures: event-create-input, event-created, season-events,
  attendance-own-child, attendance-recorded, duty-slots and duty-claimed.
- POST /api/teams/:teamId/seasons/:seasonId/events accepts optional requestId
  and snackDuty; replies with series, occurrences and dutySlots (empty for legacy
  callers). GET at the same path reads only that authorized active season.
- Attendance responseOptions carry participantId, displayName and optional status.
- Existing attendance POST and duty GET/claim paths stay compatible.
- Expected operation denials use typed results with safe error/code and HTTP
  status. Unexpected storage/integrity failures throw; no success stub is wired.

## Dependency map

Foundation contracts/fixtures/migration -> three independent leaves:
server operations; native transport/controller; native views.
Root then wires composition and Xcode, runs the actual multi-adult HTTP/native
journey, obtains independent review and runs local/hosted gates.
Mock fixtures support parallel work but do not establish integration completion.

League work remains R4; branded apps remain R5. Live Apple, deployed staging,
delivery and TestFlight are not claimed by this local coordination slice.
