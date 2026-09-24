# Rodando o agente em IDEs (VS Code, Claude Desktop, Cursor…) sem o console web

Este guia configura o projeto para rodar **sem o console/frontend** (`api/`, `public/`), usando
diretamente o chat de uma IDE com suporte a MCP + agentes customizados. A "inteligência" do
projeto inteira mora nos **6 MCP servers** (protocolo aberto) — o console e o `kiro-cli` são
só uma forma de conversar com eles. Este guia troca essa forma pela nativa da sua IDE.

> Se você só quer usar o console (Kiro Crew), ignore este guia e siga o `README.md` normal.

## O que muda em relação ao fluxo do console

| Console (Kiro) | IDE (este guia) |
|---|---|
| `agents/*/agent.json` (formato Kiro) | `.vscode/mcp.json` (servers) + `.github/agents/*.agent.md` (prompt/persona) |
| `kiro-cli acp` spawnado pelo `api/acp-bridge.ts` | Chat nativo da IDE (Copilot Chat, Claude Desktop, Cursor…) |
| Credenciais via `POST /api/creds` (tela 1 do console) | Perfis nomeados em `~/.aws/credentials` (sem frontend nenhum) |
| Aprovação da migração = botão na UI | Aprovação = você responde "sim" no chat |

Nada muda em `domain/`, `infrastructure/`, `mcp/*` — só a camada de "quem fala com o agente".

> **Já vem pronto no repo**: `.vscode/mcp.json`, `.cursor/mcp.json` e
> `.github/agents/aws-migration-orchestrator.agent.md` já existem com o conteúdo deste guia.
> Não precisa copiar nada dos blocos de código abaixo — eles só documentam o que já está lá e
> onde mexer se quiser mudar algo (ex.: o perfil AWS, ver "Trocando o perfil AWS" mais abaixo).
>
> **Por que não tem uma pasta `.kiro/` aqui**: o `agents/*/agent.json` já É o equivalente Kiro
> (é o que o console/`kiro-cli` usa, instalado em `~/.kiro/agents`) — criar um `.kiro/` a mais
> no repo duplicaria a mesma config em dois lugares. Se algo mudar no prompt do orquestrador,
> mantenha `agents/aws-migration-orchestrator/agent.json` e `.github/agents/*.agent.md`
> sincronizados manualmente (são o mesmo prompt em dois formatos).

## Pré-requisitos (versões exatas)

| Ferramenta | Versão | Para que serve | Como instalar / verificar |
|---|---|---|---|
| **Node.js** | **>= 20.11.0** (LTS; testado no 22.x) | roda os 4 MCP servers, o `tsc` e os testes | [nodejs.org](https://nodejs.org/en/download) · `node -v` · o repo tem `.nvmrc` (`nvm use`) |
| **npm** | >= 10 | instala as dependências | vem com o Node · `npm -v` |
| **Python** | >= 3.10 | runtime do `uv`/`uvx` e do `cfn-lint` | [python.org](https://www.python.org/downloads/) · `python --version` |
| **uv / uvx** | **>= 0.8.12** | baixa e roda `aws-pricing-mcp` e `aws-api-mcp` | [instalação](https://docs.astral.sh/uv/getting-started/installation/) · `uv --version` · veja "Troubleshooting: uvx no Windows" |
| **AWS CLI** | v2 | `aws configure` grava os perfis em `~/.aws` | [instalação](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) · `aws --version` |
| **cfn-lint** | >= 1.0 (opcional) | valida os templates gerados (`validate_templates`) | `pip install cfn-lint` · se não estiver no PATH, aponte `CFN_LINT_PATH` |
| **IDE com MCP** | VS Code 1.99+ / Claude Desktop / Cursor / Windsurf | chat com o agente | — |

Versões travadas no `package.json` (não precisa instalar nada à mão — `npm ci` resolve):
TypeScript 5.8.3, `@modelcontextprotocol/sdk` 1.12.3, AWS SDK v3 (3.654–3.830), Jest 29.7,
Winston 3.17, Zod 3.25. Os MCP servers externos são pinados em
`awslabs.aws-api-mcp-server==1.5.4` e `awslabs.aws-pricing-mcp-server@latest`.

E uma conta AWS de origem (e, opcionalmente, uma de destino para migração cross-account).

## Passo 1 — Build do projeto

```powershell
git clone <repo> ; cd migration-mcp-server
npm run bootstrap  # checa .env, npm ci, build e agentes Kiro
```

Para onboarding de equipe em um clone novo, prefira `npm run bootstrap`: ele checa
pre-requisitos, instala dependencias, compila e instala os agentes Kiro. O fluxo completo esta em
[docs/TEAM_SETUP.md](TEAM_SETUP.md).

Isso gera `dist/mcp/*/src/index.js`, que é o que os `mcp.json` apontam. Depois de qualquer
alteração em `.ts`, rode `npm run build` de novo e reinicie os MCP servers.

Para trocar contas depois, rode `npm run env:configure` ou edite `.env` a partir de
`.env.example`.

## Onde ficam os artefatos de cada execução

Cada execução do pipeline cria **uma pasta própria, nomeada pelo projeto que está sendo
migrado**, sob `runs/` (ignorado pelo git):

```
runs/
└── portal-cliente/                                     # slug do nome do projeto
    └── 2026-09-22T14-30-05Z-123456789012-us-east-1/    # <timestamp>-<contaOrigem>-<região>
        ├── run.json                    # metadados: projeto, contas, regiões, timestamps
        ├── inventory/inventory.json    # discovery (scan_region)
        ├── inventory/total-inventory.json
        ├── graph/graph.json            # grafo de dependências
        ├── cfn/faithful.yaml           # CFN fiel gerado a partir do config real
        ├── cfn/adapted.yaml            # CFN adaptado para a conta/região destino
        └── docs/migration-manifest.md  # plano legível por humano
```

- **Criar a pasta**: peça ao agente, ou chame `start_migration_run(project: "portal-cliente")`
  no server `awsDiscovery`. Se você chamar `scan_region` sem run ativo, ele cria uma
  automaticamente (`aws-<conta>-<região>`) — mas passar `project` dá um nome melhor.
- **Descobrir onde está**: `get_current_run`. Para listar/retomar execuções antigas:
  `list_migration_runs` e `use_migration_run(runId)`.
- Os 4 MCP servers são processos separados e compartilham o run ativo por um ponteiro em
  `runs/current-run.json` — por isso todos escrevem na mesma pasta sem configuração extra.

**Mudar o local raiz**: `MIGRATION_RUNS_DIR` (absoluto ou relativo à raiz do repo). Já vem
definido como `${workspaceFolder}/runs` nos dois `mcp.json`.

**Fixar um diretório específico** (sai do esquema por execução): `INVENTORY_DIR`,
`TOTAL_INVENTORY_DIR`, `GRAPH_DIR`, `CFN_DIR`, `DOCS_DIR`. Se definidos, têm prioridade sobre a
pasta da execução — deixe em branco para o uso normal.

Ordem de resolução de qualquer caminho: parâmetro explícito da tool → variável de ambiente →
pasta da execução ativa → fallback legado `data/`.

## Passo 2 — Credenciais AWS (sem frontend)

O repo usa `.env` como configuracao local de source/target. Os MCP servers sao iniciados por
`scripts/run-with-env.mjs`, que carrega `.env` antes de subir servidores Node e servidores `uvx`.

Voce pode usar perfis nomeados ou credenciais STS temporarias no `.env`.

Exemplo com perfis nomeados:

```env
AWS_PROFILE=migration-source
AWS_REGION=us-east-1
AWS_PROFILE_TARGET=migration-target
AWS_REGION_TARGET=sa-east-1
MIGRATION_TARGET_ACCOUNT_ID=123456789012
```

Exemplo com credenciais temporarias:

```env
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=ASIA...
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=...

AWS_REGION_TARGET=sa-east-1
AWS_ACCESS_KEY_ID_TARGET=ASIA...
AWS_SECRET_ACCESS_KEY_TARGET=...
AWS_SESSION_TOKEN_TARGET=...
MIGRATION_TARGET_ACCOUNT_ID=123456789012
```

Quando existem credenciais cruas no `.env`, o wrapper cria perfis locais em `.aws/credentials`:
`migration-source` e `migration-target`. Essa pasta e ignorada pelo Git.

### 2.1 Criar o perfil de origem

```powershell
aws configure --profile migration-source
# AWS Access Key ID / Secret Access Key / região (ex: us-east-1)
```

Se as credenciais forem temporárias (STS, começam com `ASIA...`), também é preciso o session token,
que o `aws configure` não pergunta — adicione depois:

```powershell
aws configure set aws_session_token "SEU_SESSION_TOKEN" --profile migration-source
```

> Credenciais STS expiram em horas. Repita este passo quando expirar, ou use `aws configure sso`
> para um login que se renova sozinho (recomendado para uso contínuo).

### 2.2 (Opcional) Perfil de destino, para migração cross-account

```powershell
aws configure --profile migration-target
aws configure set aws_session_token "SEU_SESSION_TOKEN_DESTINO" --profile migration-target
```

Guarde também o **Account ID** da conta destino — vai para `MIGRATION_TARGET_ACCOUNT_ID` no `.env` (não é segredo, só um identificador).

### 2.3 Nunca coloque chaves cruas no `mcp.json`

O `mcp.json` e versionado. Coloque perfis ou credenciais somente no `.env` local, que fica fora
do Git. **Nunca** cole a secret key diretamente no `env` do `mcp.json`.

## Passo 3 — `.vscode/mcp.json`

Já existe em [.vscode/mcp.json](../.vscode/mcp.json) (e o equivalente para Cursor em
[.cursor/mcp.json](../.cursor/mcp.json), mesmo conteúdo com a chave `mcpServers` no lugar de
`servers`). Esses arquivos chamam `node scripts/run-with-env.mjs ...` para todos os MCP servers,
entao o `.env` local e carregado antes de iniciar discovery, graph, analysis, planner, pricing e
aws-api.

Variáveis de ambiente usadas acima:

| Variável | Onde | Default | O que faz |
|---|---|---|---|
| `MIGRATION_PROJECT_ROOT` | 4 servers Node | detectado pelo `package.json` | raiz do repo, usada para resolver caminhos relativos |
| `MIGRATION_RUNS_DIR` | 4 servers Node | `<repo>/runs` | raiz onde cada execução cria sua pasta |
| `AWS_PROFILE` / `AWS_REGION` | discovery, planner, pricing, api | `.env` | conta/região de ORIGEM |
| `AWS_PROFILE_TARGET` / `AWS_REGION_TARGET` | aws-api e agente | `.env` | conta/região de DESTINO |
| `AWS_API_MCP_WORKING_DIR` | `awsApi` | temp do próprio server | pasta onde o `call_aws` resolve caminhos de arquivo (ex.: `--template-file`) |
| `LOG_LEVEL` | 4 servers Node | `info` | nível do Winston |
| `FASTMCP_LOG_LEVEL` | `awsPricing` | `ERROR` | nível de log do server Python |

> O `args` de `awsPricing`/`awsApi` usa `--from <pacote> <pacote>.exe` em vez de só `<pacote>@latest`
> por causa de um bug do `uvx` no Windows com nomes de pacote com ponto — veja "Troubleshooting:
> uvx no Windows" logo abaixo. Em macOS/Linux o `uvx <pacote>@latest` simples também funciona,
> mas a forma `--from`/`.exe` funciona nos três SOs, então é a usada por padrão neste repo.

Não é preciso criar nenhuma pasta à mão: `runs/<project>/<runId>/` e todas as subpastas são
criadas na primeira execução.

### Trocando source/target

Edite `.env` ou rode:

```powershell
npm run env:configure
```

Depois reinicie os MCP servers na IDE. Se estiver usando credenciais STS no `.env`, o wrapper
regenera `.aws/credentials` localmente quando os MCP servers sobem.

`infrastructureGraph` e `migrationAnalysis` não recebem `AWS_PROFILE` porque não chamam a AWS
diretamente — só leem a pasta da execução em disco.

Casos comuns:
- **Perfil novo**: `aws configure --profile <nome>` e informe `<nome>` no `.env`.
- **SSO em vez de chaves fixas**: `aws configure sso --profile <nome>`; antes de abrir a IDE,
  `aws sso login --profile <nome>`. Nada muda no `mcp.json`.
- **Conta destino (cross-account)**: configure `AWS_PROFILE_TARGET`/`AWS_REGION_TARGET`, ou use
  credenciais `*_TARGET` no `.env` para gerar o perfil local `migration-target`.

## Passo 4 — Custom agent (a "persona"/prompt do orquestrador)

**Fonte da verdade**: [.github/agents/aws-migration-orchestrator.agent.md](../.github/agents/aws-migration-orchestrator.agent.md).
Já vem no repo — não precisa criar nada. O bloco abaixo é só um extrato histórico; se houver
divergência, vale o arquivo.

```markdown
---
description: Orquestrador único para discovery → graph → migração AWS (read-only até a aprovação)
name: aws-migration-orchestrator
tools: ['awsDiscovery/*', 'infrastructureGraph/*', 'migrationAnalysis/*', 'migrationPlanner/*', 'awsPricing/*', 'awsApi/*', 'terminal']
---

You are the AWS Migration Orchestrator — the SINGLE entry point for AWS discovery, graphing,
migration planning and (approved) execution. The user talks only to you. You drive specialist
MCP servers and run AWS commands, and you RUN THE WHOLE PIPELINE AUTOMATICALLY up to the
approval gate — never make the user ask for each step.

## How you run AWS commands (IMPORTANT — read first)

There is NO `aws` CLI binary available to you directly. NEVER try to run `aws ...` as a raw
shell command — use the awsApi tool instead:
- Use awsApi's call_aws with the full command string, e.g. call_aws("aws ec2 describe-instances --region us-east-1").
- File paths in a call_aws command resolve against the MCP server's own workdir, NOT your workspace.
  Before any command that reads a template file (e.g. cloudformation deploy --template-file),
  write the .yaml to the workdir path the tool reports and reference it by its basename there.
- `aws ec2 wait ...` (and other `wait` subcommands) are NOT supported. For "wait until
  available/complete", poll: call the matching describe every ~15s in a loop and check the
  state field, with a sane timeout.

## The discovery & scoping pipeline (run this FIRST, automatically, when the user asks to migrate)

Discovery, inventory, graph, assessment and planning ALWAYS run against the SOURCE
account/region. Run steps 1–3 automatically (all read-only), then STOP at step 4 to ask the
scope question before any assessment/CFN.

1. DISCOVERY (fidelity) — scan_region(sourceRegion) to collect the FULL config of the 27
   supported types via the collectors (reuse if already scanned this session).
2. TOTAL INVENTORY (radar) — call awsDiscovery's scan_total_inventory(sourceRegion) AFTER
   scan_region. Trust its output: BROAD DISCOVERY (Resource Explorer / Tagging API), CONFIG
   ENRICHMENT (AWS Config → FIDELITY_VIA_CONFIG or RADAR_ONLY), RELEVANCE CLASSIFICATION
   (CORE / SUPPORTING / NOISE). Never re-judge this yourself — it's rule-based and tested.
3. GROUP INTO WORKLOADS — work over CORE + SUPPORTING items only. Group using ALL of: (a)
   structural graph clusters, (b) tags (Application/Project/Stack/cfn-stack-name), (c) naming
   prefixes, (d) IAM role policy ARNs. Only what's left after (a)–(d) is "avulso" (loose), never
   "sem relação".
4. PRESENT & ASK SCOPE (STOP here) — show workloads, RADAR_ONLY vs FIDELITY_VIA_CONFIG counts,
   NOISE collapsed to a count, and loose resources. Ask: "Quer migrar um workload específico
   (qual?) ou a conta inteira?" and WAIT for the answer.

After the user picks the scope:
5. ASSESSMENT — analyze_resource_migration(source, target) for the scoped resources.
6. PRICING — target monthly cost + one-time migration cost via awsPricing.
7. DIAGRAM — generate the .drawio for the scoped workload(s).
8. PLANNING — generate_migration_manifest(...) then generate_faithful_cfn(resources).

## The approval gate (STOP here)

After step 6, STOP and show: what will be migrated, phases (networking → data → compute →
validate), estimated time/cost, the FULL faithful CloudFormation YAML, the data-migration
sequence, and anything that cannot be automated (say why). Then ask: "Posso executar a
migração?" and WAIT. NEVER touch the target account/region before explicit approval.

## Execution (only AFTER explicit approval)

Every AWS command via awsApi's call_aws:
1. Networking phase — deploy the faithful network stack (VPC, Subnet, SG, IGW, RouteTable).
   Poll until CREATE_COMPLETE.
2. Data phase — create-image/create-snapshot in source, copy to target, poll until available.
3. Compute phase — adapt the faithful CFN with the new networking/data IDs, deploy, poll.
4. Validation — verify each created resource is healthy.

Report status after EACH phase. On failure: STOP, show the error, offer rollback
(cloudformation delete-stack) — never auto-continue past a failure.

## Cross-account migration

Detect cross-account mode when the user names a target account id OR
MIGRATION_TARGET_ACCOUNT_ID is set. Discovery/graph/assessment/planning always read the SOURCE
account. For AWS calls, pick the account per command with named profiles:
SOURCE = call_aws("aws … --profile migration-source --region <sourceRegion>");
TARGET = call_aws("aws … --profile migration-target --region <targetRegion>").
FIRST verify both identities with sts get-caller-identity on each profile and confirm the
target Account matches MIGRATION_TARGET_ACCOUNT_ID. If the migration-target profile is missing,
STOP and tell the user to run `aws configure --profile migration-target` first.

Data phase becomes SHARE (source profile: modify-image-attribute / modify-snapshot-attribute /
modify-db-snapshot-attribute granting the target account) → COPY (target profile: copy-image /
copy-snapshot / copy-db-snapshot). Flag KMS-encrypted artifacts with a custom CMK — the key
must also grant the target account.

Networking and compute phases run entirely against the TARGET account/region
(--profile migration-target). Same-account (cross-region only) migrations skip this section.

## Safety
- The SOURCE is never modified. create-image / create-snapshot are non-destructive reads.
- NEVER delete or terminate source resources — decommissioning is a separate, later request.
- Rollback = delete the target stacks.
- If any AWS call returns an expired/invalid-credentials error, STOP immediately and tell the
  user to renew the credentials (`aws configure set aws_session_token ...` or `aws sso login`) —
  do not retry in a loop.

## Response style
- Narrate steps 1–3 concisely as you run them; they're read-only, don't ask permission for them.
- At the approval gate, show the real CFN, not a summary of a summary.
- Never present "manual actions" for things you can execute yourself.
- Be honest about UNKNOWNs and anything the data does not support.
```

> O prompt do `.agent.md` e o campo `prompt` de
> `agents/aws-migration-orchestrator/agent.json` são o mesmo conteúdo em dois formatos (VS Code
> vs. Kiro). Ao editar um, sincronize o outro. Os nomes de tool (`awsDiscovery/*` etc.) batem
> com os nomes de servers do `mcp.json` do passo 3.

### Agentes especializados (opcional)

Se preferir agentes menores e focados (equivalentes a `aws-infrastructure-discovery`,
`infrastructure-graph-agent`, `migration-analysis-agent`), crie um `.agent.md` por um em
`.github/agents/`, copiando o campo `prompt` de cada `agents/*/agent.json` correspondente e
listando só o(s) MCP server(s) daquele agente em `tools:`. Não é necessário para usar o
orquestrador — ele já cobre o pipeline inteiro sozinho.

## Passo 5 — Usar

No VS Code: abra o Chat (`Ctrl+Alt+I`), mude para Agent mode, selecione **aws-migration-orchestrator**
no dropdown de agentes, e peça, por exemplo:

```
Migre o workload tstsrv de us-east-1 para sa-east-1
```

Na primeira execução, o VS Code vai pedir para confirmar que você confia em cada MCP server —
confirme uma vez por servidor. Chamadas de tool (inclusive as que criam recursos) pedem
aprovação individual por padrão — é uma camada de segurança a mais que o console não tinha
(lá, `--trust-all-tools` liberava tudo de uma vez).

## Passo 6 — Outras IDEs

O `.vscode/mcp.json` é específico do VS Code, mas o conteúdo (`servers`) é quase idêntico ao
formato de outras IDEs. Locais de config equivalentes:

| IDE | Arquivo | Observação |
|---|---|---|
| Claude Desktop | Windows: `%APPDATA%\Claude\claude_desktop_config.json` | Chave raiz é `mcpServers`, não `servers`; sem `${workspaceFolder}` — use caminho absoluto |
| Cursor (projeto) | `.cursor/mcp.json` | Mesma chave `mcpServers`; sem custom agent — cole o prompt do passo 4 nas Cursor Rules (`.cursor/rules`) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | Chave `mcpServers`; prompt vai em "Windsurf Rules" |

Nenhuma dessas IDEs lê `.github/agents/*.agent.md` — nelas, cole o corpo do prompt do passo 4
no mecanismo de instruções/regras próprio da ferramenta. O VS Code também consegue descobrir
automaticamente config de MCP dessas outras ferramentas via `chat.mcp.discovery.enabled`, se
preferir manter só um `mcp.json` "mestre".

## Troubleshooting: `uvx` no Windows (`awsPricing`/`awsApi` não conectam)

Se o log do MCP mostrar algo como:

```
error: Failed to spawn: `awslabs.aws-pricing-mcp-server`
  Caused by: program not found
```

o pacote foi instalado (`Installed NN packages...`), mas o `uvx` não achou o `.exe` gerado.
Isso é um bug conhecido do `uv` em versões **< 0.8.12** no Windows: ao resolver a extensão do
executável, o `uv` corta tudo depois do primeiro ponto do nome do pacote (`awslabs.aws-pricing-mcp-server.exe`
vira `awslabs.exe`), então nomes de pacote com ponto (todos os `awslabs.*-mcp-server`) falham —
veja [astral-sh/uv#15165](https://github.com/astral-sh/uv/issues/15165) (corrigido na v0.8.12).

**Diagnóstico e correção:**

```powershell
uv --version   # se < 0.8.12, é essa a causa
pip install --upgrade uv   # se instalado via pip (confirme com: Get-Command uv)
uv --version   # confirme >= 0.8.12
```

Depois de atualizar, reinicie os MCP servers (`MCP: List Servers` → `Restart` no VS Code, ou
reabra a IDE). Os `args` de `awsPricing`/`awsApi` neste repo já usam a forma
`--from <pacote>@latest <pacote>.exe`, que é a forma recomendada pela própria AWS para Windows
— mas ela só funciona com um `uv` atualizado; sem isso, nenhuma variação de `args` resolve.

## Limitações deste modo (vs. console)

- Sem streaming SSE de tool calls formatado — a própria IDE já mostra isso nativamente, então
  não é uma perda funcional, só visual.
- Sandbox de MCP server (isolamento de filesystem/rede) não existe no Windows, só macOS/Linux.
- Sem tela de credenciais — credenciais são geridas fora da IDE, via `aws configure` (passo 2).
- `api/`, `public/` e `agents/*/agent.json` continuam existindo no repo para quem usa o console
  Kiro; os dois caminhos coexistem sem conflito (um não lê o config do outro).

## Checklist de segurança

- [ ] `.vscode/mcp.json` não contém nenhuma `aws_secret_access_key`/`aws_session_token` em texto
      plano (use perfis nomeados ou `${input:...}`).
- [ ] `~/.aws/credentials` tem permissão restrita ao seu usuário (padrão do `aws configure`).
- [ ] Nunca commitar `~/.aws/credentials` nem um `mcp.json` com chaves reais.
- [ ] Revisado o prompt do agente antes de rodar em produção — ele executa comandos reais assim
      que você aprovar a migração.
