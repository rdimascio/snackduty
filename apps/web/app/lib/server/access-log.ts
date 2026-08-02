/**
 * The access log's REDACTION seam: a credential that travels in a URL path
 * must never be written to a log line.
 *
 * Both Lesto tiers log one access line per ADMITTED request — the node server
 * (`@lesto/runtime`'s `serve`) and the edge handler (`@lesto/cloudflare`'s
 * `toFetchHandler`) each default to a structured JSON line carrying the
 * request's PATHNAME verbatim, and both fire in a `finally` — so a 404, a 429,
 * and a 200 are logged alike, whether or not a route matched. Snackday's
 * invitation link (`inviteUrlFor`) puts a 14-day bearer token in that pathname,
 * so the default sink would write the live credential to stdout on every hit.
 *
 * The rule below is a path SHAPE, not a secret-looking-string regex: each entry
 * names a route whose path carries a credential and which segment holds it, so
 * a future secret-bearing route is one line here rather than a new pattern to
 * get right. Everything else about the line is preserved — method, status,
 * latency, request id — so the log stays operationally useful and only the
 * credential is lost.
 *
 * This redacts OUR log sink. A token in a URL path still reaches every other
 * party that records request lines (a proxy, a CDN, the browser's history, a
 * `Referer` header); only moving the token out of the path would change that,
 * which is a link-format decision this seam deliberately does not make.
 */

/** What a credential segment is replaced with. */
export const REDACTED_SEGMENT = "[redacted]";

/** Marks the template segment that holds the credential. */
const CREDENTIAL = "*";

/**
 * Every route whose URL path carries a bearer credential, as a segment
 * template: a literal segment matches itself (case-insensitively — an unrouted
 * `/INVITE/<token>` is logged too), `CREDENTIAL` marks the secret segment, and
 * a longer path still matches its prefix (`/invite/<token>/anything`).
 */
const CREDENTIAL_ROUTES: readonly (readonly string[])[] = [
  // `/invite/<token>` — the invitation bearer token minted by `inviteUrlFor`.
  ["invite", CREDENTIAL],
];

function matchesRoute(template: readonly string[], segments: readonly string[]): boolean {
  if (segments.length < template.length) return false;

  return template.every((expected, index) => {
    const segment = segments[index] ?? "";

    return expected === CREDENTIAL ? segment !== "" : segment.toLowerCase() === expected;
  });
}

/**
 * The pathname with every credential segment replaced, or the pathname
 * unchanged when no credential-bearing route matches. Pure — the unit that
 * makes the redaction testable independently of any server.
 */
export function redactCredentialPath(path: string): string {
  const [root, ...segments] = path.split("/");
  const template = CREDENTIAL_ROUTES.find((candidate) => matchesRoute(candidate, segments));
  if (template === undefined) return path;

  const redacted = segments.map((segment, index) =>
    template[index] === CREDENTIAL ? REDACTED_SEGMENT : segment,
  );

  return [root ?? "", ...redacted].join("/");
}

/** One served request, as both tiers' access sinks receive it. */
export interface AccessLogEntry {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly ms: number;
  readonly requestId: string;
}

/**
 * The structured access line both Lesto tiers emit by default — reproduced
 * here (the edge's default sink is internal to `@lesto/cloudflare`) so wiring
 * a redacting sink costs no observability: same event, same fields, same shape
 * a log pipeline already parses.
 */
export function logAccessLine(entry: AccessLogEntry): void {
  console.log(
    JSON.stringify({
      level: "info",
      event: "http.access",
      method: entry.method,
      path: entry.path,
      status: entry.status,
      ms: entry.ms,
      request_id: entry.requestId,
    }),
  );
}

/**
 * Wrap an access-log sink so a credential-bearing path is redacted before the
 * sink ever sees it. The wrapped sink is handed the SAME entry object when
 * nothing matched, so the common path allocates nothing.
 */
export function redactingLogRequest(
  sink: (entry: AccessLogEntry) => void,
): (entry: AccessLogEntry) => void {
  return (entry) => {
    const path = redactCredentialPath(entry.path);

    sink(path === entry.path ? entry : { ...entry, path });
  };
}
