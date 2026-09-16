import { expect, test } from "bun:test";
import { assertExpectedAccount, verifyAwsAccount } from "./account";

test("account guard requires exact STS account without exposing identity", () => {
  expect(() => assertExpectedAccount("123456789012", { Account: "123456789012" })).not.toThrow();
  for (const identity of [null, {}, { Account: "987654321098", Arn: "sensitive" }]) {
    expect(() => assertExpectedAccount("123456789012", identity)).toThrow("AWS_ACCOUNT_MISMATCH");
    try {
      assertExpectedAccount("123456789012", identity);
    } catch (error) {
      expect(String(error)).not.toContain("sensitive");
    }
  }
});

test("STS and deployment share frozen credentials and explicit region despite ambient profiles", () => {
  const environment: Record<string, string | undefined> = {
    AWS_PROFILE: "different-account",
    AWS_DEFAULT_PROFILE: "also-different",
    AWS_ACCESS_KEY_ID: "old-key",
    AWS_SECRET_ACCESS_KEY: "old-secret",
    AWS_SESSION_TOKEN: "old-token",
    AWS_REGION: "us-east-1",
  };
  let calls = 0;
  verifyAwsAccount("123456789012", "us-west-2", environment, (args, env) => {
    calls++;
    if (args[0] === "configure")
      return JSON.stringify({
        AccessKeyId: "resolved-key",
        SecretAccessKey: "resolved-secret",
        SessionToken: "resolved-token",
      });
    expect(env["AWS_PROFILE"]).toBeUndefined();
    expect(env["AWS_DEFAULT_PROFILE"]).toBeUndefined();
    expect(env["AWS_ACCESS_KEY_ID"]).toBe("resolved-key");
    expect(env["AWS_SECRET_ACCESS_KEY"]).toBe("resolved-secret");
    expect(env["AWS_SESSION_TOKEN"]).toBe("resolved-token");
    expect(env["AWS_REGION"]).toBe("us-west-2");
    expect(env["AWS_DEFAULT_REGION"]).toBe("us-west-2");
    return '{"Account":"123456789012"}';
  });
  expect(calls).toBe(2);
  expect(environment["AWS_PROFILE"]).toBeUndefined();
  expect(environment["AWS_ACCESS_KEY_ID"]).toBe("resolved-key");
  expect(environment["AWS_REGION"]).toBe("us-west-2");
});

test("failed identity verification never installs credentials and never reflects CLI output", () => {
  const environment = { AWS_PROFILE: "original" };
  for (const response of ['{"Account":"999999999999"}', "secret-value"]) {
    expect(() =>
      verifyAwsAccount("123456789012", "us-west-2", environment, (args) =>
        args[0] === "configure" ? '{"AccessKeyId":"key","SecretAccessKey":"secret"}' : response,
      ),
    ).toThrow();
    expect(environment).toEqual({ AWS_PROFILE: "original" });
  }
  expect(() =>
    verifyAwsAccount("123456789012", "us-west-2", environment, () => {
      throw new Error("secret-value");
    }),
  ).toThrow("AWS_IDENTITY_UNAVAILABLE: unable to resolve deployment credentials");
});
