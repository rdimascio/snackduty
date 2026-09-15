export interface AwsStagingConfig {
  readonly stage: string;
  readonly region: string;
  readonly primaryAvailabilityZone: string;
  readonly secondaryAvailabilityZone: string;
  readonly hostname: string;
  readonly hostedZoneId: string;
  readonly certificateArn: string;
  readonly apiAmiId: string;
  readonly apiArtifactDigest: string;
  readonly apiInstanceType: string;
  readonly appleClientId: string;
  readonly runtimeSecretArn: string;
  readonly databaseEngineVersion: string;
  readonly databaseInstanceClass: string;
  readonly stateBucket: string;
  readonly postgresRuntimeVerified: boolean;
}

export interface LoadAwsStagingConfigOptions {
  readonly requirePostgresRuntime?: boolean;
}

type Environment = Readonly<Record<string, string | undefined>>;

const patterns = {
  stage: /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/,
  region: /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/,
  hostname: /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  hostedZoneId: /^Z[A-Z0-9]{4,31}$/,
  amiId: /^ami-[0-9a-f]{8,17}$/,
  digest: /^sha256:[0-9a-f]{64}$/,
  instanceType: /^[a-z0-9][a-z0-9.]{1,31}$/,
  appleClientId: /^[A-Za-z0-9](?:[A-Za-z0-9.-]{1,253}[A-Za-z0-9])$/,
  databaseEngineVersion: /^\d+(?:\.\d+){0,2}$/,
  databaseInstanceClass: /^db\.[a-z0-9][a-z0-9.]{1,31}$/,
  stateBucket: /^(?=.{3,63}$)(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/,
} as const;

export function loadAwsStagingConfig(
  environment: Environment,
  options: LoadAwsStagingConfigOptions = {},
): AwsStagingConfig {
  const stage = required(environment, "SNACKDAY_DEPLOY_STAGE", patterns.stage);
  if (stage !== "staging") {
    throw new Error("SNACKDAY_DEPLOY_STAGE must be staging for this stack");
  }
  const region = required(environment, "SNACKDAY_AWS_REGION", patterns.region);
  const primaryAvailabilityZone = availabilityZone(environment, "SNACKDAY_AWS_PRIMARY_AZ", region);
  const secondaryAvailabilityZone = availabilityZone(
    environment,
    "SNACKDAY_AWS_SECONDARY_AZ",
    region,
  );

  if (primaryAvailabilityZone === secondaryAvailabilityZone) {
    throw new Error("SNACKDAY_AWS_PRIMARY_AZ and SNACKDAY_AWS_SECONDARY_AZ must differ");
  }

  const postgresRuntimeVerified = environment["SNACKDAY_POSTGRES_RUNTIME_VERIFIED"] === "1";
  if (options.requirePostgresRuntime === true && !postgresRuntimeVerified) {
    throw new Error(
      "refusing AWS deployment: set SNACKDAY_POSTGRES_RUNTIME_VERIFIED=1 only after the real Lesto runtime and migrations pass against PostgreSQL",
    );
  }

  return {
    stage,
    region,
    primaryAvailabilityZone,
    secondaryAvailabilityZone,
    hostname: required(environment, "SNACKDAY_STAGING_HOSTNAME", patterns.hostname),
    hostedZoneId: required(environment, "SNACKDAY_ROUTE53_HOSTED_ZONE_ID", patterns.hostedZoneId),
    certificateArn: certificateArn(environment, region),
    apiAmiId: required(environment, "SNACKDAY_API_AMI_ID", patterns.amiId),
    apiArtifactDigest: required(environment, "SNACKDAY_API_ARTIFACT_DIGEST", patterns.digest),
    apiInstanceType: optional(
      environment,
      "SNACKDAY_API_INSTANCE_TYPE",
      "t3.small",
      patterns.instanceType,
    ),
    appleClientId: required(environment, "SNACKDAY_APPLE_CLIENT_ID", patterns.appleClientId),
    runtimeSecretArn: secretArn(environment, region),
    databaseEngineVersion: required(
      environment,
      "SNACKDAY_POSTGRES_ENGINE_VERSION",
      patterns.databaseEngineVersion,
    ),
    databaseInstanceClass: optional(
      environment,
      "SNACKDAY_RDS_INSTANCE_CLASS",
      "db.t4g.micro",
      patterns.databaseInstanceClass,
    ),
    stateBucket: required(environment, "ALCHEMY_STATE_BUCKET", patterns.stateBucket),
    postgresRuntimeVerified,
  };
}

function required(environment: Environment, name: string, pattern: RegExp): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  if (!pattern.test(value)) {
    throw new Error(`${name} has an invalid value`);
  }
  return value;
}

function optional(
  environment: Environment,
  name: string,
  fallback: string,
  pattern: RegExp,
): string {
  const value = environment[name]?.trim() || fallback;
  if (!pattern.test(value)) {
    throw new Error(`${name} has an invalid value`);
  }
  return value;
}

function availabilityZone(environment: Environment, name: string, region: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || !new RegExp(`^${escapeRegExp(region)}[a-z]$`).test(value)) {
    throw new Error(`${name} must name an availability zone in ${region}`);
  }
  return value;
}

function certificateArn(environment: Environment, region: string): string {
  const value = environment["SNACKDAY_ACM_CERTIFICATE_ARN"]?.trim();
  const pattern = new RegExp(
    `^arn:aws(?:-us-gov)?:acm:${escapeRegExp(region)}:\\d{12}:certificate/[0-9a-f-]{36}$`,
  );
  if (value === undefined || !pattern.test(value)) {
    throw new Error(`SNACKDAY_ACM_CERTIFICATE_ARN must name an ACM certificate in ${region}`);
  }
  return value;
}

function secretArn(environment: Environment, region: string): string {
  const value = environment["SNACKDAY_RUNTIME_SECRET_ARN"]?.trim();
  const pattern = new RegExp(
    `^arn:aws(?:-us-gov)?:secretsmanager:${escapeRegExp(region)}:\\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$`,
  );
  if (value === undefined || !pattern.test(value)) {
    throw new Error(`SNACKDAY_RUNTIME_SECRET_ARN must name a Secrets Manager secret in ${region}`);
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
