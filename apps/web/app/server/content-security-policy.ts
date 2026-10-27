import type { LestoResponse } from "@lesto/web";

type HeaderMap = LestoResponse["headers"];

export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; media-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export const CONTENT_SECURITY_POLICY_HEADER = "content-security-policy";

export function withContentSecurityPolicy<R extends { readonly headers: HeaderMap }>(
  response: R,
): R {
  const headers: HeaderMap = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (name.toLowerCase() !== CONTENT_SECURITY_POLICY_HEADER) headers[name] = value;
  }
  headers[CONTENT_SECURITY_POLICY_HEADER] = CONTENT_SECURITY_POLICY;
  return { ...response, headers };
}
