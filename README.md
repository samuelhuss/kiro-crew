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
      (read-only)   runs/<projeto>/<runId>/  (shared JSON file store, lock-free)
```

- **The console is the visual face of the orchestrator, NOT a reimplementation.** It relays the user's message to the agent over ACP (`kiro-cli acp`) and streams the agent's narration + tool calls back via SSE. All migration logic lives in the orchestrator + its 6 MCP servers.
- **6 MCP servers:** 4 custom Node servers (discovery, infrastructure-graph, migration-analysis, migration-planner) run from `dist/`; 2 AWS Labs servers via `uvx` (aws-pricing, aws-api). All AWS commands the orchestrator runs go through `call_aws` on the aws-api MCP, so credentials and region are resolved in one place.
- **Artefatos por execução:** cada run escreve em `runs/<projeto>/<timestamp>-<conta>-<região>/`. Os 4 servers Node são processos separados e compartilham a pasta ativa por um ponteiro em `runs/current-run.json`.

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

## Quick Start (Onboarding)

Para configurar sua máquina e os agentes (Kiro/VS Code), siga **exatamente** estes três passos:

**1. Clone e Prepare o Ambiente:**
Não rode `npm install`. O script de bootstrap cuidará de tudo (instalação, compilação e configuração do Kiro).

```bash
git clone <repo> && cd migration-mcp-server
npm run bootstrap
```

**2. Configure as Credenciais AWS:**
Use o assistente iterativo para preencher as contas de origem e destino no seu arquivo `.env`:

```bash
npm run env:configure
```

**3. Inicie os Agentes:**
Abra seu Kiro (ou a aba do Copilot no VS Code). Os agentes e os servidores MCP já estarão conectados e prontos para uso.

👉 **Tem dúvidas ou deu erro?** Leia o [Guia Completo de Onboarding da Equipe](docs/TEAM_SETUP.md) para pré-requisitos exatos, troubleshooting e a explicação profunda das credenciais.

Para onboarding de equipe, incluindo Windows/Linux/macOS, fluxo manual, credenciais AWS e envio
para o Git, veja [docs/TEAM_SETUP.md](docs/TEAM_SETUP.md).

Atalhos úteis:

```bash
npm run bootstrap -- --dry-run   # valida sem instalar/escrever agentes
npm run doctor                   # checa pré-requisitos
npm run env:configure            # configura/troca source e target no .env local
npm run env:check                # verifica se .env tem origem configurada
npm run setup                    # legado: npm ci && npm run build
```

### Usar direto na IDE (recomendado — sem console)

`.vscode/mcp.json` e `.cursor/mcp.json` já vêm configurados com `${workspaceFolder}` e
carregam o `.env` local antes de iniciar os MCP servers. Abra o chat em Agent mode, escolha o agente
**aws-migration-orchestrator** e peça, por exemplo:
`Migre o workload tstsrv de us-east-1 para sa-east-1`. Guia completo: [docs/IDE_SETUP.md](docs/IDE_SETUP.md).

### Usar no Kiro (agents/*/agent.json)

Os `agent.json` do repo usam o placeholder `{{PROJECT_ROOT}}`. O instalador faz a configuração completa para o Kiro:
1. Copia os agentes para `~/.kiro/agents` resolvendo o caminho absoluto.
2. Cria e preenche o `.kiro/settings/mcp.json` para configurar os servidores MCP automaticamente.
3. Cria a pasta `runs/` (necessária para os MCPs iniciarem).

```bash
npm run agents:install              # ou: npm run agents:install -- --out <dir> / --dry-run
```

### Onde ficam os artefatos gerados

Cada execução cria a sua própria pasta, nomeada pelo projeto que está sendo migrado:

```
runs/<projeto>/<timestamp>-<contaOrigem>-<região>/
├── run.json                    # metadados da execução
├── inventory/inventory.json    # discovery
├── inventory/total-inventory.json
├── graph/graph.json            # grafo de dependências
├── cfn/faithful.yaml           # CFN fiel + cfn/adapted.yaml (adaptado ao destino)
└── docs/migration-manifest.md  # plano legível
```

Peça `start_migration_run(project)` antes do primeiro scan para nomear a pasta (se não, ela é
criada automaticamente como `aws-<conta>-<região>`). Use `get_current_run` para ver o caminho,
`list_migration_runs` / `use_migration_run` para voltar a uma execução anterior. A raiz é
configurável por `MIGRATION_RUNS_DIR` (default `<repo>/runs`, ignorado pelo git).

### Run the console (visual, opcional)

```bash
PORT=8090 HOST=127.0.0.1 node dist/api/main.js
# ou, para expor na rede: HOST=0.0.0.0
```

Steps in the UI: **1 Credenciais** → **2 Migração** → **3 Execução** (live chat with the orchestrator, a floating tool drawer, and a pipeline header showing source→target accounts).

### Tests

```bash
npm test                  # unit suite
npm run test:integration  # real AWS scan (requires credentials)
```

## Project structure

```
migration-agent/
├── .vscode/mcp.json .cursor/mcp.json              # config MCP por IDE (usa ${workspaceFolder})
├── .github/agents/*.agent.md                      # persona do orquestrador no VS Code
├── agents/aws-migration-orchestrator/agent.json   # mesma persona no formato Kiro ({{PROJECT_ROOT}})
├── scripts/install-agents.mjs                     # resolve {{PROJECT_ROOT}} e instala em ~/.kiro/agents
├── api/
│   ├── main.ts / server.ts        # HTTP server (binds 127.0.0.1 by default)
│   ├── acp-bridge.ts              # spawns kiro-cli acp, relays session/update + tool I/O over SSE
│   └── creds.ts                   # POST /api/creds: writes MCP env + AWS profiles (source/target)
├── public/                        # console — index.html + app.js (Claro identity, tool drawer, pipeline)
├── mcp/
│   ├── aws-discovery/             # discovery MCP (19 collectors) + tools de run
│   ├── graph-agent/               # graph MCP (query/traversal tools)
│   ├── migration-agent/           # migration-analysis MCP
│   └── planner-agent/             # migration-planner MCP (manifest, faithful CFN, validate, adapt)
├── domain/
│   ├── resources/ relationships/ graph/
│   └── migration/                 # rules, analyzer, planner, iac-generator, data-migration, manifest, validator
├── infrastructure/
│   ├── aws/                       # SDK clients, scanner, collectors, logger
│   └── run/run-context.ts         # pasta por execução: runs/<projeto>/<runId>/
├── repositories/                  # File-backed inventory + graph stores (atomic, lock-free)
└── runs/                          # artefatos gerados (git-ignored)
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
