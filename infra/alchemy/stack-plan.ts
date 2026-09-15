import type { AwsStagingConfig } from "./config";

export interface AwsStagingPlan {
  readonly schemaVersion: 1;
  readonly stage: string;
  readonly region: string;
  readonly hostname: string;
  readonly publicBaseUrl: string;
  readonly postgresRuntimeVerified: boolean;
  readonly network: {
    readonly vpcCidr: string;
    readonly publicSubnets: readonly SubnetPlan[];
    readonly databaseSubnets: readonly SubnetPlan[];
  };
  readonly api: {
    readonly availabilityZone: string;
    readonly subnetCidr: string;
    readonly instanceType: string;
    readonly amiId: string;
    readonly artifactDigest: string;
    readonly listenerPort: 443;
    readonly applicationPort: 3000;
    readonly ingress: readonly FirewallRule[];
  };
  readonly database: {
    readonly availabilityZone: string;
    readonly engine: "postgres";
    readonly engineVersion: string;
    readonly instanceClass: string;
    readonly port: 5432;
    readonly publiclyAccessible: false;
    readonly storageEncrypted: true;
    readonly backupRetentionDays: 7;
    readonly ingress: readonly FirewallRule[];
  };
}

interface SubnetPlan {
  readonly cidr: string;
  readonly availabilityZone: string;
  readonly public: boolean;
}

interface FirewallRule {
  readonly source: "internet" | "load-balancer" | "api";
  readonly protocol: "tcp";
  readonly port: number;
}

export const networkCidrs = {
  vpc: "10.42.0.0/16",
  publicA: "10.42.1.0/24",
  publicB: "10.42.2.0/24",
  databaseA: "10.42.11.0/24",
  databaseB: "10.42.12.0/24",
} as const;

export function buildAwsStagingPlan(config: AwsStagingConfig): AwsStagingPlan {
  return {
    schemaVersion: 1,
    stage: config.stage,
    region: config.region,
    hostname: config.hostname,
    publicBaseUrl: `https://${config.hostname}`,
    postgresRuntimeVerified: config.postgresRuntimeVerified,
    network: {
      vpcCidr: networkCidrs.vpc,
      publicSubnets: [
        {
          cidr: networkCidrs.publicA,
          availabilityZone: config.primaryAvailabilityZone,
          public: true,
        },
        {
          cidr: networkCidrs.publicB,
          availabilityZone: config.secondaryAvailabilityZone,
          public: true,
        },
      ],
      databaseSubnets: [
        {
          cidr: networkCidrs.databaseA,
          availabilityZone: config.primaryAvailabilityZone,
          public: false,
        },
        {
          cidr: networkCidrs.databaseB,
          availabilityZone: config.secondaryAvailabilityZone,
          public: false,
        },
      ],
    },
    api: {
      availabilityZone: config.primaryAvailabilityZone,
      subnetCidr: networkCidrs.publicA,
      instanceType: config.apiInstanceType,
      amiId: config.apiAmiId,
      artifactDigest: config.apiArtifactDigest,
      listenerPort: 443,
      applicationPort: 3000,
      ingress: [{ source: "load-balancer", protocol: "tcp", port: 3000 }],
    },
    database: {
      availabilityZone: config.primaryAvailabilityZone,
      engine: "postgres",
      engineVersion: config.databaseEngineVersion,
      instanceClass: config.databaseInstanceClass,
      port: 5432,
      publiclyAccessible: false,
      storageEncrypted: true,
      backupRetentionDays: 7,
      ingress: [{ source: "api", protocol: "tcp", port: 5432 }],
    },
  };
}
