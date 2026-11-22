export type Brand = "snackday" | "ballplayer" | "coach";

export const BALLPLAYER_DEV_HOST = "ballplayer.localhost";

export const COACH_DEV_HOST = "coach.localhost";

const BALLPLAYER_HOSTS: ReadonlySet<string> = new Set([
  "ballplayer.co",
  "www.ballplayer.co",
  BALLPLAYER_DEV_HOST,
]);

const COACH_HOSTS: ReadonlySet<string> = new Set([
  "dimasciobaseball.com",
  "www.dimasciobaseball.com",
  COACH_DEV_HOST,
]);

const PORT_SUFFIX = /:\d*$/u;

const TRAILING_DOT = /\.$/u;

export function hostName(host: string | undefined): string {
  return (host ?? "").trim().toLowerCase().replace(PORT_SUFFIX, "").replace(TRAILING_DOT, "");
}

export function brandForHost(host: string | undefined): Brand {
  const name = hostName(host);
  if (BALLPLAYER_HOSTS.has(name)) return "ballplayer";
  if (COACH_HOSTS.has(name)) return "coach";
  return "snackday";
}

export function brandOfRequest(headers: Readonly<Record<string, string>> | undefined): Brand {
  return brandForHost(headers?.["host"]);
}
