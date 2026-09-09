# AWS Migration MVP — Discovery → Graph → Faithful CFN → Migration

An AWS infrastructure **migration platform** driven by Kiro Crew agents: it discovers a source account, builds a dependency graph, groups resources into workloads, generates a **100%-faithful CloudFormation** template, and (after explicit approval) **executes** the migration cross-region or cross-account — all watchable through a visual console.

**Pipeline**: discover → total inventory → graph/workloads → assess → price → faithful CFN → **approval gate** → phased execution.
**Safety**: the SOURCE account is never modified. Everything up to the approval gate is read-only / file-generating; only the TARGET account has resources created, and only after the user says so.

## Architecture

```
        Browser (Migration Console — Claro Empresas)
                        │  HTTP + SSE
                        ▼
        ACP Bridge (api/, zero migration logic)
                        │  spawns: kiro-cli acp --agent aws-migration-orchestrator
                        ▼
        ┌──────────── aws-migration-orchestrator ────────────┐
        │        (single brain; owns the whole pipeline)      │
        └──┬─────────┬──────────┬──────────┬────────┬─────────┘
           ▼         ▼          ▼          ▼        ▼        ▼
      discovery   graph    migration-  migration-  aws-    aws-api
        MCP        MCP     analysis MCP planner MCP pricing  MCP
           │         │          │          │      (uvx)    (uvx)
           ▼         ▼          ▼          ▼        └─ AWS Pricing + AWS CLI (call_aws)
       AWS APIs  inventory.json ←→ graph.json   IaC Generator + cfn-lint
      (read-only)  (shared JSON file store, lock-free)
```

- **The console is the visual face of the orchestrator, NOT a reimplementation.** It relays the user's message to the agent over ACP (`kiro-cli acp`) and streams the agent's narration + tool calls back via SSE. All migration logic lives in the orchestrator + its 6 MCP servers.
- **6 MCP servers:** 4 custom Node servers (discovery, infrastructure-graph, migration-analysis, migration-planner) run from `dist/`; 2 AWS Labs servers via `uvx` (aws-pricing, aws-api). All AWS commands the orchestrator runs go through `@aws-api-mcp/call_aws` (there is no `aws` CLI binary on this host).

## The orchestrator pipeline

When the user asks to migrate, the orchestrator runs automatically up to the approval gate:

1. **Discovery (fidelity)** — `scan_region` collects the full config of the 27 supported types via the collectors. This is what makes the CFN faithful.
2. **Total inventory (radar)** — lists EVERYTHING in the account (including types with no collector) via `call_aws`: AWS Resource Explorer if enabled, else `resourcegroupstaggingapi get-resources`. Each item is tagged **FIDELITY** (config captured) or **RADAR-ONLY** (seen but not yet recreatable — flagged honestly).
3. **Group into workloads** — the graph only has infrastructure edges, so data-plane links (Lambda↔bucket/table) aren't in it. Grouping uses four signals so nothing is falsely "orphan": (a) structural graph clusters, (b) tags (Application/Project/Stack/cfn-stack-name), (c) naming prefixes, (d) IAM role policy ARNs. Leftovers are "avulsos", never "unrelated".
4. **Ask scope (STOP)** — presents the grouped inventory and asks: **migrate a specific workload or the whole account?** Waits for the answer.
5. **Assessment** — `analyze_resource_migration(source, target)` for the chosen scope (deterministic per-type rules).
6. **Pricing** — target monthly cost + one-time migration cost via aws-pricing-mcp.
7. **Diagram** — `.drawio` per application cluster.
8. **Faithful CFN** — `generate_migration_manifest` + `generate_faithful_cfn` (CloudFormation IaC Generator reading real config via AWS Config → 100% faithful, no placeholders), adapted for the target.

**Approval gate:** the orchestrator stops, shows the full faithful CFN + manifest + data-migration sequence, and asks *"Posso executar a migração?"*. It never touches the target before explicit approval.

**Execution (after approval), phase by phase via `call_aws`:** networking stack → data (create-image/copy-image, snapshots) → compute stack → validate. Rollback = `delete-stack`. Reports status after each phase; stops on failure.

## Cross-region vs cross-account

- **Cross-region (same account):** validated end-to-end twice (tstsrv us-east-1→sa-east-1). Uses the source credentials throughout.
- **Cross-account (Option B — separate credentials):** the console's credential setup (`POST /api/creds`) writes named AWS profiles `migration-source` and `migration-target` (plus `MIGRATION_TARGET_ACCOUNT_ID`); the orchestrator picks an account per command with `--profile`. The DATA phase becomes **SHARE** (source creds: `modify-image-attribute --launch-permission`, snapshot share) → **COPY** (target creds: `copy-image`/`copy-snapshot`). KMS-encrypted artifacts with a custom CMK need the source key to grant the target account — flagged automatically.

## Credentials setup (via the console)

Nothing is edited in `~/.aws` by hand. In the console (step 1), the user pastes the temporary STS credentials for the **source** account and, for cross-account, the **destination** account + its Account ID. `POST /api/creds` (the Node runtime, not the agent) writes:
- the `AWS_*` / `AWS_*_TARGET` env of the 4 AWS-touching MCPs, and
- the `migration-source` / `migration-target` profiles into the shared AWS credentials/config files (atomic, chmod 600).

Values arrive from the user over HTTP; the response is masked (`key …XXXX`), never the secret. STS credentials expire in hours — re-paste in the console to refresh.

## Resource coverage (27 types, 19 collectors)

network (VPC, Subnet, RouteTable, IGW, NAT, SecurityGroup), ec2, ebs, eip, ecs (Cluster+Service), elb (ALB/NLB+TargetGroup), rds (Instance+Cluster), s3, lambda, iam, secrets, cloudwatch logs, route53, dynamodb, ecr, sqs, sns, elasticache, cloudfront. Every type has a **deterministic** migration rule (RECREATE / SNAPSHOT_RESTORE / REPLICATE / NO_ACTION / MANUAL) with a fixed risk level — no LLM chooses strategies. Types without a collector are still surfaced by the radar step and flagged RADAR-ONLY.

## Quick Start

```bash
cd /home/kirocrew/workplace/kirocrew-workspace/aws-migration-mvp
export PATH="/home/kirocrew/.local/nodejs/bin:$PATH"
npm install
npm run build
```

### Run the console (visual)

```bash
PORT=8090 HOST=0.0.0.0 ORCHESTRATOR_CWD=/home/kirocrew/.kiro/crew/workspace node dist/api/main.js
```

The console runs inside the Kiro Crew container. To reach it from your machine, publish the port with a socat sidecar on the Docker host (the container IP can change on restart — check with `hostname -I` or use the container name):

```bash
docker rm -f kiro-console-proxy 2>/dev/null
docker run -d --name kiro-console-proxy -p 127.0.0.1:8080:8080 --network bridge \
  alpine/socat tcp-listen:8080,fork,reuseaddr tcp-connect:<container-name-or-ip>:8090
# then open http://localhost:8080
```

Steps in the UI: **1 Credenciais** → **2 Migração** → **3 Execução** (live chat with the orchestrator, a floating tool drawer, and a pipeline header showing source→target accounts).

### Or drive the orchestrator directly

Open a chat with `aws-migration-orchestrator` in the dashboard and ask, e.g.: `Migre o workload tstsrv de us-east-1 para sa-east-1`.

### Tests

```bash
npm test                  # unit suite (128 tests)
npm run test:integration  # real AWS scan (requires credentials)
```

## Project structure

```
aws-migration-mvp/
├── agents/aws-migration-orchestrator/agent.json   # versioned orchestrator prompt (sync w/ ~/.kiro live)
├── api/
│   ├── main.ts / server.ts        # HTTP server (binds 127.0.0.1 by default; 0.0.0.0 behind socat)
│   ├── acp-bridge.ts              # spawns kiro-cli acp, relays session/update + tool I/O over SSE
│   └── creds.ts                   # POST /api/creds: writes MCP env + AWS profiles (source/target)
├── public/                        # console — index.html + app.js (Claro identity, tool drawer, pipeline)
├── mcp/
│   ├── aws-discovery/             # discovery MCP (19 collectors)
│   ├── graph-agent/               # graph MCP (query/traversal tools)
│   ├── migration-agent/           # migration-analysis MCP
│   └── planner-agent/             # migration-planner MCP (manifest, faithful CFN, validate, adapt)
├── domain/
│   ├── resources/ relationships/ graph/
│   └── migration/                 # rules, analyzer, planner, iac-generator, data-migration, manifest, validator
├── infrastructure/aws/            # SDK clients, scanner, collectors, logger
├── repositories/                  # File-backed inventory + graph stores (atomic, lock-free)
└── tests/unit/                    # 128 tests
```

## migration-planner MCP tools

`generate_migration_plan`, `generate_cfn_templates` (scaffold/fallback), `validate_templates` (cfn-lint), `get_plan_summary`, `generate_migration_manifest`, `generate_faithful_cfn` (IaC Generator), `adapt_template_for_target`.

## Notes & known limitations

- **Faithful CFN** uses the CloudFormation IaC Generator + AWS Config (recording ON in the source account) — reproduces SG rules, UserData, MetadataOptions verbatim.
- **`aws-api-mcp` version pin:** the AWS Labs server is pinned (`uvx --with "mcp>=1.23,<2" awslabs.aws-api-mcp-server==1.5.4`) because `mcp` 2.x renamed `McpError`→`MCPError` and broke the import. `aws-pricing-mcp` is still `@latest` (pinnable if it ever breaks the same way).
- **Graph has no data-plane edges** (READS_FROM/WRITES_TO) — who reads/writes each bucket/table isn't derivable from the inventory alone; the workload-grouping step compensates with tags/naming/IAM signals.
- **RADAR-ONLY resources** (e.g. EventBridge Rules, SSM Parameters, MediaConvert) are listed but not yet faithfully recreatable — they need a dedicated collector or a manual step, stated explicitly, never dropped silently.
- **Cross-region dependencies** and VPC Peering / Transit Gateway topology are not yet derived as edges.

## Roadmap

- [ ] Validate cross-account end-to-end with two real accounts
- [ ] Dedicated collectors for EventBridge Rules and SSM Parameter Store (close the FIDELITY gap)
- [ ] Architecture-design step (target blueprint: RDS→Aurora, EC2→Fargate) before assessment
- [ ] Execution progress bar (networking→data→compute→validate) + created-resource counter in the console
- [ ] Cost data integration (Cost Explorer) and incremental scan (diff vs previous inventory)
