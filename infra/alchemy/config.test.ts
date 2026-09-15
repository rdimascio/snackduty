import { describe, expect, test } from "bun:test";

import { loadAwsStagingConfig } from "./config";
import { buildAwsStagingPlan, networkCidrs } from "./stack-plan";

describe("AWS staging Alchemy configuration", () => {
  test("builds a private RDS plan with same-zone API placement", () => {
    const config = loadAwsStagingConfig(fixtureEnvironment());
    const plan = buildAwsStagingPlan(config);

    expect(plan.publicBaseUrl).toBe("https://staging.snackday.example");
    expect(plan.api.availabilityZone).toBe(plan.database.availabilityZone);
    expect(plan.database.publiclyAccessible).toBe(false);
    expect(plan.database.storageEncrypted).toBe(true);
    expect(plan.database.backupRetentionDays).toBe(7);
    expect(plan.database.ingress).toEqual([{ source: "api", protocol: "tcp", port: 5432 }]);
    expect(plan.api.ingress).toEqual([{ source: "load-balancer", protocol: "tcp", port: 3000 }]);
    expect(plan.network.databaseSubnets).toEqual([
      { cidr: networkCidrs.databaseA, availabilityZone: "us-west-2a", public: false },
      { cidr: networkCidrs.databaseB, availabilityZone: "us-west-2b", public: false },
    ]);
  });

  test("fails closed before PostgreSQL runtime verification", () => {
    expect(() =>
      loadAwsStagingConfig(fixtureEnvironment(), { requirePostgresRuntime: true }),
    ).toThrow("SNACKDAY_POSTGRES_RUNTIME_VERIFIED=1");

    expect(
      loadAwsStagingConfig(
        { ...fixtureEnvironment(), SNACKDAY_POSTGRES_RUNTIME_VERIFIED: "1" },
        { requirePostgresRuntime: true },
      ).postgresRuntimeVerified,
    ).toBe(true);
  });

  test("rejects ambiguous zones and malformed external identifiers", () => {
    expect(() =>
      loadAwsStagingConfig({
        ...fixtureEnvironment(),
        SNACKDAY_DEPLOY_STAGE: "production",
      }),
    ).toThrow("must be staging");

    expect(() =>
      loadAwsStagingConfig({
        ...fixtureEnvironment(),
        SNACKDAY_AWS_SECONDARY_AZ: "us-west-2a",
      }),
    ).toThrow("must differ");

    expect(() =>
      loadAwsStagingConfig({
        ...fixtureEnvironment(),
        SNACKDAY_STAGING_HOSTNAME: "https://staging.snackday.example",
      }),
    ).toThrow("SNACKDAY_STAGING_HOSTNAME has an invalid value");

    expect(() =>
      loadAwsStagingConfig({
        ...fixtureEnvironment(),
        SNACKDAY_ACM_CERTIFICATE_ARN:
          "arn:aws:acm:us-east-1:123456789012:certificate/12345678-1234-1234-1234-123456789012",
      }),
    ).toThrow("must name an ACM certificate in us-west-2");
  });
});

function fixtureEnvironment(): Readonly<Record<string, string>> {
  return {
    SNACKDAY_DEPLOY_STAGE: "staging",
    SNACKDAY_AWS_REGION: "us-west-2",
    SNACKDAY_AWS_PRIMARY_AZ: "us-west-2a",
    SNACKDAY_AWS_SECONDARY_AZ: "us-west-2b",
    SNACKDAY_STAGING_HOSTNAME: "staging.snackday.example",
    SNACKDAY_ROUTE53_HOSTED_ZONE_ID: "Z1234567890AB",
    SNACKDAY_ACM_CERTIFICATE_ARN:
      "arn:aws:acm:us-west-2:123456789012:certificate/12345678-1234-1234-1234-123456789012",
    SNACKDAY_API_AMI_ID: "ami-0123456789abcdef0",
    SNACKDAY_API_ARTIFACT_DIGEST:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    SNACKDAY_APPLE_CLIENT_ID: "com.snackday.app",
    SNACKDAY_RUNTIME_SECRET_ARN:
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:snackday/staging-AbCdEf",
    SNACKDAY_POSTGRES_ENGINE_VERSION: "17.6",
    ALCHEMY_STATE_BUCKET: "snackday-alchemy-state",
  };
}
