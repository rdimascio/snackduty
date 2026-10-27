import type { LestoResponse } from "@lesto/web";

import type { Brand } from "../brand/brand";

type HeaderMap = LestoResponse["headers"];

type Directive = readonly [name: string, sources: readonly string[]];

export const REEL_MEDIA_ORIGIN = "https://media.dimasciobaseball.com";

const SELF = "'self'";

const NONE = "'none'";

const STRICT_DIRECTIVES: readonly Directive[] = [
  ["default-src", [SELF]],
  ["script-src", [SELF]],
  ["style-src", [SELF]],
  ["img-src", [SELF]],
  ["font-src", [SELF]],
  ["connect-src", [SELF]],
  ["media-src", [SELF]],
  ["frame-src", [NONE]],
  ["object-src", [NONE]],
  ["base-uri", [NONE]],
  ["form-action", [SELF]],
  ["frame-ancestors", [NONE]],
];

const SNACKDAY_EXTRA_SOURCES: Readonly<Record<string, readonly string[]>> = {
  "img-src": [REEL_MEDIA_ORIGIN],
};

function serializePolicy(directives: readonly Directive[]): string {
  return directives.map(([name, sources]) => [name, ...sources].join(" ")).join("; ");
}

function withExtraSources(
  directives: readonly Directive[],
  extra: Readonly<Record<string, readonly string[]>>,
): readonly Directive[] {
  return directives.map(([name, sources]) => [name, [...sources, ...(extra[name] ?? [])]]);
}

export const BALLPLAYER_CONTENT_SECURITY_POLICY = serializePolicy(STRICT_DIRECTIVES);

export const SNACKDAY_CONTENT_SECURITY_POLICY = serializePolicy(
  withExtraSources(STRICT_DIRECTIVES, SNACKDAY_EXTRA_SOURCES),
);

export const CONTENT_SECURITY_POLICY_HEADER = "content-security-policy";

export function contentSecurityPolicyFor(brand: Brand): string {
  return brand === "ballplayer"
    ? BALLPLAYER_CONTENT_SECURITY_POLICY
    : SNACKDAY_CONTENT_SECURITY_POLICY;
}

export function withContentSecurityPolicy<R extends { readonly headers: HeaderMap }>(
  response: R,
  policy: string,
): R {
  const headers: HeaderMap = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (name.toLowerCase() !== CONTENT_SECURITY_POLICY_HEADER) headers[name] = value;
  }
  headers[CONTENT_SECURITY_POLICY_HEADER] = policy;
  return { ...response, headers };
}
