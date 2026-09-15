/**
 * Snackday's single-host AWS staging graph.
 *
 * This file targets the repository-verified Alchemy 0.93.12 API. It will not
 * create or update resources until the application has real PostgreSQL runtime
 * evidence and SNACKDAY_POSTGRES_RUNTIME_VERIFIED=1 is supplied.
 */

import alchemy from "alchemy";
import { S3StateStore } from "alchemy/aws";
import AWS from "alchemy/aws/control";

import { loadAwsStagingConfig } from "./config";
import { buildAwsStagingPlan, networkCidrs } from "./stack-plan";

const isReadOnly = process.argv.includes("--read");
const isDestroy = process.argv.includes("--destroy");
const config = loadAwsStagingConfig(process.env, {
  requirePostgresRuntime: !isReadOnly && !isDestroy,
});
const plan = buildAwsStagingPlan(config);

const app = await alchemy("snackday", {
  stage: config.stage,
  stateStore: (scope) =>
    new S3StateStore(scope, {
      bucketName: config.stateBucket,
      prefix: "snackday/",
      region: config.region,
    }),
});

const prefix = `snackday-${app.stage}`;
const resourceTags = tags({ Application: "snackday", Environment: app.stage });
const outputs = await alchemy.run(
  "aws",
  { parent: app, aws: { region: config.region } },
  async () => {
    const vpc = await AWS.EC2.VPC("Vpc", {
      CidrBlock: networkCidrs.vpc,
      EnableDnsSupport: true,
      EnableDnsHostnames: true,
      InstanceTenancy: "default",
      Tags: tags({ Application: "snackday", Environment: app.stage, Name: `${prefix}-vpc` }),
    });

    const internetGateway = await AWS.EC2.InternetGateway("InternetGateway", {
      Tags: tags({ Application: "snackday", Environment: app.stage, Name: `${prefix}-igw` }),
    });

    await AWS.EC2.VPCGatewayAttachment("InternetGatewayAttachment", {
      VpcId: vpc.VpcId,
      InternetGatewayId: internetGateway.InternetGatewayId,
    });

    const publicSubnetA = await AWS.EC2.Subnet("PublicSubnetA", {
      VpcId: vpc.VpcId,
      CidrBlock: networkCidrs.publicA,
      AvailabilityZone: config.primaryAvailabilityZone,
      MapPublicIpOnLaunch: true,
      Tags: tags({ Application: "snackday", Environment: app.stage, Name: `${prefix}-public-a` }),
    });

    const publicSubnetB = await AWS.EC2.Subnet("PublicSubnetB", {
      VpcId: vpc.VpcId,
      CidrBlock: networkCidrs.publicB,
      AvailabilityZone: config.secondaryAvailabilityZone,
      MapPublicIpOnLaunch: true,
      Tags: tags({ Application: "snackday", Environment: app.stage, Name: `${prefix}-public-b` }),
    });

    const databaseSubnetA = await AWS.EC2.Subnet("DatabaseSubnetA", {
      VpcId: vpc.VpcId,
      CidrBlock: networkCidrs.databaseA,
      AvailabilityZone: config.primaryAvailabilityZone,
      MapPublicIpOnLaunch: false,
      Tags: tags({ Application: "snackday", Environment: app.stage, Name: `${prefix}-database-a` }),
    });

    const databaseSubnetB = await AWS.EC2.Subnet("DatabaseSubnetB", {
      VpcId: vpc.VpcId,
      CidrBlock: networkCidrs.databaseB,
      AvailabilityZone: config.secondaryAvailabilityZone,
      MapPublicIpOnLaunch: false,
      Tags: tags({ Application: "snackday", Environment: app.stage, Name: `${prefix}-database-b` }),
    });

    const publicRouteTable = await AWS.EC2.RouteTable("PublicRouteTable", {
      VpcId: vpc.VpcId,
      Tags: tags({ Application: "snackday", Environment: app.stage, Name: `${prefix}-public` }),
    });

    await AWS.EC2.Route("PublicInternetRoute", {
      RouteTableId: publicRouteTable.RouteTableId,
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: internetGateway.InternetGatewayId,
    });

    await AWS.EC2.SubnetRouteTableAssociation("PublicSubnetAAssociation", {
      RouteTableId: publicRouteTable.RouteTableId,
      SubnetId: publicSubnetA.SubnetId,
    });
    await AWS.EC2.SubnetRouteTableAssociation("PublicSubnetBAssociation", {
      RouteTableId: publicRouteTable.RouteTableId,
      SubnetId: publicSubnetB.SubnetId,
    });

    const databaseRouteTable = await AWS.EC2.RouteTable("DatabaseRouteTable", {
      VpcId: vpc.VpcId,
      Tags: tags({ Application: "snackday", Environment: app.stage, Name: `${prefix}-database` }),
    });

    await AWS.EC2.SubnetRouteTableAssociation("DatabaseSubnetAAssociation", {
      RouteTableId: databaseRouteTable.RouteTableId,
      SubnetId: databaseSubnetA.SubnetId,
    });
    await AWS.EC2.SubnetRouteTableAssociation("DatabaseSubnetBAssociation", {
      RouteTableId: databaseRouteTable.RouteTableId,
      SubnetId: databaseSubnetB.SubnetId,
    });

    const loadBalancerSecurityGroup = await AWS.EC2.SecurityGroup("LoadBalancerSecurityGroup", {
      GroupDescription: "Public HTTPS ingress for Snackday staging",
      VpcId: vpc.VpcId,
      SecurityGroupIngress: [
        {
          IpProtocol: "tcp",
          FromPort: plan.api.listenerPort,
          ToPort: plan.api.listenerPort,
          CidrIp: "0.0.0.0/0",
          Description: "Public HTTPS",
        },
      ],
      SecurityGroupEgress: [
        {
          IpProtocol: "tcp",
          FromPort: plan.api.applicationPort,
          ToPort: plan.api.applicationPort,
          CidrIp: networkCidrs.publicA,
          Description: "Application target in the primary public subnet",
        },
      ],
      Tags: resourceTags,
    });

    const apiSecurityGroup = await AWS.EC2.SecurityGroup("ApiSecurityGroup", {
      GroupDescription: "Snackday API host connectivity",
      VpcId: vpc.VpcId,
      SecurityGroupIngress: [
        {
          IpProtocol: "tcp",
          FromPort: plan.api.applicationPort,
          ToPort: plan.api.applicationPort,
          SourceSecurityGroupId: loadBalancerSecurityGroup.GroupId,
          Description: "Application traffic from the load balancer",
        },
      ],
      SecurityGroupEgress: [
        {
          IpProtocol: "tcp",
          FromPort: 443,
          ToPort: 443,
          CidrIp: "0.0.0.0/0",
          Description: "Provider verification and AWS API calls",
        },
        {
          IpProtocol: "tcp",
          FromPort: plan.database.port,
          ToPort: plan.database.port,
          CidrIp: networkCidrs.databaseA,
          Description: "PostgreSQL in the primary database subnet",
        },
        {
          IpProtocol: "tcp",
          FromPort: plan.database.port,
          ToPort: plan.database.port,
          CidrIp: networkCidrs.databaseB,
          Description: "PostgreSQL in the secondary database subnet",
        },
      ],
      Tags: resourceTags,
    });

    const databaseSecurityGroup = await AWS.EC2.SecurityGroup("DatabaseSecurityGroup", {
      GroupDescription: "Private PostgreSQL access from the Snackday API only",
      VpcId: vpc.VpcId,
      SecurityGroupIngress: [
        {
          IpProtocol: "tcp",
          FromPort: plan.database.port,
          ToPort: plan.database.port,
          SourceSecurityGroupId: apiSecurityGroup.GroupId,
          Description: "PostgreSQL from the API host",
        },
      ],
      SecurityGroupEgress: [],
      Tags: resourceTags,
    });

    const databaseSubnetGroupName = `${prefix}-database`;
    await AWS.RDS.DBSubnetGroup("DatabaseSubnetGroup", {
      DBSubnetGroupName: databaseSubnetGroupName,
      DBSubnetGroupDescription: "Private subnets for Snackday staging PostgreSQL",
      SubnetIds: [databaseSubnetA.SubnetId, databaseSubnetB.SubnetId],
      Tags: resourceTags,
    });

    const databaseInstanceIdentifier = `${prefix}-postgres`;
    const database = await AWS.RDS.DBInstance("Database", {
      DBInstanceIdentifier: databaseInstanceIdentifier,
      DBName: "snackday",
      Engine: plan.database.engine,
      EngineVersion: plan.database.engineVersion,
      DBInstanceClass: plan.database.instanceClass,
      AllocatedStorage: "20",
      MaxAllocatedStorage: 100,
      StorageType: "gp3",
      StorageEncrypted: plan.database.storageEncrypted,
      AvailabilityZone: plan.database.availabilityZone,
      MultiAZ: false,
      DBSubnetGroupName: databaseSubnetGroupName,
      VPCSecurityGroups: [databaseSecurityGroup.GroupId],
      PubliclyAccessible: plan.database.publiclyAccessible,
      Port: String(plan.database.port),
      MasterUsername: "snackday_admin",
      ManageMasterUserPassword: true,
      EnableIAMDatabaseAuthentication: true,
      AutoMinorVersionUpgrade: true,
      BackupRetentionPeriod: plan.database.backupRetentionDays,
      CopyTagsToSnapshot: true,
      DeletionProtection: true,
      DeleteAutomatedBackups: false,
      EnableCloudwatchLogsExports: ["postgresql", "upgrade"],
      Tags: resourceTags,
    });

    const roleName = `${prefix}-api`;
    await AWS.IAM.Role("ApiRole", {
      RoleName: roleName,
      Description: "Runtime identity for the Snackday staging API host",
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      },
      ManagedPolicyArns: ["arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"],
      Tags: resourceTags,
    });

    await AWS.IAM.RolePolicy("ApiSecretsPolicy", {
      RoleName: roleName,
      PolicyName: `${prefix}-runtime-secrets`,
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "secretsmanager:GetSecretValue",
            Resource: [database["MasterUserSecret.SecretArn"], config.runtimeSecretArn],
          },
        ],
      },
    });

    const instanceProfileName = `${prefix}-api`;
    await AWS.IAM.InstanceProfile("ApiInstanceProfile", {
      InstanceProfileName: instanceProfileName,
      Roles: [roleName],
    });

    const api = await AWS.EC2.Instance("ApiInstance", {
      ImageId: plan.api.amiId,
      InstanceType: plan.api.instanceType,
      AvailabilityZone: plan.api.availabilityZone,
      SubnetId: publicSubnetA.SubnetId,
      SecurityGroupIds: [apiSecurityGroup.GroupId],
      IamInstanceProfile: instanceProfileName,
      EbsOptimized: true,
      MetadataOptions: {
        HttpEndpoint: "enabled",
        HttpTokens: "required",
        HttpPutResponseHopLimit: 1,
        InstanceMetadataTags: "disabled",
      },
      UserData: Buffer.from(
        bootstrapEnvironment({
          publicBaseUrl: plan.publicBaseUrl,
          appleClientId: config.appleClientId,
          databaseEndpoint: database["Endpoint.Address"],
          databasePort: database["Endpoint.Port"],
          databaseSecretArn: database["MasterUserSecret.SecretArn"],
          runtimeSecretArn: config.runtimeSecretArn,
          artifactDigest: plan.api.artifactDigest,
        }),
      ).toString("base64"),
      Tags: tags({
        Application: "snackday",
        Environment: app.stage,
        Name: `${prefix}-api`,
        ReleaseDigest: plan.api.artifactDigest,
      }),
    });

    const loadBalancer = await AWS.ElasticLoadBalancingV2.LoadBalancer("LoadBalancer", {
      Name: `${app.stage}-snackday-api`,
      Type: "application",
      Scheme: "internet-facing",
      IpAddressType: "ipv4",
      SecurityGroups: [loadBalancerSecurityGroup.GroupId],
      Subnets: [publicSubnetA.SubnetId, publicSubnetB.SubnetId],
      LoadBalancerAttributes: [
        { Key: "deletion_protection.enabled", Value: "false" },
        { Key: "routing.http.drop_invalid_header_fields.enabled", Value: "true" },
      ],
      Tags: resourceTags,
    });

    const targetGroup = await AWS.ElasticLoadBalancingV2.TargetGroup("ApiTargetGroup", {
      Name: `${app.stage}-snackday-api`,
      VpcId: vpc.VpcId,
      Protocol: "HTTP",
      Port: plan.api.applicationPort,
      TargetType: "instance",
      Targets: [{ Id: api.InstanceId, Port: plan.api.applicationPort }],
      HealthCheckEnabled: true,
      HealthCheckProtocol: "HTTP",
      HealthCheckPath: "/readyz",
      HealthCheckPort: "traffic-port",
      HealthyThresholdCount: 2,
      UnhealthyThresholdCount: 2,
      HealthCheckIntervalSeconds: 15,
      HealthCheckTimeoutSeconds: 5,
      Matcher: { HttpCode: "200" },
      Tags: resourceTags,
    });

    await AWS.ElasticLoadBalancingV2.Listener("HttpsListener", {
      LoadBalancerArn: loadBalancer.LoadBalancerArn,
      Port: plan.api.listenerPort,
      Protocol: "HTTPS",
      SslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
      Certificates: [{ CertificateArn: config.certificateArn }],
      DefaultActions: [{ Type: "forward", TargetGroupArn: targetGroup.TargetGroupArn }],
    });

    await AWS.Route53.RecordSet("StagingAlias", {
      HostedZoneId: config.hostedZoneId,
      Name: config.hostname,
      Type: "A",
      AliasTarget: {
        DNSName: loadBalancer.DNSName,
        HostedZoneId: loadBalancer.CanonicalHostedZoneID,
        EvaluateTargetHealth: true,
      },
    });

    return {
      stage: app.stage,
      region: config.region,
      hostname: config.hostname,
      publicBaseUrl: plan.publicBaseUrl,
      vpcId: vpc.VpcId,
      apiInstanceId: api.InstanceId,
      apiSubnetId: publicSubnetA.SubnetId,
      apiSecurityGroupId: apiSecurityGroup.GroupId,
      apiPort: plan.api.applicationPort,
      databaseInstanceId: databaseInstanceIdentifier,
      databaseEndpoint: database["Endpoint.Address"],
      databasePort: Number(database["Endpoint.Port"]),
      databaseSubnetGroupName,
      databaseSecurityGroupId: databaseSecurityGroup.GroupId,
      databaseSecretArn: database["MasterUserSecret.SecretArn"],
      loadBalancerArn: loadBalancer.LoadBalancerArn,
      loadBalancerDnsName: loadBalancer.DNSName,
      loadBalancerSecurityGroupId: loadBalancerSecurityGroup.GroupId,
    };
  },
);

console.log(JSON.stringify(outputs, undefined, 2));

await app.finalize();

function tags(values: Readonly<Record<string, string>>): Array<{ Key: string; Value: string }> {
  return Object.entries(values).map(([Key, Value]) => ({ Key, Value }));
}

interface BootstrapEnvironment {
  readonly publicBaseUrl: string;
  readonly appleClientId: string;
  readonly databaseEndpoint: string;
  readonly databasePort: string;
  readonly databaseSecretArn: string;
  readonly runtimeSecretArn: string;
  readonly artifactDigest: string;
}

function bootstrapEnvironment(environment: BootstrapEnvironment): string {
  const entries = {
    SNACKDAY_RUNTIME_MODE: "staging",
    SNACKDAY_PUBLIC_BASE_URL: environment.publicBaseUrl,
    SNACKDAY_APPLE_CLIENT_ID: environment.appleClientId,
    SNACKDAY_DATABASE_HOST: environment.databaseEndpoint,
    SNACKDAY_DATABASE_PORT: environment.databasePort,
    SNACKDAY_DATABASE_NAME: "snackday",
    SNACKDAY_DATABASE_SECRET_ARN: environment.databaseSecretArn,
    SNACKDAY_RUNTIME_SECRET_ARN: environment.runtimeSecretArn,
    SNACKDAY_RELEASE_DIGEST: environment.artifactDigest,
  } as const;
  const content = Object.entries(entries)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");

  return `#!/bin/sh\nset -eu\ninstall -d -m 0750 /etc/snackday\numask 077\nprintf '%s\\n' '${content}' > /etc/snackday/staging.env\nsystemctl restart snackday\n`;
}
