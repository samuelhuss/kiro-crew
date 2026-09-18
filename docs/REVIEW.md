# Avaliação Técnica — AWS Migration MVP (kiro-crew)

> Revisão de arquitetura, práticas de codificação e segurança.
> Data: 2026-09-18. Validado com `npm install`, `tsc --noEmit`, `npm test` e `npm audit` (não só leitura de código).

## 1. O que o projeto faz

Plataforma de migração de infraestrutura AWS orquestrada por agentes de IA (Kiro Crew/ACP): descobre uma conta AWS (read-only), monta um grafo de dependências, agrupa recursos em "workloads", gera CloudFormation fiel (via IaC Generator) e — só depois de aprovação humana explícita — executa a migração cross-region/cross-account, com um console web (SSE) mostrando o progresso. A UI é uma casca fina: toda a lógica fica no agente orquestrador + 6 MCP servers.

## 2. Arquitetura — pontos fortes

- **Separação de camadas exemplar**: `domain/` (puro, sem I/O), `infrastructure/aws/` (SDK), `repositories/` (persistência), `mcp/*` (protocolo), `api/` (HTTP/bridge). DDD bem aplicado, não só nominal — `analyzer.ts`, `rules.ts`, `planner.ts` não fazem chamadas AWS.
- **Regras de migração determinísticas**: cada `ResourceType` tem uma função pura `evaluate(ctx) → RuleResult`; nenhuma decisão de estratégia é "adivinhada" por LLM — só `MANUAL`/`UNKNOWN` explícito quando não há certeza.
- **Análise em duas passadas** (`analyzer.ts`): avalia cada recurso isoladamente e depois propaga risco/status pelas dependências — evita o erro de "recurso limpo depende de recurso bloqueado mas aparece como OK".
- **Persistência em arquivo com escrita atômica** (`file-infrastructure.repository.ts`, `creds.ts`): padrão temp-file + rename, com a decisão de descartar Kuzu embarcado bem documentada (trava exclusiva de diretório).
- **Logger isolado em stderr**: stdout reservado ao JSON-RPC do MCP — detalhe sutil e corretamente tratado.
- **TypeScript rigoroso**: `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` ativados e respeitados — `tsc --noEmit` passa limpo.
- **Testes**: suíte real rodada — **128/128 testes passando**, batendo com o que o README promete.
- **Documentação**: README e `docs/MIGRATION_CONSOLE_DESIGN.md` descrevem invariantes de segurança (conta fonte nunca é modificada, approval gate) tanto em prosa quanto no prompt do agente.

## 3. Achados — por severidade

### 🔴 Crítico

1. **Injeção de código via `node -e` com interpolação de string** — [domain/migration/validator.ts](../domain/migration/validator.ts) (`validateWithAws`, `createDryRunChangeset`, linhas ~160-280)
   Constroem um script JS via template string interpolando `region`, `templatePath`, `stackName` e `parameters` direto no código executado (`exec('node', ['-e', \`...\`])`). Qualquer um desses valores contendo aspas/backticks quebra para fora da string e executa código arbitrário — OWASP A03 (Injection). `stackName`/`parameters` podem vir de nomes de recursos/tags da conta AWS ou de entrada do usuário no pipeline.
   → **Corrigir**: usar `@aws-sdk/client-cloudformation` diretamente in-process (já é dependência do projeto) em vez de spawnar `node -e`. Remove também o `cwd` hardcoded.

2. **Endpoints sem autenticação expostos com `HOST=0.0.0.0`**
   O README instrui rodar `HOST=0.0.0.0` e publicar a porta via socat para acesso remoto. `/api/creds` (escreve credenciais AWS em disco) e `/api/chat` (dispara migrações reais via o orquestrador) não têm autenticação, CORS check ou rate limiting ([api/server.ts](../api/server.ts)). Qualquer host que alcance a porta pode injetar credenciais AWS ou iniciar uma migração.
   → **Corrigir**: exigir token/segredo compartilhado quando não vinculado a `127.0.0.1`; nunca expor sem VPN/proxy autenticado.

### 🟠 Alto

3. **Caminhos absolutos hardcoded de um único container** (`/home/kirocrew/...`) em `agents/*/agent.json`, [domain/migration/validator.ts](../domain/migration/validator.ts) (`cfn-lint` path, `cwd` do `exec`). Quebra portabilidade; inconsistente com o padrão `process.env[...] ?? default` já usado em `creds.ts`/`main.ts`.

4. **42 vulnerabilidades no `npm audit`** (2 low, 38 moderate, 1 high, 1 critical), majoritariamente de sub-dependências antigas do AWS SDK (`@aws-sdk/nested-clients`, `middleware-sdk-s3`, `credential-provider-web-identity`) mais `qs` e `uuid`. Causa raiz: versionamento inconsistente no `package.json` — alguns `@aws-sdk/client-*` em `^3.654.0` (caret) e outros pinados exatos em `3.830.0`, gerando árvores duplicadas de dependências transitivas.
   → Padronizar todos os clients AWS SDK na mesma major/minor; rodar `npm audit fix` periodicamente.

5. **Script `lint` quebrado**: `package.json` define `"lint": "eslint . --ext .ts"`, mas **não existe `eslint` nas devDependencies nem config** (`.eslintrc*` / `eslint.config.*`). O comando falha imediatamente — dívida técnica "morta".

6. **Zero testes na camada `api/`**: os 128 testes cobrem `domain/`, `infrastructure/`, `repositories/`, mas nada em `server.ts`, `migration.routes.ts`, `acp-bridge.ts` ou `creds.ts` — exatamente onde estão o bug de injeção (item 1) e a escrita de credenciais. Não há CI (`.github/workflows` inexistente) rodando nem os testes existentes a cada PR.

### 🟡 Médio

7. **Race condition read-modify-write** no repositório de arquivo (`readAll()` → merge → `writeAll()` em `file-infrastructure.repository.ts` e `creds.ts`): escritas concorrentes podem se sobrescrever. Aceitável para MVP single-writer, mas não documentado como trade-off conhecido.

8. **Fallback CFN com placeholders convive com o "faithful" CFN** — [domain/migration/cfn-generator.ts](../domain/migration/cfn-generator.ts) (linhas ~171-338) tem `ami-PLACEHOLDER`, `TODO: match source engine`, etc. Nomes de tool parecidos (`generate_cfn_templates` vs `generate_faithful_cfn`) criam risco do agente escolher o fallback por engano em produção.

9. **Segredos em arquivo JSON de config do agente** (`~/.kiro/agents/aws-migration-orchestrator.json`) em texto plano (mesmo com chmod 600), em vez de um cofre de segredos/keychain do SO.

10. **Sequenciamento do pipeline vive em prompt de linguagem natural** (`agent.json.prompt`), não em código versionado/testável — parte da correção de um sistema que toca infraestrutura real depende do LLM seguir texto livre, diferente das regras por-recurso (código puro e testado).

### 🟢 Baixo / observações

- `// eslint-disable-next-line @typescript-eslint/no-explicit-any` isolados em collectors — pontuais e comentados, mas o lint nunca roda de fato para confirmar que são os únicos `any`.
- `validateCreds` em `creds.ts` faz validação de borda razoável (regex de access key, tamanho mínimo de secret, sessionToken obrigatório para `ASIA*`).

## 4. Recomendações priorizadas

1. Eliminar a injeção em `validator.ts` (usar SDK in-process em vez de `node -e`).
2. Adicionar autenticação mínima em `/api/creds` e `/api/chat` antes de qualquer uso com `HOST=0.0.0.0`.
3. Consertar ou remover o script `lint` (instalar eslint + config real).
4. Padronizar versões do AWS SDK e rodar `npm audit fix`.
5. Parametrizar os caminhos `/home/kirocrew/...` via variável de ambiente.
6. Cobrir `api/` com testes (ao menos `creds.ts` e as rotas).
7. Adicionar CI (GitHub Actions) rodando `typecheck` + `test` a cada PR.
8. Diferenciar mais claramente (nome de tool + guarda em runtime) o fallback CFN do faithful CFN.

## 5. Resumo

A base de domínio (regras, análise, grafo) é de qualidade sênior — determinística, testada, bem separada. Os maiores riscos estão na borda de integração (`validator.ts`, `api/`, `agent.json`) e em higiene de projeto (dependências, lint, CI) que não acompanhou o rigor do núcleo do domínio.
