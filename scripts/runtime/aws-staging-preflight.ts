import { readFile } from "node:fs/promises";
import { resolve4 } from "node:dns/promises";

import { probeRemoteRuntime } from "./probe-remote";

const AWS_COMMAND_TIMEOUT_MS = 20_000;
const AWS_ID = "[0-9a-f]{8,17}";
const TARGET_FIELDS = new Set([
  "schema",
  "stage",
  "awsAccountId",
  "region",
  "hostname",
  "publicBaseUrl",
  "vpcId",
  "apiInstanceId",
  "apiSubnetId",
  "apiSecurityGroupId",
  "apiPort",
  "loadBalancerArn",
  "loadBalancerDnsName",
  "loadBalancerSecurityGroupId",
  "databaseInstanceId",
  "databaseSubnetGroupName",
  "databaseSecurityGroupId",
  "databasePort",
  "minimumBackupRetentionDays",
  "preDeploySnapshotId",
  "releaseCommit",
  "artifactDigest",
  "previousArtifactDigest",
]);

export interface AwsStagingTarget {
  readonly schema: "snackday/aws-staging-target/v1";
  readonly stage: "staging";
  readonly awsAccountId: string;
  readonly region: string;
  readonly hostname: string;
  readonly publicBaseUrl: string;
  readonly vpcId: string;
  readonly apiInstanceId: string;
  readonly apiSubnetId: string;
  readonly apiSecurityGroupId: string;
  readonly apiPort: 3000;
  readonly loadBalancerArn: string;
  readonly loadBalancerDnsName: string;
  readonly loadBalancerSecurityGroupId: string;
  readonly databaseInstanceId: string;
  readonly databaseSubnetGroupName: string;
  readonly databaseSecurityGroupId: string;
  readonly databasePort: 5432;
  readonly minimumBackupRetentionDays: number;
  readonly preDeploySnapshotId: string;
  readonly releaseCommit: string;
  readonly artifactDigest: string;
  readonly previousArtifactDigest: string | null;
}

export interface VerificationCheck {
  readonly id: string;
  readonly status: "pass" | "fail" | "planned" | "note";
  readonly detail: string;
}

export interface AwsStagingPreflightReceipt {
  readonly schema: "snackday/aws-staging-preflight-receipt/v1";
  readonly mode: "dry-run" | "live";
  readonly checkedAt: string;
  readonly awsAccountId: string;
  readonly region: string;
  readonly origin: string;
  readonly releaseCommit: string;
  readonly artifactDigest: string;
  readonly checks: readonly VerificationCheck[];
  readonly configurationValid: true;
  readonly awsTopologyVerified: boolean;
  readonly originBindingVerified: boolean;
  readonly preDeploySnapshotVerified: boolean;
  readonly preliminarySurfaceVerified: boolean;
  readonly loadBalancerRouteVerified: boolean;
  readonly stagingVerified: false;
}

export type AwsCommandRunner = (args: readonly string[]) => Promise<unknown>;
export type HostnameResolver = (hostname: string) => Promise<readonly string[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, key: string, errors: string[]): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim() === "") {
    errors.push(`${key} must be a non-empty string`);
    return "";
  }
  return candidate;
}

function matches(value: string, pattern: RegExp, fieldName: string, errors: string[]): void {
  if (!pattern.test(value)) errors.push(`${fieldName} has an invalid format`);
}

function httpsOrigin(value: string, errors: string[]): URL | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      errors.push("publicBaseUrl must be a credential-free HTTPS origin");
      return undefined;
    }
    return url;
  } catch {
    errors.push("publicBaseUrl must be a valid URL");
    return undefined;
  }
}

export function parseAwsStagingTarget(input: unknown): AwsStagingTarget {
  if (!isRecord(input)) throw new Error("AWS staging target must be a JSON object.");

  const errors: string[] = [];
  for (const key of Object.keys(input)) {
    if (!TARGET_FIELDS.has(key)) errors.push(`${key} is not an allowed target field`);
  }
  const schema = requiredString(input, "schema", errors);
  const stage = requiredString(input, "stage", errors);
  const awsAccountId = requiredString(input, "awsAccountId", errors);
  const region = requiredString(input, "region", errors);
  const hostname = requiredString(input, "hostname", errors);
  const publicBaseUrl = requiredString(input, "publicBaseUrl", errors);
  const vpcId = requiredString(input, "vpcId", errors);
  const apiInstanceId = requiredString(input, "apiInstanceId", errors);
  const apiSubnetId = requiredString(input, "apiSubnetId", errors);
  const apiSecurityGroupId = requiredString(input, "apiSecurityGroupId", errors);
  const loadBalancerArn = requiredString(input, "loadBalancerArn", errors);
  const loadBalancerDnsName = requiredString(input, "loadBalancerDnsName", errors);
  const loadBalancerSecurityGroupId = requiredString(input, "loadBalancerSecurityGroupId", errors);
  const databaseInstanceId = requiredString(input, "databaseInstanceId", errors);
  const databaseSubnetGroupName = requiredString(input, "databaseSubnetGroupName", errors);
  const databaseSecurityGroupId = requiredString(input, "databaseSecurityGroupId", errors);
  const preDeploySnapshotId = requiredString(input, "preDeploySnapshotId", errors);
  const releaseCommit = requiredString(input, "releaseCommit", errors);
  const artifactDigest = requiredString(input, "artifactDigest", errors);
  const previousArtifactDigestInput = input["previousArtifactDigest"];
  let previousArtifactDigest: string | null = null;
  const databasePort = input["databasePort"];
  const apiPort = input["apiPort"];
  const minimumBackupRetentionDays = input["minimumBackupRetentionDays"];

  if (schema !== "snackday/aws-staging-target/v1") {
    errors.push("schema must be snackday/aws-staging-target/v1");
  }
  if (stage !== "staging") errors.push("stage must be staging");
  matches(awsAccountId, /^\d{12}$/u, "awsAccountId", errors);
  matches(region, /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u, "region", errors);
  matches(vpcId, new RegExp(`^vpc-${AWS_ID}$`), "vpcId", errors);
  matches(apiInstanceId, new RegExp(`^i-${AWS_ID}$`), "apiInstanceId", errors);
  matches(apiSubnetId, new RegExp(`^subnet-${AWS_ID}$`), "apiSubnetId", errors);
  matches(apiSecurityGroupId, new RegExp(`^sg-${AWS_ID}$`), "apiSecurityGroupId", errors);
  matches(
    loadBalancerSecurityGroupId,
    new RegExp(`^sg-${AWS_ID}$`),
    "loadBalancerSecurityGroupId",
    errors,
  );
  matches(databaseSecurityGroupId, new RegExp(`^sg-${AWS_ID}$`), "databaseSecurityGroupId", errors);
  matches(databaseInstanceId, /^[a-z][a-z0-9-]{0,62}$/u, "databaseInstanceId", errors);
  matches(
    databaseSubnetGroupName,
    /^[a-z0-9][a-z0-9._-]{0,254}$/u,
    "databaseSubnetGroupName",
    errors,
  );
  matches(preDeploySnapshotId, /^[a-z][a-z0-9-]{0,254}$/u, "preDeploySnapshotId", errors);
  matches(releaseCommit, /^[0-9a-f]{40}$/u, "releaseCommit", errors);
  matches(artifactDigest, /^sha256:[0-9a-f]{64}$/u, "artifactDigest", errors);
  if (apiPort !== 3000) errors.push("apiPort must be 3000");
  const expectedLoadBalancerArnPrefix = `arn:aws:elasticloadbalancing:${region}:${awsAccountId}:loadbalancer/app/`;
  if (!loadBalancerArn.startsWith(expectedLoadBalancerArnPrefix)) {
    errors.push(
      "loadBalancerArn must identify an application load balancer in the target account and region",
    );
  }
  if (!/^[a-z0-9.-]+\.elb\.amazonaws\.com$/u.test(loadBalancerDnsName)) {
    errors.push("loadBalancerDnsName must be an AWS load balancer hostname");
  }
  if (previousArtifactDigestInput !== null) {
    if (typeof previousArtifactDigestInput !== "string") {
      errors.push("previousArtifactDigest must be a SHA-256 digest or null for the first release");
    } else {
      matches(
        previousArtifactDigestInput,
        /^sha256:[0-9a-f]{64}$/u,
        "previousArtifactDigest",
        errors,
      );
      previousArtifactDigest = previousArtifactDigestInput;
    }
  }
  if (previousArtifactDigest === artifactDigest) {
    errors.push("previousArtifactDigest must differ from artifactDigest");
  }
  for (const [fieldName, value] of [
    ["databaseInstanceId", databaseInstanceId],
    ["preDeploySnapshotId", preDeploySnapshotId],
  ] as const) {
    if (value.endsWith("-") || value.includes("--")) {
      errors.push(`${fieldName} cannot end in a hyphen or contain consecutive hyphens`);
    }
  }
  if (databasePort !== 5432) errors.push("databasePort must be 5432");
  if (
    typeof minimumBackupRetentionDays !== "number" ||
    !Number.isInteger(minimumBackupRetentionDays) ||
    minimumBackupRetentionDays < 7 ||
    minimumBackupRetentionDays > 35
  ) {
    errors.push("minimumBackupRetentionDays must be an integer from 7 through 35");
  }

  const origin = httpsOrigin(publicBaseUrl, errors);
  if (origin !== undefined && origin.hostname !== hostname) {
    errors.push("hostname must match publicBaseUrl");
  }

  if (errors.length > 0) {
    throw new Error(`Invalid AWS staging target:\n- ${errors.join("\n- ")}`);
  }

  return {
    schema: "snackday/aws-staging-target/v1",
    stage: "staging",
    awsAccountId,
    region,
    hostname,
    publicBaseUrl,
    vpcId,
    apiInstanceId,
    apiSubnetId,
    apiSecurityGroupId,
    apiPort: 3000,
    loadBalancerArn,
    loadBalancerDnsName,
    loadBalancerSecurityGroupId,
    databaseInstanceId,
    databaseSubnetGroupName,
    databaseSecurityGroupId,
    databasePort: 5432,
    minimumBackupRetentionDays: minimumBackupRetentionDays as number,
    preDeploySnapshotId,
    releaseCommit,
    artifactDigest,
    previousArtifactDigest,
  };
}

async function runAwsCommand(args: readonly string[]): Promise<unknown> {
  const child = Bun.spawn(["aws", ...args, "--output", "json", "--no-cli-pager"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), AWS_COMMAND_TIMEOUT_MS);
  const [exitCode, output, errorOutput] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timeout);

  if (exitCode !== 0) {
    const operation = args.slice(0, 2).join(" ");
    const category = classifyAwsFailure(errorOutput);
    throw new Error(
      `AWS CLI ${operation} failed with exit code ${exitCode} (${category}); details withheld.`,
    );
  }

  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new Error("AWS CLI returned invalid JSON; output withheld.");
  }
}

export function classifyAwsFailure(errorOutput: string): string {
  if (/ExpiredToken|token has expired|SSO session.*expired/iu.test(errorOutput)) {
    return "credentials expired";
  }
  if (/AccessDenied|UnauthorizedOperation/iu.test(errorOutput)) return "access denied";
  if (/Invalid.*NotFound|not found/iu.test(errorOutput)) return "resource not found";
  return "unclassified AWS error";
}

function records(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function field(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function objectField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function check(
  checks: VerificationCheck[],
  id: string,
  passed: boolean,
  passingDetail: string,
  failingDetail: string,
): void {
  checks.push({
    id,
    status: passed ? "pass" : "fail",
    detail: passed ? passingDetail : failingDetail,
  });
}

function tcpIngressIsRestricted(
  securityGroup: Record<string, unknown>,
  port: number,
  sourceSecurityGroupId: string,
): boolean {
  const ingressRules = records(securityGroup["IpPermissions"]);
  if (ingressRules.length !== 1) return false;
  const rule = ingressRules[0];
  if (rule === undefined) return false;
  if (
    field(rule, "IpProtocol") !== "tcp" ||
    numberField(rule, "FromPort") !== port ||
    numberField(rule, "ToPort") !== port ||
    records(rule["IpRanges"]).length > 0 ||
    records(rule["Ipv6Ranges"]).length > 0 ||
    records(rule["PrefixListIds"]).length > 0
  ) {
    return false;
  }

  const sourceGroups = records(rule["UserIdGroupPairs"]).map((pair) => field(pair, "GroupId"));
  return sourceGroups.length === 1 && sourceGroups[0] === sourceSecurityGroupId;
}

export async function verifyAwsStagingTarget(
  target: AwsStagingTarget,
  options: {
    readonly live: boolean;
    readonly runAws?: AwsCommandRunner;
    readonly fetcher?: typeof fetch;
    readonly resolveHostname?: HostnameResolver;
    readonly now?: () => Date;
  },
): Promise<AwsStagingPreflightReceipt> {
  const now = options.now ?? (() => new Date());
  const checkedAt = now();
  const checks: VerificationCheck[] = [
    {
      id: "configuration",
      status: "pass",
      detail: "Non-secret target identifiers and release coordinates are valid.",
    },
  ];

  if (!options.live) {
    for (const [id, detail] of [
      ["api-topology", "Would verify the running EC2 instance, VPC, subnet, and security group."],
      ["load-balancer", "Would verify the active internet-facing load balancer in the same VPC."],
      ["api-ingress", "Would verify the API port accepts traffic only from the load balancer."],
      ["database-topology", "Would verify private encrypted PostgreSQL RDS in the same VPC."],
      [
        "database-ingress",
        "Would verify PostgreSQL ingress comes only from the API security group.",
      ],
      [
        "predeploy-snapshot",
        "Would verify an available encrypted snapshot of the target database.",
      ],
      ["remote-surface", "Would probe health, readiness, and absence of development sign-in."],
      ["origin-binding", "Would compare the staging hostname and load-balancer DNS answers."],
    ] as const) {
      checks.push({ id, status: "planned", detail });
    }
    checks.push({
      id: "authenticated-acceptance",
      status: "note",
      detail:
        "Real identity, tenancy, invitation, persistence, and rollback journeys remain required.",
    });
    return {
      schema: "snackday/aws-staging-preflight-receipt/v1",
      mode: "dry-run",
      checkedAt: checkedAt.toISOString(),
      awsAccountId: target.awsAccountId,
      region: target.region,
      origin: target.publicBaseUrl,
      releaseCommit: target.releaseCommit,
      artifactDigest: target.artifactDigest,
      checks,
      configurationValid: true,
      awsTopologyVerified: false,
      originBindingVerified: false,
      preDeploySnapshotVerified: false,
      preliminarySurfaceVerified: false,
      loadBalancerRouteVerified: false,
      stagingVerified: false,
    };
  }

  const runAws = options.runAws ?? runAwsCommand;
  const aws = (args: readonly string[]) => runAws([...args, "--region", target.region]);
  const resolveHostname = options.resolveHostname ?? resolve4;
  const [
    identityResponse,
    instanceResponse,
    databaseResponse,
    securityGroupsResponse,
    loadBalancerResponse,
    snapshotResponse,
    originAddresses,
    loadBalancerAddresses,
  ] = await Promise.all([
    aws(["sts", "get-caller-identity"]),
    aws(["ec2", "describe-instances", "--instance-ids", target.apiInstanceId]),
    aws(["rds", "describe-db-instances", "--db-instance-identifier", target.databaseInstanceId]),
    aws([
      "ec2",
      "describe-security-groups",
      "--group-ids",
      target.apiSecurityGroupId,
      target.databaseSecurityGroupId,
    ]),
    aws(["elbv2", "describe-load-balancers", "--load-balancer-arns", target.loadBalancerArn]),
    aws(["rds", "describe-db-snapshots", "--db-snapshot-identifier", target.preDeploySnapshotId]),
    resolveHostname(target.hostname),
    resolveHostname(target.loadBalancerDnsName),
  ]);

  const identity = isRecord(identityResponse) ? identityResponse : {};
  const accountVerified = field(identity, "Account") === target.awsAccountId;
  check(
    checks,
    "aws-account",
    accountVerified,
    "The active AWS identity belongs to the expected account.",
    "The active AWS identity does not belong to the expected account.",
  );

  const instanceRoot = isRecord(instanceResponse) ? instanceResponse : {};
  const reservation = records(instanceRoot["Reservations"])[0] ?? {};
  const instance = records(reservation["Instances"])[0] ?? {};
  const instanceState = objectField(instance, "State") ?? {};
  const attachedApiSecurityGroups = records(instance["SecurityGroups"]).map((group) =>
    field(group, "GroupId"),
  );
  const apiTopologyVerified =
    field(instance, "InstanceId") === target.apiInstanceId &&
    field(instance, "VpcId") === target.vpcId &&
    field(instance, "SubnetId") === target.apiSubnetId &&
    field(instanceState, "Name") === "running" &&
    attachedApiSecurityGroups.length === 1 &&
    attachedApiSecurityGroups[0] === target.apiSecurityGroupId;
  check(
    checks,
    "api-topology",
    apiTopologyVerified,
    "The API EC2 instance is running in the expected VPC/subnet with the expected security group.",
    "The API EC2 instance does not match the expected running VPC/subnet/security-group topology.",
  );

  const loadBalancerRoot = isRecord(loadBalancerResponse) ? loadBalancerResponse : {};
  const loadBalancer = records(loadBalancerRoot["LoadBalancers"])[0] ?? {};
  const loadBalancerState = objectField(loadBalancer, "State") ?? {};
  const loadBalancerTopologyVerified =
    field(loadBalancer, "LoadBalancerArn") === target.loadBalancerArn &&
    field(loadBalancer, "DNSName") === target.loadBalancerDnsName &&
    field(loadBalancer, "VpcId") === target.vpcId &&
    field(loadBalancer, "Scheme") === "internet-facing" &&
    field(loadBalancerState, "Code") === "active" &&
    Array.isArray(loadBalancer["SecurityGroups"]) &&
    loadBalancer["SecurityGroups"].length === 1 &&
    loadBalancer["SecurityGroups"][0] === target.loadBalancerSecurityGroupId;
  check(
    checks,
    "load-balancer",
    loadBalancerTopologyVerified,
    "The expected internet-facing load balancer is active in the application VPC.",
    "The load balancer identity, DNS name, VPC, scheme, state, or security group does not match.",
  );

  const databaseRoot = isRecord(databaseResponse) ? databaseResponse : {};
  const database = records(databaseRoot["DBInstances"])[0] ?? {};
  const endpoint = objectField(database, "Endpoint") ?? {};
  const subnetGroup = objectField(database, "DBSubnetGroup") ?? {};
  const attachedDatabaseSecurityGroups = records(database["VpcSecurityGroups"]).map((group) =>
    field(group, "VpcSecurityGroupId"),
  );
  const databaseTopologyVerified =
    field(database, "DBInstanceIdentifier") === target.databaseInstanceId &&
    field(database, "DBInstanceStatus") === "available" &&
    field(database, "Engine") === "postgres" &&
    database["PubliclyAccessible"] === false &&
    database["StorageEncrypted"] === true &&
    field(subnetGroup, "VpcId") === target.vpcId &&
    field(subnetGroup, "DBSubnetGroupName") === target.databaseSubnetGroupName &&
    numberField(endpoint, "Port") === target.databasePort &&
    attachedDatabaseSecurityGroups.length === 1 &&
    attachedDatabaseSecurityGroups[0] === target.databaseSecurityGroupId &&
    (numberField(database, "BackupRetentionPeriod") ?? -1) >= target.minimumBackupRetentionDays;
  check(
    checks,
    "database-topology",
    databaseTopologyVerified,
    "RDS PostgreSQL is available, private, encrypted, retained, and attached to the expected VPC.",
    "RDS does not match the expected PostgreSQL, private, encrypted, retained VPC topology.",
  );

  const securityGroupsRoot = isRecord(securityGroupsResponse) ? securityGroupsResponse : {};
  const securityGroups = records(securityGroupsRoot["SecurityGroups"]);
  const databaseSecurityGroup =
    securityGroups.find(
      (securityGroup) => field(securityGroup, "GroupId") === target.databaseSecurityGroupId,
    ) ?? {};
  const apiSecurityGroup =
    securityGroups.find(
      (securityGroup) => field(securityGroup, "GroupId") === target.apiSecurityGroupId,
    ) ?? {};
  const databaseIngressVerified = tcpIngressIsRestricted(
    databaseSecurityGroup,
    target.databasePort,
    target.apiSecurityGroupId,
  );
  check(
    checks,
    "database-ingress",
    databaseIngressVerified,
    "RDS accepts PostgreSQL only from the API security group.",
    "RDS PostgreSQL ingress is absent, broader than port 5432, or permits a source other than the API security group.",
  );

  const apiIngressVerified = tcpIngressIsRestricted(
    apiSecurityGroup,
    target.apiPort,
    target.loadBalancerSecurityGroupId,
  );
  check(
    checks,
    "api-ingress",
    apiIngressVerified,
    "The API port accepts traffic only from the load balancer security group.",
    "The API port is absent, broader than configured, or permits a source other than the load balancer security group.",
  );

  const snapshotRoot = isRecord(snapshotResponse) ? snapshotResponse : {};
  const snapshot = records(snapshotRoot["DBSnapshots"])[0] ?? {};
  const snapshotVerified =
    field(snapshot, "Status") === "available" &&
    field(snapshot, "SnapshotType") === "manual" &&
    field(snapshot, "DBInstanceIdentifier") === target.databaseInstanceId &&
    snapshot["Encrypted"] === true &&
    (() => {
      const created = field(snapshot, "SnapshotCreateTime");
      if (created === undefined) return false;
      const ageMs = checkedAt.getTime() - new Date(created).getTime();
      return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 24 * 60 * 60 * 1_000;
    })();
  check(
    checks,
    "predeploy-snapshot",
    snapshotVerified,
    "The named manual pre-deploy snapshot is available, encrypted, belongs to the target database, and is at most 24 hours old.",
    "The named snapshot is unavailable, non-manual, unencrypted, stale, future-dated, or belongs to another database.",
  );

  const apiAvailabilityZone = objectField(instance, "Placement");
  const apiAvailabilityZoneName = field(apiAvailabilityZone ?? {}, "AvailabilityZone");
  const databaseAvailabilityZoneName = field(database, "AvailabilityZone");
  const sameAvailabilityZone =
    apiAvailabilityZoneName !== undefined &&
    databaseAvailabilityZoneName !== undefined &&
    apiAvailabilityZoneName === databaseAvailabilityZoneName;
  checks.push({
    id: "latency-placement",
    status: sameAvailabilityZone ? "pass" : "note",
    detail: sameAvailabilityZone
      ? "The current EC2 instance and RDS writer are in the same Availability Zone."
      : "The API and current RDS writer are in different Availability Zones; the VPC boundary is correct, but cross-AZ latency applies.",
  });

  const originBindingVerified = originAddresses.some((address) =>
    loadBalancerAddresses.includes(address),
  );
  check(
    checks,
    "origin-binding",
    originBindingVerified,
    "The staging hostname resolves to the verified load balancer.",
    "The staging hostname and verified load balancer have no shared IPv4 address.",
  );

  const remote = await probeRemoteRuntime(target.publicBaseUrl, options.fetcher, () => checkedAt);
  check(
    checks,
    "remote-surface",
    remote.preliminarySurfaceVerified,
    "Health and readiness pass, and development sign-in is absent.",
    "Health/readiness failed or the development sign-in route is exposed.",
  );
  checks.push({
    id: "authenticated-acceptance",
    status: "note",
    detail:
      "This preflight cannot prove real identity, tenancy, invitations, persistence, or rollback.",
  });

  const awsTopologyVerified =
    accountVerified &&
    apiTopologyVerified &&
    loadBalancerTopologyVerified &&
    apiIngressVerified &&
    databaseTopologyVerified &&
    databaseIngressVerified;
  // Listener/target health and artifact identity are intentionally fail-closed
  // until the deployment adapter supplies those AWS API responses.
  const loadBalancerRouteVerified = false;
  checks.push({
    id: "load-balancer-route",
    status: "planned",
    detail: "Listener, target-group health, and deployed artifact identity require an AWS adapter.",
  });
  return {
    schema: "snackday/aws-staging-preflight-receipt/v1",
    mode: "live",
    checkedAt: checkedAt.toISOString(),
    awsAccountId: target.awsAccountId,
    region: target.region,
    origin: target.publicBaseUrl,
    releaseCommit: target.releaseCommit,
    artifactDigest: target.artifactDigest,
    checks,
    configurationValid: true,
    awsTopologyVerified,
    originBindingVerified,
    preDeploySnapshotVerified: snapshotVerified,
    preliminarySurfaceVerified: remote.preliminarySurfaceVerified,
    loadBalancerRouteVerified,
    stagingVerified: false,
  };
}

export function livePreflightPassed(receipt: AwsStagingPreflightReceipt): boolean {
  return (
    receipt.awsTopologyVerified &&
    receipt.preDeploySnapshotVerified &&
    receipt.originBindingVerified &&
    receipt.loadBalancerRouteVerified &&
    receipt.preliminarySurfaceVerified
  );
}

async function main(args: readonly string[]): Promise<void> {
  const [path, flag] = args;
  if (path === undefined || (flag !== undefined && flag !== "--live") || args.length > 2) {
    throw new Error("Usage: bun scripts/runtime/aws-staging-preflight.ts <target.json> [--live]");
  }
  let input: unknown;
  try {
    input = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("AWS staging target must contain valid JSON; contents withheld.");
  }
  const target = parseAwsStagingTarget(input);
  const receipt = await verifyAwsStagingTarget(target, { live: flag === "--live" });
  console.log(JSON.stringify(receipt, null, 2));
  if (flag === "--live" && !livePreflightPassed(receipt)) {
    process.exitCode = 1;
  }
}

if (import.meta.main) await main(process.argv.slice(2));
