export type Brand = "snackday" | "ballplayer";

export const BALLPLAYER_DEV_HOST = "ballplayer.localhost";

const BALLPLAYER_HOSTS: ReadonlySet<string> = new Set([
  "ballplayer.co",
  "www.ballplayer.co",
  BALLPLAYER_DEV_HOST,
]);

const PORT_SUFFIX = /:\d*$/u;

const TRAILING_DOT = /\.$/u;

export function hostName(host: string | undefined): string {
  return (host ?? "").trim().toLowerCase().replace(PORT_SUFFIX, "").replace(TRAILING_DOT, "");
}

export function brandForHost(host: string | undefined): Brand {
  return BALLPLAYER_HOSTS.has(hostName(host)) ? "ballplayer" : "snackday";
}

export function brandOfRequest(headers: Readonly<Record<string, string>> | undefined): Brand {
  return brandForHost(headers?.["host"]);
}
