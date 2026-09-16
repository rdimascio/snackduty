import { describe, expect, it } from "bun:test";

import {
  classifyAwsFailure,
  livePreflightPassed,
  parseAwsStagingTarget,
  verifyAwsStagingTarget,
  type AwsCommandRunner,
} from "./aws-staging-preflight";

const target = parseAwsStagingTarget({
  schema: "snackday/aws-staging-target/v1",
  stage: "staging",
  awsAccountId: "123456789012",
  region: "us-west-2",
  hostname: "staging.snackday.example",
  publicBaseUrl: "https://staging.snackday.example",
  vpcId: "vpc-0123456789abcdef0",
  apiInstanceId: "i-0123456789abcdef0",
  apiSubnetId: "subnet-0123456789abcdef0",
  apiSecurityGroupId: "sg-0123456789abcdef0",
  apiPort: 3000,
  loadBalancerArn:
    "arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/snackday/0123456789abcdef",
  loadBalancerDnsName: "snackday-0123456789.us-west-2.elb.amazonaws.com",
  loadBalancerSecurityGroupId: "sg-00112233445566778",
  databaseInstanceId: "snackday-staging",
  databaseSubnetGroupName: "snackday-staging-private",
  databaseSecurityGroupId: "sg-0fedcba9876543210",
  databasePort: 5432,
  minimumBackupRetentionDays: 7,
  preDeploySnapshotId: "snackday-staging-pre-release",
  releaseCommit: "a".repeat(40),
  artifactDigest: `sha256:${"b".repeat(64)}`,
  previousArtifactDigest: null,
});

const targetArn = `arn:aws:elasticloadbalancing:${target.region}:${target.awsAccountId}:targetgroup/snackday/0123456789abcdef`;
const listenerArn = `arn:aws:elasticloadbalancing:${target.region}:${target.awsAccountId}:listener/app/snackday/0123456789abcdef/0123456789abcdef`;
const forward = [{ Type: "forward", TargetGroupArn: targetArn }];
function routeFixtures(): Record<string, Record<string, unknown>[]> {
  return {
    Listeners: [
      {
        ListenerArn: listenerArn,
        LoadBalancerArn: target.loadBalancerArn,
        Port: 443,
        Protocol: "HTTPS",
        DefaultActions: structuredClone(forward),
      },
    ],
    Rules: [
      { IsDefault: true, Priority: "default", Conditions: [], Actions: structuredClone(forward) },
    ],
    TargetGroups: [
      {
        TargetGroupArn: targetArn,
        VpcId: target.vpcId,
        TargetType: "instance",
        Protocol: "HTTP",
        Port: 3000,
        LoadBalancerArns: [target.loadBalancerArn],
        HealthCheckEnabled: true,
        HealthCheckProtocol: "HTTP",
        HealthCheckPort: "traffic-port",
        HealthCheckPath: "/readyz",
        Matcher: { HttpCode: "200" },
      },
    ],
    TargetHealthDescriptions: [
      {
        Target: { Id: target.apiInstanceId, Port: 3000 },
        TargetHealth: { State: "healthy" },
        HealthCheckPort: "3000",
      },
    ],
  };
}

function awsRunner(
  options: { readonly unsafeIngress?: boolean; readonly extraApiSecurityGroup?: boolean } = {},
): AwsCommandRunner {
  return async (args) => {
    expect(args).toContain("--region");
    expect(args).toContain(target.region);
    const operation = `${args[0]} ${args[1]}`;
    const routeKey = (
      {
        "elbv2 describe-listeners": "Listeners",
        "elbv2 describe-rules": "Rules",
        "elbv2 describe-target-groups": "TargetGroups",
        "elbv2 describe-target-health": "TargetHealthDescriptions",
      } as Record<string, string>
    )[operation];
    if (routeKey !== undefined) return { [routeKey]: routeFixtures()[routeKey] };
    if (operation === "sts get-caller-identity") {
      return { Account: target.awsAccountId };
    }
    if (operation === "ec2 describe-instances") {
      return {
        Reservations: [
          {
            Instances: [
              {
                VpcId: target.vpcId,
                InstanceId: target.apiInstanceId,
                SubnetId: target.apiSubnetId,
                State: { Name: "running" },
                Placement: { AvailabilityZone: "us-west-2a" },
                SecurityGroups: [
                  { GroupId: target.apiSecurityGroupId },
                  ...(options.extraApiSecurityGroup ? [{ GroupId: "sg-09999999999999999" }] : []),
                ],
              },
            ],
          },
        ],
      };
    }
    if (operation === "rds describe-db-instances") {
      return {
        DBInstances: [
          {
            DBInstanceIdentifier: target.databaseInstanceId,
            DBInstanceStatus: "available",
            Engine: "postgres",
            PubliclyAccessible: false,
            StorageEncrypted: true,
            AvailabilityZone: "us-west-2a",
            BackupRetentionPeriod: 7,
            Endpoint: { Address: "not-emitted.example", Port: 5432 },
            DBSubnetGroup: {
              VpcId: target.vpcId,
              DBSubnetGroupName: target.databaseSubnetGroupName,
            },
            VpcSecurityGroups: [{ VpcSecurityGroupId: target.databaseSecurityGroupId }],
          },
        ],
      };
    }
    if (operation === "ec2 describe-security-groups") {
      expect(args).toContain(target.apiSecurityGroupId);
      expect(args).toContain(target.databaseSecurityGroupId);
      return {
        SecurityGroups: [
          {
            GroupId: target.databaseSecurityGroupId,
            IpPermissions: [
              options.unsafeIngress
                ? {
                    IpProtocol: "tcp",
                    FromPort: 5432,
                    ToPort: 5432,
                    IpRanges: [{ CidrIp: "0.0.0.0/0" }],
                  }
                : {
                    IpProtocol: "tcp",
                    FromPort: 5432,
                    ToPort: 5432,
                    UserIdGroupPairs: [{ GroupId: target.apiSecurityGroupId }],
                  },
            ],
          },
          {
            GroupId: target.apiSecurityGroupId,
            IpPermissions: [
              {
                IpProtocol: "tcp",
                FromPort: 3000,
                ToPort: 3000,
                UserIdGroupPairs: [{ GroupId: target.loadBalancerSecurityGroupId }],
              },
            ],
          },
        ],
      };
    }
    if (operation === "elbv2 describe-load-balancers") {
      expect(args).toContain(target.loadBalancerArn);
      return {
        LoadBalancers: [
          {
            LoadBalancerArn: target.loadBalancerArn,
            DNSName: target.loadBalancerDnsName,
            VpcId: target.vpcId,
            Scheme: "internet-facing",
            State: { Code: "active" },
            SecurityGroups: [target.loadBalancerSecurityGroupId],
          },
        ],
      };
    }
    if (operation === "rds describe-db-snapshots") {
      return {
        DBSnapshots: [
          {
            Status: "available",
            DBInstanceIdentifier: target.databaseInstanceId,
            Encrypted: true,
            SnapshotType: "manual",
            SnapshotCreateTime: "2026-09-15T00:30:00.000Z",
          },
        ],
      };
    }
    throw new Error(`Unexpected AWS operation: ${operation}`);
  };
}

function fetcher(
  statuses: readonly number[],
  release: unknown = { releaseCommit: target.releaseCommit, artifactDigest: target.artifactDigest },
): typeof fetch {
  let index = 0;
  return Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/__snackday/release")) {
        expect(init?.redirect).toBe("error");
        return Response.json(release);
      }
      return new Response(null, { status: statuses[index++] ?? 500 });
    },
    {
      preconnect: (_url: string | URL) => undefined,
    },
  );
}

describe("AWS staging preflight", () => {
  it("rejects a public origin on an unverified listener port", () => {
    expect(() =>
      parseAwsStagingTarget({ ...target, publicBaseUrl: `${target.publicBaseUrl}:8443` }),
    ).toThrow("port 443");
  });
  for (const extraAddress of ["198.51.100.7", "2001:db8::7"]) {
    it("rejects partial DNS overlap including extra IPv6 destinations", async () => {
      const receipt = await verifyAwsStagingTarget(target, {
        live: true,
        runAws: awsRunner(),
        fetcher: fetcher([200, 200, 404]),
        resolveHostname: async (hostname) =>
          hostname === target.hostname ? ["192.0.2.10", extraAddress] : ["192.0.2.10"],
        now: () => new Date("2026-09-15T01:02:03.000Z"),
      });
      expect(livePreflightPassed(receipt)).toBe(false);
    });
  }
  for (const mode of ["network", "status", "html", "invalid-json"]) {
    it(`redacts and rejects release ${mode} failure`, async () => {
      const baseFetch = fetcher([200, 200, 404]);
      const brokenFetch = Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          if (!String(input).endsWith("/__snackday/release")) return baseFetch(input, init);
          if (mode === "network") throw new Error("secret-runtime-error");
          return new Response("secret-runtime-error", {
            status: mode === "status" ? 500 : 200,
            headers: { "content-type": mode === "html" ? "text/html" : "application/json" },
          });
        },
        { preconnect: (_url: string | URL) => undefined },
      );
      const receipt = await verifyAwsStagingTarget(target, {
        live: true,
        runAws: awsRunner(),
        fetcher: brokenFetch,
        resolveHostname: async () => ["192.0.2.10"],
        now: () => new Date("2026-09-15T01:02:03.000Z"),
      });
      expect(livePreflightPassed(receipt)).toBe(false);
      expect(JSON.stringify(receipt)).not.toContain("secret-runtime-error");
    });
  }
  it("classifies common AWS failures without retaining raw output", () => {
    expect(classifyAwsFailure("ExpiredToken: hidden detail")).toBe("credentials expired");
    expect(classifyAwsFailure("AccessDenied: hidden detail")).toBe("access denied");
    expect(classifyAwsFailure("unexpected detail")).toBe("unclassified AWS error");
  });

  it("rejects a target that can conceal credentials in its origin", () => {
    expect(() =>
      parseAwsStagingTarget({
        ...target,
        publicBaseUrl: "https://user:password@staging.snackday.example",
      }),
    ).toThrow("credential-free HTTPS origin");
  });

  it("rejects unknown fields instead of silently retaining secret-bearing input", () => {
    expect(() =>
      parseAwsStagingTarget({
        ...target,
        DATABASE_URL: "must-not-be-accepted",
      }),
    ).toThrow("DATABASE_URL is not an allowed target field");
  });

  it("emits a dry-run receipt without calling AWS or the remote host", async () => {
    let called = false;
    const receipt = await verifyAwsStagingTarget(target, {
      live: false,
      runAws: async () => {
        called = true;
        throw new Error("must not run");
      },
      fetcher: Object.assign(
        async () => {
          called = true;
          throw new Error("must not fetch");
        },
        { preconnect: (_url: string | URL) => undefined },
      ),
      now: () => new Date("2026-09-15T00:00:00.000Z"),
    });

    expect(called).toBe(false);
    expect(receipt).toMatchObject({
      mode: "dry-run",
      configurationValid: true,
      awsTopologyVerified: false,
      preliminarySurfaceVerified: false,
      loadBalancerRouteVerified: false,
      stagingVerified: false,
    });
    expect(livePreflightPassed(receipt)).toBe(false);
    expect(receipt.checks.filter((item) => item.status === "planned")).toHaveLength(10);
  });

  it("verifies the expected private same-VPC topology and preliminary remote surface", async () => {
    const receipt = await verifyAwsStagingTarget(target, {
      live: true,
      runAws: awsRunner(),
      fetcher: fetcher([200, 200, 404]),
      resolveHostname: async () => ["192.0.2.10"],
      now: () => new Date("2026-09-15T01:02:03.000Z"),
    });

    expect(receipt).toMatchObject({
      mode: "live",
      awsTopologyVerified: true,
      loadBalancerRouteVerified: true,
      preDeploySnapshotVerified: true,
      preliminarySurfaceVerified: true,
      stagingVerified: false,
    });
    expect(livePreflightPassed(receipt)).toBe(true);
    expect(receipt.checks).toContainEqual({
      id: "latency-placement",
      status: "pass",
      detail: "The current EC2 instance and RDS writer are in the same Availability Zone.",
    });
  });

  it("fails topology verification when RDS accepts a public PostgreSQL source", async () => {
    const receipt = await verifyAwsStagingTarget(target, {
      live: true,
      runAws: awsRunner({ unsafeIngress: true }),
      fetcher: fetcher([200, 200, 404]),
      resolveHostname: async () => ["192.0.2.10"],
      now: () => new Date("2026-09-15T01:02:03.000Z"),
    });

    expect(receipt.awsTopologyVerified).toBe(false);
    expect(receipt.checks).toContainEqual({
      id: "database-ingress",
      status: "fail",
      detail:
        "RDS PostgreSQL ingress is absent, broader than port 5432, or permits a source other than the API security group.",
    });
  });

  it("fails topology verification when an additive EC2 security group is attached", async () => {
    const receipt = await verifyAwsStagingTarget(target, {
      live: true,
      runAws: awsRunner({ extraApiSecurityGroup: true }),
      fetcher: fetcher([200, 200, 404]),
      resolveHostname: async () => ["192.0.2.10"],
      now: () => new Date("2026-09-15T01:02:03.000Z"),
    });

    expect(receipt.awsTopologyVerified).toBe(false);
  });

  it("fails the live gate when the public origin does not resolve to the load balancer", async () => {
    const receipt = await verifyAwsStagingTarget(target, {
      live: true,
      runAws: awsRunner(),
      fetcher: fetcher([200, 200, 404]),
      resolveHostname: async (hostname) =>
        hostname === target.hostname ? ["198.51.100.7"] : ["192.0.2.10"],
      now: () => new Date("2026-09-15T01:02:03.000Z"),
    });

    expect(receipt.originBindingVerified).toBe(false);
    expect(livePreflightPassed(receipt)).toBe(false);
  });

  const tampering: readonly [string, string, Record<string, unknown>][] = [
    ["HTTP listener", "Listeners", { Protocol: "HTTP" }],
    ["wrong listener port", "Listeners", { Port: 8443 }],
    ["foreign load balancer", "Listeners", { LoadBalancerArn: "other" }],
    ["fixed response", "Listeners", { DefaultActions: [{ Type: "fixed-response" }] }],
    [
      "weighted targets",
      "Listeners",
      {
        DefaultActions: [
          {
            Type: "forward",
            ForwardConfig: {
              TargetGroups: [{ TargetGroupArn: targetArn }, { TargetGroupArn: "other" }],
            },
          },
        ],
      },
    ],
    [
      "inconsistent forward config",
      "Listeners",
      {
        DefaultActions: [
          {
            Type: "forward",
            TargetGroupArn: targetArn,
            ForwardConfig: { TargetGroups: [{ TargetGroupArn: "other" }] },
          },
        ],
      },
    ],
    [
      "zero weight",
      "Listeners",
      {
        DefaultActions: [
          {
            Type: "forward",
            ForwardConfig: { TargetGroups: [{ TargetGroupArn: targetArn, Weight: 0 }] },
          },
        ],
      },
    ],
    ["nondefault rule", "Rules", { IsDefault: false }],
    ["path condition", "Rules", { Conditions: [{ Field: "path-pattern" }] }],
    ["rewrite", "Rules", { Transforms: [{ Type: "url-rewrite" }] }],
    ["different rule target", "Rules", { Actions: [{ Type: "forward", TargetGroupArn: "other" }] }],
    ["wrong VPC", "TargetGroups", { VpcId: "other" }],
    ["IP target", "TargetGroups", { TargetType: "ip" }],
    ["wrong target port", "TargetGroups", { Port: 8080 }],
    ["other group binding", "TargetGroups", { LoadBalancerArns: ["other"] }],
    ["health disabled", "TargetGroups", { HealthCheckEnabled: false }],
    ["health bypass", "TargetGroups", { HealthCheckPath: "/health" }],
    ["permissive matcher", "TargetGroups", { Matcher: { HttpCode: "200-499" } }],
    [
      "different instance",
      "TargetHealthDescriptions",
      { Target: { Id: "i-00000000000000000", Port: 3000 } },
    ],
    [
      "overridden target port",
      "TargetHealthDescriptions",
      { Target: { Id: target.apiInstanceId, Port: 8080 } },
    ],
    ["unhealthy target", "TargetHealthDescriptions", { TargetHealth: { State: "unhealthy" } }],
  ];
  for (const [name, key, patch] of tampering) {
    it(`rejects ${name}`, async () => {
      const base = awsRunner();
      const receipt = await verifyAwsStagingTarget(target, {
        live: true,
        runAws: async (args) => {
          const response = await base(args);
          if (typeof response === "object" && response !== null && key in response)
            return { [key]: [{ ...routeFixtures()[key]?.[0], ...patch }] };
          return response;
        },
        fetcher: fetcher([200, 200, 404]),
        resolveHostname: async () => ["192.0.2.10"],
        now: () => new Date("2026-09-15T01:02:03.000Z"),
      });
      expect(receipt.loadBalancerRouteVerified).toBe(false);
      expect(livePreflightPassed(receipt)).toBe(false);
    });
  }
  for (const key of ["Listeners", "Rules", "TargetGroups", "TargetHealthDescriptions"]) {
    for (const extra of [null, {}]) {
      it(`rejects extra ${key} entries including malformed records`, async () => {
        const base = awsRunner();
        const receipt = await verifyAwsStagingTarget(target, {
          live: true,
          runAws: async (args) => {
            const response = await base(args);
            return typeof response === "object" && response !== null && key in response
              ? { [key]: [...(routeFixtures()[key] ?? []), extra] }
              : response;
          },
          fetcher: fetcher([200, 200, 404]),
          resolveHostname: async () => ["192.0.2.10"],
          now: () => new Date("2026-09-15T01:02:03.000Z"),
        });
        expect(livePreflightPassed(receipt)).toBe(false);
      });
    }
  }
  for (const release of [
    null,
    {},
    { releaseCommit: "c".repeat(40), artifactDigest: target.artifactDigest },
    { releaseCommit: target.releaseCommit, artifactDigest: `sha256:${"c".repeat(64)}` },
    {
      releaseCommit: target.releaseCommit,
      artifactDigest: target.artifactDigest,
      secret: "must-not-emit",
    },
  ]) {
    it("fails closed for malformed or mismatched running release", async () => {
      const receipt = await verifyAwsStagingTarget(target, {
        live: true,
        runAws: awsRunner(),
        fetcher: fetcher([200, 200, 404], release),
        resolveHostname: async () => ["192.0.2.10"],
        now: () => new Date("2026-09-15T01:02:03.000Z"),
      });
      expect(livePreflightPassed(receipt)).toBe(false);
      expect(JSON.stringify(receipt)).not.toContain("must-not-emit");
    });
  }
});
