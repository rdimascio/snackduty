import { describe, expect, it } from "vitest";

import { BALLPLAYER_DEV_HOST, brandForHost, brandOfRequest, hostName } from "../app/brand/brand";

describe("brandForHost", () => {
  it.each([
    "ballplayer.co",
    "www.ballplayer.co",
    BALLPLAYER_DEV_HOST,
    "BallPlayer.CO",
    "WWW.BALLPLAYER.CO",
    "ballplayer.co:443",
    "www.ballplayer.co:8443",
    "ballplayer.localhost:3000",
    "ballplayer.co.",
    " ballplayer.co ",
  ])("maps %j to Ballplayer", (host) => {
    expect(brandForHost(host)).toBe("ballplayer");
  });

  it.each([
    "snackday.app",
    "www.snackday.app",
    "staging.snackduty.test",
    "localhost:3000",
    "127.0.0.1:3000",
    "[::1]:3000",
    "ballplayer.co.evil.test",
    "evil-ballplayer.co",
    "ballplayer.com",
    "app.ballplayer.co",
    "ballplayer.co.localhost",
    "ballplayer.localhost.evil.test",
    "ballplayer",
    "",
  ])("maps %j to Snackday", (host) => {
    expect(brandForHost(host)).toBe("snackday");
  });

  it("maps a missing Host to Snackday", () => {
    expect(brandForHost(undefined)).toBe("snackday");
    expect(brandOfRequest(undefined)).toBe("snackday");
    expect(brandOfRequest({})).toBe("snackday");
  });

  it("reads the lowercased host request header", () => {
    expect(brandOfRequest({ host: "ballplayer.co" })).toBe("ballplayer");
    expect(brandOfRequest({ "x-forwarded-host": "ballplayer.co" })).toBe("snackday");
    expect(brandOfRequest({ host: "snackday.app", "x-forwarded-host": "ballplayer.co" })).toBe(
      "snackday",
    );
  });
});

describe("hostName", () => {
  it("lowercases and drops the port and a trailing dot", () => {
    expect(hostName("WWW.Ballplayer.co:8080")).toBe("www.ballplayer.co");
    expect(hostName("ballplayer.co.")).toBe("ballplayer.co");
    expect(hostName(undefined)).toBe("");
  });
});
