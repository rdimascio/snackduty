# AWS staging cost estimate — September 17, 2026

**Approximately USD $62–67/month** for the current graph in **us-east-1**.
This is an illustrative on-demand estimate, not a budget cap or a confirmed
account bill. Assumptions: 730 hours/month, Linux, one API, Single-AZ RDS,
0.1–1 average ALB LCU, low log/notification volume, one retained AMI snapshot,
existing prerequisites, no discounts or free-tier credits. No resources were
provisioned. Region/account authorization is still blocked by an expired login.

| Resource                           | Rate and quantity                                                                           |       USD/month |
| ---------------------------------- | ------------------------------------------------------------------------------------------- | --------------: |
| EC2 API t3.small                   | $0.0208/hour × 730                                                                          |           15.18 |
| EC2 root gp3                       | 20 GB × $0.08/GB-month                                                                      |            1.60 |
| PostgreSQL db.t4g.micro, Single-AZ | $0.016/hour × 730                                                                           |           11.68 |
| RDS gp3                            | 20 GB × $0.115/GB-month                                                                     |            2.30 |
| ALB fixed                          | $0.0225/hour × 730                                                                          |           16.43 |
| Public IPv4                        | Minimum 3 (two ALB nodes + API) × $0.005/hour × 730                                         |           10.95 |
| Secrets Manager                    | Runtime prerequisite + RDS-managed master, 2 × $0.40                                        |            0.80 |
| CloudWatch alarms                  | Two standard single-metric alarms × $0.10                                                   |            0.20 |
| **Fixed subtotal**                 | Unrounded sum                                                                               |       **59.14** |
| ALB capacity                       | 0.1–1 average LCU × $0.008/hour × 730                                                       |       0.58–5.84 |
| Retained AMI snapshot              | Up to 20 GB full charged data × $0.05/GB-month                                              |            1.00 |
| Application logs                   | 1 GB ingestion × $0.50, 14-day retention at $0.03/GB-month; no compression discount assumed |           ~0.51 |
| S3 state                           | 1 GB × $0.023, 1,000 PUT/LIST ($0.005), 1,000 GET ($0.0004)                                 |          0.0284 |
| Existing hosted-zone allocation    | First-25-zone tier; incremental $0 if already shared                                        |            0.50 |
| SNS example                        | 100 publishes + 100 email notifications, without free tier                                  |          ~0.002 |
| **Illustrative total**             | Rounded range                                                                               | **61.77–67.03** |

The graph does not create a NAT gateway, VPC endpoint, ASG, second API or Multi-AZ
DB. Matching Route53 alias-A queries to ALB have no query charge; other queries
can incur charges. A non-exportable public ACM certificate integrated with ALB
has no certificate charge. Zone, state bucket, runtime secret and alert topic
are existing prerequisites, not graph creations; their allocations are included
to expose total operating cost. Domain registration is additional if needed.

## Temporary work and retained storage

- Packer t3.small builder: about **$0.028/hour** ($0.0208 compute + $0.005 public
  IPv4 + $0.00219 for 20 GB gp3 pro-rated over 730 hours). Two hours ≈ $0.056,
  before transfers, CPU credits and encryption-copy intermediate volumes/snapshots.
  Build controller cost is separate and unselected (hosted CI or existing Linux
  machine cannot be assumed free). Repeated failures accumulate costs.
- Each retained image: up to **$1/month per 20 GB full snapshot equivalent**;
  actual EBS snapshot billing is stored data, with incremental sharing where
  applicable. AMI deregistration alone is not snapshot cleanup.
- RDS restore rehearsal: four hours of an extra db.t4g.micro + 20 GB storage +
  pro-rated secret is about **$0.08**, excluding any extra API/ALB, backup storage,
  transfers, or time left running. Restoring does not replace/delete the source.
- Automated/manual RDS backup storage beyond the regional included allocation:
  **$0.095/GB-month**, or **$1.90/month per 20 GB**. Include retained backups after
  DB deletion and multiple recovery snapshots. No assumption that all snapshots
  are free. Initial 20 GB storage auto-growth to 100 GB raises RDS storage from
  **$2.30 to $11.50/month**.
- Secret reads: **$0.05 per 10,000 API calls**, generally negligible for two
  reads per startup; repeated failures/restarts increase this. S3 noncurrent state
  versions/release archives are additional stored GB and requests.

## Material uncertainty and failure exposure

ALB capacity and address count can grow. T3 Linux surplus CPU costs
$0.05/vCPU-hour; RDS T4g surplus costs $0.075/vCPU-hour. Sustained load can exceed
this small-instance estimate materially. Internet/cross-AZ transfer, RDS upgrade
logs (not assigned the application's 14-day retention), additional snapshots,
KMS keys if introduced, provider email/SMS/APNs costs, domain fees, support and
taxes are excluded pending usage and configuration. No cost alarm/budget is
declared by this graph; select an operating budget and owner before approval.

After failure, ALB/public IPv4, EC2/EBS, RDS/restored DBs/storage/backups, AMI
snapshots, logs/alarms, secrets and state may continue billing. Stopped compute
does not remove retained storage. Require a named retention deadline and verified
cleanup receipt; see the [readiness recovery gates](./aws-staging-readiness.md).

## Official price provenance

Anonymous public AWS price catalogs were inspected; these are not authenticated
AWS-account observations. Reprice immediately before approval if region, sizes,
engine support status or deployment date changes.

| Official source                                                                                                               | Publication / selected SKU                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [EC2 us-east-1 price catalog](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-east-1/index.json) | `2026-09-17T21:18:35Z`; t3.small `QA3NBPZEQKZ2K9AR`, gp3 `JG3KUJMBRGHV3N8G`, EBS snapshot `7U7TWP44UP36AT3R`       |
| [RDS us-east-1 price catalog](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/us-east-1/index.json) | `2026-09-11T12:45:02Z`; PostgreSQL t4g.micro `9HPEGXQTDDGH53C9`, gp3 `KYVYY29G957PKY3B`, backup `6W8ECRFVDATCER7J` |
| [ELB us-east-1 price catalog](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSELB/current/us-east-1/index.json)    | `2026-09-11T12:45:44Z`; ALB `37CUWUT8GSNQEPUV`, LCU `P2XGEJ8N3KU52WA8`                                             |

Other rate sources: [VPC IPv4](https://aws.amazon.com/vpc/pricing/),
[Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/),
[CloudWatch](https://aws.amazon.com/cloudwatch/pricing/),
[S3](https://aws.amazon.com/s3/pricing/),
[Route53](https://aws.amazon.com/route53/pricing/),
[SNS](https://aws.amazon.com/sns/pricing/),
[ACM](https://aws.amazon.com/certificate-manager/pricing/), and
[RDS PostgreSQL CPU/backup terms](https://aws.amazon.com/rds/postgresql/pricing/).
