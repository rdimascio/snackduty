import { execFileSync } from "node:child_process";

export function assertExpectedAccount(expected: string, identity: unknown): void {
  if (
    typeof identity !== "object" ||
    identity === null ||
    !("Account" in identity) ||
    identity.Account !== expected
  ) {
    throw new Error("AWS_ACCOUNT_MISMATCH: refusing access to deployment state or resources");
  }
}

type Environment = Record<string, string | undefined>;
type AwsCommand = (args: string[], environment: Environment) => string;

const runAws: AwsCommand = (args, environment) =>
  execFileSync("aws", args, {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });

/** Freeze one CLI-resolved identity for STS, S3, and Cloud Control. Never print it. */
export function verifyAwsAccount(
  expected: string,
  region: string,
  environment: Environment = process.env,
  run: AwsCommand = runAws,
): void {
  let deployment: Environment;
  try {
    const credentials: unknown = JSON.parse(
      run(["configure", "export-credentials", "--format", "process"], environment),
    );
    if (
      typeof credentials !== "object" ||
      credentials === null ||
      !("AccessKeyId" in credentials) ||
      typeof credentials.AccessKeyId !== "string" ||
      !credentials.AccessKeyId ||
      !("SecretAccessKey" in credentials) ||
      typeof credentials.SecretAccessKey !== "string" ||
      !credentials.SecretAccessKey ||
      ("SessionToken" in credentials && typeof credentials.SessionToken !== "string")
    ) {
      throw new Error("invalid credentials");
    }
    deployment = {
      ...environment,
      AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
      AWS_REGION: region,
      AWS_DEFAULT_REGION: region,
      AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
    };
    delete deployment["AWS_PROFILE"];
    delete deployment["AWS_DEFAULT_PROFILE"];
    delete deployment["AWS_SESSION_TOKEN"];
    delete deployment["AWS_SECURITY_TOKEN"];
    if ("SessionToken" in credentials && typeof credentials.SessionToken === "string")
      deployment["AWS_SESSION_TOKEN"] = credentials.SessionToken;
  } catch {
    throw new Error("AWS_IDENTITY_UNAVAILABLE: unable to resolve deployment credentials");
  }
  let identity: unknown;
  try {
    identity = JSON.parse(
      run(
        ["sts", "get-caller-identity", "--region", region, "--output", "json", "--no-cli-pager"],
        deployment,
      ),
    );
  } catch {
    throw new Error("AWS_IDENTITY_UNAVAILABLE: unable to verify expected deployment account");
  }
  assertExpectedAccount(expected, identity);
  // Publish only after STS succeeds; provider calls resolve this same fixed identity.
  for (const name of [
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
  ])
    delete environment[name];
  Object.assign(environment, deployment);
}
