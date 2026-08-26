# AWS Migration MVP — Discovery → Graph → Migration Analysis

Read-only AWS infrastructure discovery, dependency graphing, and cross-region migration analysis platform, powered by Kiro Crew autonomous agents.

**Pipeline**: scan → inventory → graph → migration assessment.  
**Scope**: Analysis only. No resources are created, modified, or deleted.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  aws-migration-orchestrator (single entry point for users)  │
└────────┬──────────────────┬──────────────────┬──────────────┘
         │                  │                  │
         ▼                  ▼                  ▼
┌─────────────────┐ ┌────────────────┐ ┌──────────────────────┐
│ aws-discovery   │ │ infrastructure │ │ migration-analysis   │
│ MCP server      │ │ -graph MCP     │ │ MCP server           │
│ (19 collectors) │ │ server         │ │ (rules + analyzer)   │
└────────┬────────┘ └───────┬────────┘ └──────────┬───────────┘
         │                  │                     │
         ▼                  ▼                     ▼
   AWS APIs           inventory.json ←→ graph.json
   (read-only)        (shared file store, lock-free)
```

### Pipeline stages

| # | Stage | Server | Input | Output |
|---|-------|--------|-------|--------|
| 1 | **Discovery** | aws-discovery-mcp | AWS APIs (read-only) | `data/inventory/inventory.json` |
| 2 | **Graph** | infrastructure-graph-mcp | Inventory JSON | `data/graph/graph.json` |
| 3 | **Migration** | migration-analysis-mcp | Graph JSON | Migration Assessment |

Each stage has **single responsibility** and never calls AWS except stage 1. Stores are JSON files with atomic writes — no database locks, multiple readers, any agent can read at any time.

## Resource Coverage (27 types, 19 collectors)

| Collector | Resource Types | Key Relationships |
|-----------|---------------|-------------------|
| network | VPC, Subnet, RouteTable, IGW, NAT, SecurityGroup | BELONGS_TO, RUNS_IN, ATTACHES_TO, ROUTES_THROUGH |
| ec2 | EC2 Instance | RUNS_IN Subnet, BELONGS_TO VPC, USES SG/IAM |
| ebs | EBS Volume | ATTACHED_TO Instance |
| eip | Elastic IP | ASSOCIATED_WITH Instance/ENI |
| ecs | ECS Cluster, Service | BELONGS_TO, RUNS_IN, USES SG, TARGETS TG |
| elb | ALB/NLB, TargetGroup | RUNS_IN, USES SG, TARGETS |
| rds | RDS Instance, DBCluster | RUNS_IN, USES SG, BELONGS_TO Cluster |
| s3 | S3 Bucket | — |
| lambda | Lambda Function | RUNS_IN, USES SG/Role |
| iam | IAM Role | — (global) |
| secrets | Secrets Manager Secret | — |
| cloudwatch | CloudWatch Log Group | LOGS_FOR Lambda |
| route53 | Route53 Hosted Zone | — (global) |
| dynamodb | DynamoDB Table | — |
| ecr | ECR Repository | — |
| sqs | SQS Queue | USES DLQ |
| sns | SNS Topic | — |
| elasticache | ElastiCache Cluster | USES SG |
| cloudfront | CloudFront Distribution | USES S3 origin |

## Migration Rules (all 27 types covered)

Every resource type has a **deterministic** migration rule — no LLM chooses strategies:

| Type | Strategy | Risk | Notes |
|------|----------|------|-------|
| VPC, Subnet, RT, IGW, SG | RECREATE | LOW | Config-only |
| NAT Gateway | RECREATE | MEDIUM | New EIP needed |
| EC2 Instance | SNAPSHOT_RESTORE | HIGH | AMI copy cross-region |
| EBS Volume | SNAPSHOT_RESTORE | MEDIUM | Snapshot + restore |
| Elastic IP | MANUAL | MEDIUM | IP changes (regional) |
| ECS Cluster | RECREATE | LOW | Control-plane only |
| ECS Service | RECREATE | MEDIUM | Needs image in target |
| ALB/NLB | RECREATE | MEDIUM | DNS name changes |
| TargetGroup | RECREATE | LOW | — |
| RDS Instance/Cluster | SNAPSHOT_RESTORE | HIGH | Data transfer |
| S3 Bucket | REPLICATE | MEDIUM | Global name conflict |
| Lambda | RECREATE | MEDIUM | Deploy artifact needed |
| IAM Role | NO_ACTION | LOW | Global service |
| Secrets Manager | REPLICATE | HIGH | Value not exposed |
| CloudWatch Logs | RECREATE | LOW | History not migrated |
| Route53 Zone | NO_ACTION | MEDIUM | DNS repoint needed |
| DynamoDB Table | REPLICATE | HIGH | Global Tables or backup |
| ECR Repository | REPLICATE | MEDIUM | Image replication |
| SQS Queue | RECREATE | MEDIUM | In-flight msgs lost |
| SNS Topic | RECREATE | LOW | Subscriptions recreated |
| ElastiCache | SNAPSHOT_RESTORE | MEDIUM | Redis only (no Memcached) |
| CloudFront | NO_ACTION | LOW | Repoint origins |

## Quick Start

```bash
cd /home/kirocrew/workplace/kirocrew-workspace/aws-migration-mvp
export PATH="/home/kirocrew/.local/nodejs/bin:$PATH"
npm install
npm run build
```

### Run the pipeline via the orchestrator

Open a chat with `aws-migration-orchestrator` in the Kiro Crew dashboard:

```
Como migrar us-east-1 para sa-east-1?
```

The orchestrator runs: `scan_region → build_graph → analyze_resource_migration` and returns the full assessment.

### Run tests

```bash
npm test              # Full unit suite (128 tests)
npm run test:kuzu     # Legacy Kuzu repo tests (if Kuzu is available)
npm run test:integration  # Real AWS scan (requires credentials)
```

## Project Structure

```
aws-migration-mvp/
├── agents/                          # Agent configs (discovery, graph, migration, orchestrator)
├── mcp/
│   ├── aws-discovery/src/index.ts   # Discovery MCP server (19 collectors)
│   ├── graph-agent/src/index.ts     # Graph MCP server (8 query tools)
│   └── migration-agent/src/index.ts # Migration MCP server (7 analysis tools)
├── domain/
│   ├── resources/                   # AwsResource, ResourceType, RegionInventory
│   ├── relationships/               # RelationshipType (12 types)
│   ├── graph/                       # GraphNode, GraphEdge, Builder, EdgeType (16 types)
│   └── migration/                   # Rules, Analyzer, Assessment, Strategy
├── infrastructure/aws/
│   ├── client.ts                    # 16 AWS SDK v3 clients (cached per region)
│   ├── scanner.ts                   # Orchestrates 19 concurrent collectors
│   ├── logger.ts                    # Structured logger (stderr only — stdout = MCP)
│   └── collectors/                  # 19 collector files
├── repositories/
│   ├── file-infrastructure.repository.ts  # JSON-backed inventory store
│   ├── inventory-repository.factory.ts    # Selects file or in-memory
│   └── graph/
│       ├── file-graph.repository.ts       # JSON-backed graph store
│       ├── graph-repository.factory.ts    # Selects file or in-memory
│       ├── in-memory-graph.repository.ts  # Traversal engine (adjacency maps)
│       └── graph.repository.ts            # Interface contract
├── api/                             # HTTP API for migration assessments
├── tests/unit/                      # 128 tests across 12 suites
└── data/
    ├── inventory/                   # Generated: inventory.json (gitignored)
    └── graph/                       # Generated: graph.json (gitignored)
```

## Agent Tools

### Discovery (aws-discovery-mcp)
| Tool | Description |
|------|-------------|
| `scan_region` | Full scan — 19 collectors in parallel, persists to inventory.json |
| `list_resources` | List from cached scan, optional type filter |
| `get_resource` | Full details by ID or ARN |
| `get_resource_dependencies` | Direct dependencies + relationships |

### Graph (infrastructure-graph-mcp)
| Tool | Description |
|------|-------------|
| `build_graph` | Build graph FROM inventory (no AWS call) |
| `get_resource` | One node |
| `get_resources_by_type` | Nodes of a type |
| `get_dependencies` | What a resource depends on |
| `get_dependents` | What depends on a resource |
| `get_impact` | Transitive affected set |
| `find_path` | Directed path between two resources |
| `get_architecture` | Full graph + service breakdown + limitations |

### Migration (migration-analysis-mcp)
| Tool | Description |
|------|-------------|
| `analyze_resource_migration` | Full assessment: source→target |
| `get_migration_rule` | Deterministic rule for a type |
| `get_infrastructure_graph` | Graph metadata + export |
| `get_resource` / `get_dependencies` / `get_dependents` / `get_impact` | Scoped queries |

## Edge Vocabulary (16 types)

`CONTAINS`, `BELONGS_TO`, `DEPENDS_ON`, `USES`, `ASSOCIATED_WITH`, `RUNS_IN`,
`CONNECTS_TO`, `TARGETS`, `ROUTES_TO`, `ROUTES_THROUGH`, `ATTACHES_TO`,
`ASSUMES_ROLE`, `ATTACHED_TO`, `LOGS_FOR`, `READS_FROM`, `WRITES_TO`.

## AWS IAM Policy Required

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "ec2:Describe*",
      "ecs:List*", "ecs:Describe*",
      "elasticloadbalancing:Describe*",
      "rds:Describe*",
      "s3:ListAllMyBuckets", "s3:GetBucketLocation",
      "lambda:ListFunctions",
      "iam:ListRoles",
      "secretsmanager:ListSecrets",
      "logs:DescribeLogGroups",
      "route53:ListHostedZones",
      "dynamodb:ListTables", "dynamodb:DescribeTable",
      "ecr:DescribeRepositories",
      "sqs:ListQueues", "sqs:GetQueueAttributes",
      "sns:ListTopics", "sns:GetTopicAttributes",
      "elasticache:DescribeCacheClusters",
      "cloudfront:ListDistributions",
      "sts:GetCallerIdentity"
    ],
    "Resource": "*"
  }]
}
```

## Known Limitations

1. **ECS task definition not resolved** — container image source / task role not linked as graph edges
2. **S3 bucket metadata minimal** — encryption, policy, ACL not fetched
3. **IAM roles not filtered** — all account roles returned (governance roles inflate count)
4. **Cross-region dependencies not detected** — e.g., S3 in us-east-1 used by Lambda in eu-west-1
5. **Route53 records not enumerated** — only zones collected (ALIAS/CNAME resolution is future)
6. **No VPC Peering / Transit Gateway** — multi-VPC topology edges not yet derived

## Roadmap

- [ ] Relationship enrichment: ECS task def env vars → app→DB links
- [ ] Incremental scan (diff with previous inventory)
- [ ] Cost data integration (AWS Cost Explorer)
- [ ] Migration Planner: generate IaC from assessment
- [ ] Execution Engine: orchestrate actual migration
- [ ] Interactive graph visualization (D3 artifact)
