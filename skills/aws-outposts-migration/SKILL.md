---
name: aws-outposts-migration
description: "Plan migrations from public AWS Regions into pre-provisioned/shared AWS Outposts racks, including target placement, capacity, subnets, Local Gateway routing, and hybrid cutover gates. Use when the target is Outposts or the user mentions shared Outposts racks, Outpost ARN/site, Local Gateway, LGW route tables, on-prem connectivity, Local Zones, Wavelength, rack/server capacity, or edge placement."
argument-hint: "[source public region/account, target account/region, shared target Outpost/site/local gateway, workload scope]"
---

# AWS Public Region to Outposts Migration

Use this skill when the source workload is in a normal public AWS Region and the target environment is a workload account in a Landing Zone where a core/shared-services account owns pre-provisioned Outposts racks and shares Outposts networking/capacity with application accounts. We do not have credentials for the core account. The Outposts rack is a target placement platform, not something this pipeline migrates.

## Core Principle

Do not migrate Outposts infrastructure. Migrate supported workloads from public-region AWS resources into target resources placed on an existing shared Outpost, only after proving the target workload account can use the shared Outpost, target subnets exist on that Outpost, capacity is available, and Local Gateway/on-prem routing is mapped.

There are two accounts we can operate against, plus one external owner:

- SOURCE account: public-region workload being migrated.
- TARGET workload account: receives the migrated workload and consumes shared Outposts resources.
- OUTPOSTS CORE account: owns/operates the Outposts racks, Local Gateway, RAM shares, and sometimes capacity visibility. Treat this as external metadata only; do not request or assume credentials for it.

Use only `migration-source` and `migration-target` profiles. All Outposts checks must run through the target workload account (`migration-target`). If target visibility is insufficient because the resource is owned by core, stop and request the missing Outpost/subnet/Local Gateway/capacity evidence from the platform/core team instead of trying to access the core account.

The default flow is:

1. Discover the source public-region workload normally.
2. Validate the target Outposts environment separately.
3. Adapt the target deployment plan to use Outpost subnets, compatible instance/storage/service options, and Local Gateway routing.
4. Stop at the approval gate if any target Outposts placement or networking input is unresolved.

## Trigger Signals

Run this checklist if any of these appear in the user request, `.env`, discovery output, total inventory, graph data, CloudFormation, tags, names, or target-account context:

- Resource types: `AWS::Outposts::Outpost`, `AWS::Outposts::Site`, `AWS::EC2::LocalGatewayRouteTable`, `AWS::EC2::LocalGatewayRoute`, `AWS::EC2::LocalGatewayRouteTableVPCAssociation`.
- ARNs or IDs containing `outpost`, `outposts`, `op-`, `lgw-`, `lgw-rtb-`, `local-gateway`, `local gateway`.
- Target account has shared Outposts racks already provisioned.
- Target EC2 subnets with `OutpostArn`, target placement using Local/Wavelength Zones, or target routes through Local Gateway.
- Tags/names such as `edge`, `branch`, `factory`, `site`, `colo`, `onprem`, `outpost`, `latency-sensitive`, `low-latency`.
- Networking that depends on Local Gateway, Direct Connect, Transit Gateway, VPC peering to on-prem, or static hybrid routes.

## Assessment Workflow

1. Confirm source workload in the public Region:
   - Source account/region, VPC/subnets/security groups, EC2/EBS/ECS/EKS/RDS/S3/Lambda dependencies, data stores, DNS, IAM/KMS, and RPO/RTO.
   - Classify what can be recreated normally and what must change because the target placement is Outposts.
2. Confirm target Outposts access from the target workload account:
   - Target account id and parent Region.
   - Target Outpost ARN(s), Site ID/name, owner/core account, and Resource Access Manager/share status if known.
   - Target Outpost subnets and Availability Zone IDs.
   - Available capacity for required instance families, EBS/storage needs, IPs, service quotas, and supported services.
   - Whether target APIs expose enough shared-resource detail to validate placement. If not, capture explicit evidence needed from the core/platform team.
3. Confirm target hybrid networking:
   - Target VPC, Outpost subnets, route tables, Local Gateway route tables, VPC associations, Direct Connect/TGW/on-prem route path, and on-prem CIDRs.
   - Whether source CIDRs can be reused or must change.
4. Map source resources to target placement:
   - `REGIONAL_TO_OUTPOST`: resource can be recreated/restored on Outposts with target subnet/placement changes.
   - `REGIONAL_REMAINS_REGIONAL`: resource should stay in the parent Region and be referenced from Outposts workloads.
   - `HYBRID_NETWORK`: requires Local Gateway/on-prem route mapping.
   - `DATA_LOCALITY`: requires explicit data movement, sync, and cutover plan.
   - `UNSUPPORTED_ON_OUTPOSTS`: service/resource cannot run on Outposts and needs an alternate target design.
5. Produce a migration plan with three independent tracks:
   - Infrastructure placement: VPC/subnets/security groups/routes/load balancers/templates adapted to Outpost subnets.
   - Data movement: AMI/EBS/RDS/S3/container/image replication into the target account/parent Region, then restore/launch onto Outpost placement where supported.
   - Cutover/validation: DNS, Local Gateway/on-prem routes, application health, rollback.
6. Stop before execution unless all target Outposts gates are explicitly answered.

## Target Validation Commands

Use `awsApi/call_aws` with the target workload profile only. Commands are read-only.

Target workload account checks:

- `aws outposts list-outposts --profile migration-target --region <targetRegion>`
- `aws outposts get-outpost --outpost-id <op-id> --profile migration-target --region <targetRegion>`
- `aws ec2 describe-subnets --filters Name=outpost-arn,Values=<targetOutpostArn> --profile migration-target --region <targetRegion>`
- `aws ec2 describe-local-gateway-route-tables --profile migration-target --region <targetRegion>`
- `aws ec2 describe-local-gateway-route-table-vpc-associations --profile migration-target --region <targetRegion>`
- `aws ec2 describe-instance-type-offerings --location-type availability-zone-id --filters Name=location,Values=<outpostAzId> --profile migration-target --region <targetRegion>`
- `aws service-quotas get-service-quota --service-code ec2 --quota-code <quotaCode> --profile migration-target --region <targetRegion>` when a quota is relevant.

Capacity rule: always consult capacity from the target account as far as AWS APIs allow. If the target account cannot prove free capacity for the required instance families/storage because capacity is owned/managed by core, mark capacity as `UNCONFIRMED` and block execution until the platform/core team confirms or reserves capacity.

If any command is denied or incomplete because the Outpost is shared but not fully visible to the target account/API, stop and ask for the exact target Outpost ARN, subnet IDs, Local Gateway route table IDs, RAM share confirmation, supported instance types, and capacity confirmation. Do not ask for core-account credentials.

## Capacity Plan

Always produce a capacity matrix before CloudFormation execution:

| Source need | Target Outposts check | Result |
|---|---|---|
| EC2 instance family/count | supported type + target-visible capacity or platform/core confirmation | `OK` / `UNCONFIRMED` / `UNSUPPORTED` |
| EBS volume size/type/IOPS | target-visible Outpost storage capacity or platform/core confirmation | `OK` / `UNCONFIRMED` / `UNSUPPORTED` |
| Subnet IPs | available IP count per target Outpost subnet | `OK` / `UNCONFIRMED` / `INSUFFICIENT` |
| Load balancer/ENI needs | service support + subnet capacity | `OK` / `UNCONFIRMED` / `UNSUPPORTED` |
| Data transfer window | snapshot/copy/sync time vs RTO/RPO | `OK` / `RISK` / `BLOCKED` |

Do not proceed when any required compute/storage/network row is `UNCONFIRMED`, `INSUFFICIENT`, `UNSUPPORTED`, or `BLOCKED` unless the user explicitly approves a regional fallback design.

## Data Migration Plan

For every stateful resource, state the exact source-to-target data path:

- EC2/AMI: create AMI or snapshots in source, share/copy to target account parent Region, then launch onto target Outpost subnet with compatible instance type.
- EBS: create source snapshot, share/copy to target parent Region, restore as target volume where Outposts placement is supported; validate encryption/KMS in target.
- RDS: prefer native backup/restore or replication into a supported target pattern. If RDS on Outposts is required, confirm service support, capacity, downtime, and parameter/subnet groups before execution.
- S3: regional bucket data usually remains regional or is copied to target regional bucket. S3 on Outposts requires explicit target S3 on Outposts bucket/endpoint/capacity and a separate copy plan.
- ECR/container images: replicate or push images to target account/region before ECS/EKS placement.
- KMS-encrypted data: create/use target KMS keys and grant source/target copy permissions before snapshot/image copy.

Every data path must include RPO/RTO, downtime/cutover sequence, rollback point, and validation command.

## CloudFormation / IaC Adaptation

When generating or adapting CloudFormation for an Outposts target:

- Replace source `SubnetId`/`SubnetIds` with explicit target Outpost subnet IDs.
- Replace VPC/security group references with target VPC/security group IDs created or selected for the Outposts workload account.
- Preserve the target Outpost subnet placement; do not let templates pick arbitrary regional subnets.
- For EC2, use compatible target `InstanceType`, target AMI ID, target security groups, and target Outpost subnet.
- For Auto Scaling, ECS, or EKS, constrain placement to target Outpost subnets and supported capacity. Do not span regional subnets unless explicitly designed.
- For route tables, Local Gateway associations, and on-prem routes, reference pre-existing target mappings unless the user explicitly requests managed creation.
- Mark unsupported regional-only services as regional dependencies or architecture changes, not as Outposts resources.

Before approval, show a target mapping table and the CloudFormation deltas that move the workload onto Outposts.

## Migration Decisions

Use these deterministic defaults:

- Target Outpost / Site: `NO_ACTION` as a migrated resource. It must already exist/share into the target account; validate access, subnets, capacity, and parent Region.
- Local Gateway route table/routes/associations: do not recreate by default. Treat as pre-existing target network dependencies unless the user explicitly asks to create/change them.
- EC2 from public Region to Outposts: use AMI/EBS snapshot path, then launch on target Outpost subnets with compatible instance types and explicit capacity validation.
- EBS from public Region to Outposts: snapshot/copy/restore may be possible, but target volume placement and data locality are gates.
- ECS/EKS workers from public Region to Outposts: recreate cluster/node/service placement on Outpost-capable subnets; images must be available in target account/region.
- RDS/local persistent services: require service-specific support validation for Outposts and explicit backup/restore or replication plan.
- S3 regional buckets: normally remain regional or are copied to a target regional bucket. S3 on Outposts is a different service/endpoint and requires explicit target bucket/capacity/data-copy design.
- Lambda/API Gateway/CloudFront/global services: generally remain regional/global and must be evaluated as dependencies of the Outposts workload, not forced onto Outposts.

## Required Questions At Scope Gate

Ask these before assessment/planning if not already known:

1. Which shared target Outpost ARN(s), target account, and parent Region should receive the workload?
2. Which target Outpost subnet IDs should replace each source subnet/AZ tier?
3. Which Local Gateway route table/VPC association/on-prem CIDRs apply to the target workload?
4. Are source VPC/subnet CIDRs reused, translated, or redesigned in the target VPC?
5. Which resources must run on Outposts, and which may remain regional in the parent Region?
6. What are the required instance families/storage sizes, and has target Outpost capacity been confirmed?
7. What are the RPO/RTO and permitted downtime for data movement into the Outposts target?

## Output Requirements

When the target is Outposts, add an `Outposts Target Placement` section to the migration report with:

- Source public-region workload summary.
- Landing Zone account model: source account, target workload account, and external Outposts core/shared-services owner if known.
- Target Outpost ARN/site/parent Region/account and evidence that the target workload account can use it.
- Manual gates not yet answered.
- Resources blocked from automated execution.
- A target mapping table: source subnet/AZ/resource -> target Outpost subnet/local gateway/regional fallback or `UNRESOLVED`.
- Capacity matrix with `OK` / `UNCONFIRMED` / `UNSUPPORTED` / `INSUFFICIENT` / `BLOCKED` status.
- Data migration matrix with source artifact, copy/share method, target restore/launch point, RPO/RTO, KMS handling, and validation.
- CloudFormation adaptation summary: subnet replacements, instance type/AMI changes, SG/VPC mapping, route/local gateway assumptions, and regional fallbacks.
- Explicit statement that target execution is blocked until unresolved Outposts placement, capacity, data, CloudFormation and hybrid route gates are approved.

## Safety Rules

- Never create, delete, or modify an Outpost, Site, or Local Gateway as part of the normal migration flow.
- Never assume the target account can use a shared Outpost until access/subnets are verified or explicitly supplied.
- Never place resources onto Outposts without explicit target subnet mapping.
- Never recreate/change Local Gateway routes without explicit target route and on-prem CIDR mapping.
- Never silently move a service that is unsupported on Outposts to the parent Region; call it an architecture choice.
- If source or target Outposts data is incomplete, report `UNKNOWN` or `REQUIRES_MANUAL_ACTION`; do not infer physical/site/capacity facts.