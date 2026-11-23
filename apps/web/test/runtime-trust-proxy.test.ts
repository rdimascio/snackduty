import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveClient } from "@lesto/runtime";
import type { GracefulShutdownOptions } from "@lesto/runtime";
import { afterAll, describe, expect, it } from "vitest";

import { networkCidrs } from "../../../infra/alchemy/stack-plan";
import {
  LOAD_BALANCER_TRUST_PROXY,
  VPC_ADDRESS_PREFIX,
  isVpcAddress,
  startRuntimeServer,
} from "../runtime/server";
import type { RuntimeConfiguration } from "../runtime/config";

const LOAD_BALANCER_PEER = "10.42.1.15";

const DIRECT_PEER = "192.168.1.20";

const scratch = await mkdtemp(join(tmpdir(), "snackday-trust-proxy-"));

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function configuration(): RuntimeConfiguration {
  return {
    mode: "staging",
    databasePath: join(scratch, "runtime.db"),
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: new URL("https://staging.snackduty.test"),
    appleClientId: "com.snackday.runtime-fixture",
    upstreamCredentialPathLoggingSafe: false,
  };
}

describe("the production server's client identity", () => {
  it("passes the load balancer trust policy to the transport", async () => {
    let seen: GracefulShutdownOptions | undefined;
    const running = await startRuntimeServer(configuration(), {
      serve: (_app, options) => {
        seen = options;
        return Promise.resolve({ port: 0, close: () => Promise.resolve() });
      },
    });
    await running.stop();

    expect(seen?.trustProxy).toBe(LOAD_BALANCER_TRUST_PROXY);
  });

  it("matches the VPC range the infra stack creates", () => {
    expect(networkCidrs.vpc).toBe(`${VPC_ADDRESS_PREFIX}0.0/16`);
  });

  it("trusts only VPC peers, plain or IPv4-mapped", () => {
    expect(isVpcAddress(LOAD_BALANCER_PEER)).toBe(true);
    expect(isVpcAddress(`::ffff:${LOAD_BALANCER_PEER}`)).toBe(true);
    expect(isVpcAddress(DIRECT_PEER)).toBe(false);
    expect(isVpcAddress("10.4.2.1")).toBe(false);
    expect(isVpcAddress("127.0.0.1")).toBe(false);
    expect(isVpcAddress("::1")).toBe(false);
  });

  it("keys two clients behind the load balancer apart", () => {
    const first = resolveClient(LOAD_BALANCER_TRUST_PROXY, LOAD_BALANCER_PEER, {
      "x-forwarded-for": "203.0.113.7",
    });
    const second = resolveClient(LOAD_BALANCER_TRUST_PROXY, LOAD_BALANCER_PEER, {
      "x-forwarded-for": "198.51.100.23",
    });

    expect(first.ip).toBe("203.0.113.7");
    expect(second.ip).toBe("198.51.100.23");
  });

  it("ignores entries a client prepends to forge its address, even VPC-shaped ones", () => {
    for (const forged of ["1.2.3.4", "10.42.0.9"]) {
      const client = resolveClient(LOAD_BALANCER_TRUST_PROXY, LOAD_BALANCER_PEER, {
        "x-forwarded-for": `${forged}, 203.0.113.7`,
      });
      expect({ forged, ip: client.ip }).toEqual({ forged, ip: "203.0.113.7" });
    }
  });

  it("ignores the header from a peer outside the VPC", () => {
    const client = resolveClient(LOAD_BALANCER_TRUST_PROXY, DIRECT_PEER, {
      "x-forwarded-for": "203.0.113.7",
    });

    expect(client.ip).toBe(DIRECT_PEER);
  });

  it("falls back to the socket peer when the header is missing", () => {
    expect(resolveClient(LOAD_BALANCER_TRUST_PROXY, LOAD_BALANCER_PEER, {}).ip).toBe(
      LOAD_BALANCER_PEER,
    );
  });
});
