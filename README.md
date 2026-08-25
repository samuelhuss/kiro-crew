# AWS Migration MVP — Infrastructure Discovery

Read-only AWS infrastructure discovery agent for the Kiro Crew platform.
This is **Phase 1** of an intelligent AWS infrastructure analysis and migration platform.

> **Scope**: Discovery and analysis only. No resources are created, modified, or deleted.

## Architecture

```
Kiro Crew Dashboard
    │
    ▼
aws-infrastructure-discovery agent  (agents/aws-infrastructure-discovery/)
    │
    ▼ MCP stdio transport
aws-discovery-mcp server            (mcp/aws-discovery/)
    │
    ▼ AWS SDK v3 (read-only)
AWS Account
```

## Project Structure

```
aws-migration-mvp/
├── agents/
│   └── aws-infrastructure-discovery/
│       ├── agent.json          # Kiro Crew agent config + MCP server declaration
│       └── register-agent.sh  # One-time registration script
├── mcp/
│   └── aws-discovery/
│       └── src/
│           └── index.ts        # MCP server entry — 4 tools
├── domain/
│   ├── resources/
│   │   ├── resource.ts         # AwsResource model + ResourceType
│   │   └── inventory.ts        # RegionInventory + groupByService + computeStats
│   └── relationships/
│       └── relationship.ts     # ResourceRelationship + RelationshipType
├── infrastructure/
│   └── aws/
│       ├── client.ts           # AWS client factory (credential chain, cache)
│       ├── logger.ts           # Structured logger (SCAN_STARTED, etc.)
│       ├── scanner.ts          # RegionScanner — orchestrates all collectors
│       └── collectors/
│           ├── network.collector.ts   # VPC, Subnet, RouteTable, IGW, NAT, SG
│           ├── ecs.collector.ts       # ECS Clusters + Services
│           ├── elb.collector.ts       # ALB/NLB + Target Groups
│           ├── rds.collector.ts       # RDS Instances + Clusters
│           ├── s3.collector.ts        # S3 Buckets (region-filtered)
│           ├── lambda.collector.ts    # Lambda Functions
│           ├── iam.collector.ts       # IAM Roles
│           └── secrets.collector.ts  # Secrets Manager (metadata only)
├── repositories/
│   └── infrastructure.repository.ts  # InfrastructureRepository interface + in-memory impl
├── tests/
│   ├── unit/
│   │   ├── resource-normalization.test.ts
│   │   └── repository.test.ts
│   └── integration/
│       └── scan-region.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

## Prerequisites

- Node.js 22+ (installed at `/home/kirocrew/.local/nodejs/bin/node`)
- AWS credentials (see below)

## Installation

```bash
cd /home/kirocrew/workplace/kirocrew-workspace/aws-migration-mvp
export PATH="/home/kirocrew/.local/nodejs/bin:$PATH"
npm install
npm run build
```

## Running Tests

```bash
# Unit tests (no AWS credentials needed)
npm test

# Integration tests (requires AWS credentials)
export AWS_PROFILE=my-lab-profile
# or
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...

export TEST_REGION=us-east-1   # optional, defaults to us-east-1
npm run test:integration
```

## Register the Agent in Kiro Crew

```bash
chmod +x agents/aws-infrastructure-discovery/register-agent.sh
bash agents/aws-infrastructure-discovery/register-agent.sh
```

Then reload the Kiro Crew dashboard. The agent `aws-infrastructure-discovery` will appear.

## MCP Tools

| Tool | Description |
|------|-------------|
| `scan_region` | Full scan of a region — discovers all supported resources and relationships |
| `list_resources` | List resources from cached scan, with optional type filter |
| `get_resource` | Full details of one resource by ID or ARN |
| `get_resource_dependencies` | Direct dependencies + relationships of a resource |

## AWS Credentials

Credentials are resolved by the AWS SDK v3 default chain (in order):
1. Environment variables: `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`
2. `~/.aws/credentials` profile (`AWS_PROFILE` or `default`)
3. IAM instance profile / ECS task role / Lambda execution role
4. AWS SSO / Web Identity Token

**Never hardcode credentials.**

## Required IAM Policy

Attach this read-only policy to the IAM role/user running the agent:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AwsDiscoveryReadOnly",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeVpcs",
        "ec2:DescribeSubnets",
        "ec2:DescribeRouteTables",
        "ec2:DescribeInternetGateways",
        "ec2:DescribeNatGateways",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeInstances",
        "ecs:ListClusters",
        "ecs:DescribeClusters",
        "ecs:ListServices",
        "ecs:DescribeServices",
        "elasticloadbalancing:DescribeLoadBalancers",
        "elasticloadbalancing:DescribeTargetGroups",
        "rds:DescribeDBInstances",
        "rds:DescribeDBClusters",
        "s3:ListAllMyBuckets",
        "s3:GetBucketLocation",
        "lambda:ListFunctions",
        "iam:ListRoles",
        "secretsmanager:ListSecrets",
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    }
  ]
}
```

## Example Agent Invocation

In the Kiro Crew dashboard, open a chat with the `aws-infrastructure-discovery` agent:

```
Analise a infraestrutura da região us-east-1 e me dê uma visão da arquitetura existente.
```

### Expected Response Format

The agent will call `scan_region("us-east-1")` and respond with:

```
## Infraestrutura AWS — us-east-1

**Conta:** 123456789012  |  **Scan:** 2026-08-25T14:00:00Z  |  **Duração:** 8.2s

### Visão Geral
- Total de recursos: 47
- Total de relacionamentos: 83
- Erros parciais: 0

### Por Serviço
| Serviço | Recursos |
|---------|----------|
| EC2     | 12 (4 VPCs, 6 Subnets, 1 IGW, 1 NAT) |
| ECS     | 5 (2 Clusters, 3 Services) |
| ELBv2   | 4 (2 ALBs, 2 Target Groups) |
| RDS     | 3 (2 Instances, 1 Cluster) |
| Lambda  | 8 Functions |
| S3      | 6 Buckets |
| IAM     | 7 Roles |
| SecretsManager | 2 Secrets |

### Dependências Importantes
- **api-service** (ECS): usa 2 subnets, 1 SG, 1 target group, conectado a db-primary (RDS)
- **web-alb** (ALB): roteia para 2 target groups, em 3 AZs
- **vpc-main** (VPC): 4 subnets dependentes, 1 IGW, 1 NAT

### Recursos sem dependências identificadas
- 3 Security Groups sem associação conhecida
```

## Supported Resource Types

| AWS Type | Collector | Relationships |
|----------|-----------|---------------|
| `AWS::EC2::VPC` | network | — |
| `AWS::EC2::Subnet` | network | BELONGS_TO VPC |
| `AWS::EC2::RouteTable` | network | Subnet ROUTES_THROUGH |
| `AWS::EC2::InternetGateway` | network | ATTACHES_TO VPC |
| `AWS::EC2::NatGateway` | network | RUNS_IN Subnet |
| `AWS::EC2::SecurityGroup` | network | — |
| `AWS::ECS::Cluster` | ecs | — |
| `AWS::ECS::Service` | ecs | RUNS_IN Subnet, USES SG, TARGETS TargetGroup |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` | elb | RUNS_IN Subnet, USES SG |
| `AWS::ElasticLoadBalancingV2::TargetGroup` | elb | LB TARGETS TG |
| `AWS::RDS::DBInstance` | rds | RUNS_IN Subnet, USES SG |
| `AWS::RDS::DBCluster` | rds | USES SG |
| `AWS::S3::Bucket` | s3 | — |
| `AWS::Lambda::Function` | lambda | RUNS_IN Subnet, USES SG, USES Role |
| `AWS::IAM::Role` | iam | — (global) |
| `AWS::SecretsManager::Secret` | secrets | — |

## Current Limitations

1. **No EC2 instance collector** — `AWS::EC2::Instance` type is declared but not yet collected
2. **S3 bucket metadata is minimal** — ACL, policy, encryption not fetched (separate API calls)
3. **ECS task definition not resolved** — task role ARN is stored as property, not as a relationship
4. **IAM roles are not filtered** — all account roles are returned, not just those used by scanned resources
5. **No pagination on VPC/Subnet/SG** — works for accounts with < 1000 resources per type; add `NextToken` handling for very large accounts
6. **In-memory repository** — data is lost when the MCP process restarts; not shared across sessions
7. **Cross-region dependencies not detected** — e.g., an S3 bucket in `us-east-1` used by Lambda in `eu-west-1`

## Recommended Next Steps

1. **Add EC2 instance collector** with AMI, key pair, and placement relationships
2. **Implement persistent repository** — PostgreSQL with JSONB or Neo4j for graph queries
3. **Add ECS task definition collector** to resolve task role and container image dependencies
4. **Cross-reference IAM roles** with services that actually use them
5. **Add CloudWatch / CloudTrail** collector for observability context
6. **Implement change detection** — diff two inventories to identify infrastructure drift
7. **Add VPC Peering / Transit Gateway** collector for multi-VPC topologies
8. **Build the analysis agent prompt** for migration scoring (Phase 2)
