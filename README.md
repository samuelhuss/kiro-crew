# AWS Migration MVP — Infrastructure Discovery + Graph

Read-only AWS infrastructure discovery and analysis platform for Kiro Crew.

- **Phase 1** — Discovery: scan a region and produce a normalized inventory.
- **Phase 2** — Infrastructure Graph: turn the inventory into a queryable graph
  (nodes + relationships) to answer dependency, impact and path questions.

> **Scope**: Discovery and analysis only. No resources are created, modified, or deleted. No migration, CloudFormation, Terraform, or deploy.

## Phase 2 — Infrastructure Graph

```
AWS → Discovery Agent → AWS Inventory → Graph Builder → Infrastructure Graph
                                                          ├── Nodes
                                                          └── Relationships (edges)
```

The **Graph Builder consumes only the normalized inventory** — it never calls AWS.
This preserves separation of responsibilities and lets a future Migration Agent
depend on the Graph Repository instead of AWS APIs.

### Components

| Piece | Location | Responsibility |
|-------|----------|----------------|
| `GraphNode` / `GraphEdge` | `domain/graph/node.ts`, `edge.ts` | node + extensible edge vocabulary |
| `InfrastructureGraphBuilder` | `domain/graph/builder.ts` | `build(inventory) → InfrastructureGraph` |
| `InfrastructureGraph` + `exportGraph()` | `domain/graph/graph.ts` | value object + `{ nodes, edges }` export for React Flow / Cytoscape / D3 |
| `InfrastructureGraphRepository` | `repositories/graph/graph.repository.ts` | storage-independent query contract |
| `InMemoryGraphRepository` | `repositories/graph/in-memory-graph.repository.ts` | MVP impl (adjacency maps, incremental updates) |
| `infrastructure-graph-agent` | `agents/`, `mcp/graph-agent/` | answers questions using the graph tools |

### Edge vocabulary (extensible, meaning preserved)

`CONTAINS`, `BELONGS_TO`, `DEPENDS_ON`, `USES`, `CONNECTS_TO`, `TARGETS`,
`RUNS_IN`, `ASSUMES_ROLE`, `READS_FROM`, `WRITES_TO`, `ROUTES_TO`,
`ASSOCIATED_WITH`, `ATTACHES_TO`, `ROUTES_THROUGH`.

Relationships are **not** collapsed into `DEPENDS_ON`. The builder only emits
edge types it can determine safely from the inventory.

### What the graph can determine today (from real inventory data)

| Edge | Derived from |
|------|--------------|
| Subnet `BELONGS_TO` VPC (+ inverse `CONTAINS`) | network collector / `vpcId` property |
| ECS Service `BELONGS_TO` Cluster (+ `CONTAINS`) | ecs collector |
| `RUNS_IN` Subnet (ECS, ALB, RDS, Lambda, NAT) | collectors |
| `USES` SecurityGroup / IAM Role | ecs, elb, rds, lambda |
| `TARGETS` TargetGroup (ALB, ECS) | elb, ecs |
| `ATTACHES_TO` VPC (IGW), `ROUTES_THROUGH` RouteTable | network |
| RDS Instance `BELONGS_TO` DBCluster | `dbClusterIdentifier` property |

### What the graph deliberately does NOT infer (honest limitations)

These edge types exist in the vocabulary but are **not** created, because the
current inventory does not expose the data to do so safely. They are reported as
`UNKNOWN_RELATIONSHIP` issues rather than guessed:

- **`CONNECTS_TO`** app → database (needs task definition env / runtime config).
- **`READS_FROM` / `WRITES_TO`** S3 / Secrets consumers (needs IAM policy / task def analysis).
- **`ASSUMES_ROLE`** beyond Lambda's execution role (ECS task role not resolved).
- **`ROUTES_TO`** route table → IGW/NAT (route destinations not collected).

### Consistency checks (never silent)

The builder records issues for: dangling edges, duplicate nodes/edges, invalid
relationship types, malformed ARNs, cross-region and cross-account edges, orphan
nodes, and unexpected cycles in acyclic relationships (`CONTAINS`/`BELONGS_TO`).

### Graph agent tools

| Tool | Purpose |
|------|---------|
| `build_graph(region)` | scan (read-only) + build the graph. Run first. |
| `get_resource(id)` | one node |
| `get_resources_by_type(type)` | nodes of a type |
| `get_dependencies(id)` | what a resource depends on |
| `get_dependents(id)` | what depends on a resource |
| `get_impact(id)` | transitively affected resources |
| `find_path(source, target)` | directed relationship path |
| `get_architecture()` | full `{ nodes, edges }` + service breakdown + limitations |

### End-to-end

```
scan_region("us-east-1") → inventory → build_graph(inventory) → InfrastructureGraph
  get_dependencies("ecs-api")
  get_dependents("rds-prod")
  get_impact("rds-prod")
  exportGraph() → { nodes: [...], edges: [...] }
```

### Incremental updates

The graph is updated in place — a single changed resource does not force a full
rescan: `addNode`, `updateNode`, `removeNode`, `addEdge`, `removeEdge`,
`updateRelationships`.

---

## Phase 3 — Migration Analysis

```
Infrastructure Graph + Source Region + Target Region
        → Migration Rules (deterministic)
        → Migration Analysis Agent
        → Migration Assessment (summary + resources + phases + blockers)
```

The Migration Analysis stage decides, for a source→target region move, how each
resource would be treated. It is **analysis only** — no AWS changes, no
CloudFormation/Terraform/CDK, no snapshots, no replication, no DNS changes.

### Deterministic by design

Critical decisions (strategy, status, risk, blockers, phase order) come from
**Migration Rules + the Infrastructure Graph**, never from the LLM. The agent
explains and summarizes; it does not invent strategies.

```
Infrastructure Graph → Migration Rules → Migration Analyzer → Migration Assessment
```

| Piece | Location |
|-------|----------|
| Strategy / Status / Risk enums | `domain/migration/strategy.ts` |
| `MigrationRule` catalog (pure fn per type) | `domain/migration/rules.ts` |
| `MigrationAnalyzer` (dependency-aware) | `domain/migration/analyzer.ts` |
| `MigrationAssessment` model | `domain/migration/assessment.ts` |
| Observability events | `domain/migration/events.ts` |
| `MigrationAssessmentRepository` + in-memory impl | `repositories/migration/` |
| HTTP API (native `node:http`) | `api/` |
| `migration-analysis-agent` (MCP, 7 tools) | `agents/`, `mcp/migration-agent/` |

### Strategies & statuses

Strategies: `RECREATE`, `REPLICATE`, `COPY`, `SNAPSHOT_RESTORE`, `TRANSFORM`,
`MANUAL`, `NOT_SUPPORTED`, `NO_ACTION`.
Statuses: `SUPPORTED`, `SUPPORTED_WITH_CHANGES`, `REQUIRES_MANUAL_ACTION`,
`NOT_SUPPORTED`, `UNKNOWN`. Risk: `LOW` | `MEDIUM` | `HIGH` | `CRITICAL`.

Each rule considers resource type, source/target region, dependencies and
properties. Types with no rule become `UNKNOWN` (never a guess).

### Dependency-aware analysis

The analyzer resolves direct + indirect dependencies from the graph and
propagates effects: a resource cannot be "cleaner" than a critical dependency
(e.g. an ECS service that depends on a Secret requiring manual action is itself
downgraded, and inherits high risk from a dependent RDS). Blockers are only
recorded when derivable from a rule or the data (e.g. `ECR_IMAGE_NOT_AVAILABLE`,
`SECRET_VALUE_NOT_REPLICATED`, `DEPENDENCY_NOT_MIGRATABLE`).

### Migration phases

Phases are ordered by a **topological sort of the graph dependencies** (Kahn's
algorithm), not by a fixed service ranking. Foundation (network/identity) lands
before the resources that depend on it, and compute lands after data.

### API

```
POST /migration/analyze                                { sourceRegion, targetRegion }
GET  /migration/assessments/:id
GET  /migration/assessments/:id/resources/:resourceId
```

`POST /migration/analyze` responds with `{ assessmentId, status, summary,
resources, phases, blockers, warnings, highRiskResources, manualActions }`.

Run it (optionally pre-scanning a region so the graph is ready):

```bash
npm run build
SCAN_REGION=us-east-1 PORT=3000 npm run api:start
```

### Agent tools

`build_graph`, `get_infrastructure_graph`, `get_resource`, `get_dependencies`,
`get_dependents`, `get_impact`, `get_migration_rule`, `analyze_resource_migration`.

### Observability

Events: `MIGRATION_ANALYSIS_STARTED`, `RESOURCE_ANALYSIS_STARTED`,
`RESOURCE_ANALYSIS_COMPLETED`, `MIGRATION_BLOCKER_FOUND`,
`HIGH_RISK_RESOURCE_FOUND`, `MIGRATION_ANALYSIS_COMPLETED`,
`MIGRATION_ANALYSIS_FAILED` — each with assessmentId / resourceId / resourceType
/ regions. Never logs secrets or credentials.

---

## Phase 1 — Discovery (below)

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
