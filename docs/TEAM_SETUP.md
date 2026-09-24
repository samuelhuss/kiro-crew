# Configuracao do agente para a equipe

Este guia e o fluxo oficial para alguem da equipe sair de um clone limpo do repositorio ate o agente rodando na IDE. Ele cobre Windows, Linux e macOS, com configuracao automatica e manual.

## Visao geral

O repositorio ja versiona a parte compartilhavel do ambiente:

- `.vscode/mcp.json`: MCP servers para VS Code / Copilot Agent mode, usando `${workspaceFolder}`.
- `.cursor/mcp.json`: mesmos MCP servers para Cursor.
- `.github/agents/aws-migration-orchestrator.agent.md`: persona do agente no VS Code.
- `agents/*/agent.json`: agentes no formato Kiro, com `{{PROJECT_ROOT}}` renderizado no bootstrap.
- `scripts/bootstrap.mjs`: prepara o workspace local de forma cross-platform.
- `scripts/run-with-env.mjs`: carrega `.env` antes de iniciar qualquer MCP server.

O que nao deve ir para o Git: credenciais AWS, `.env`, `.aws/`, `node_modules`, `dist` e `runs`.

## Pre-requisitos

Instale uma vez na maquina:

| Ferramenta | Versao minima | Verificar |
|---|---:|---|
| Git | atual | `git --version` |
| Node.js | 20.11.0 | `node -v` |
| npm | 10 | `npm -v` |
| Python | 3.10 | `python --version` ou `python3 --version` |
| uv / uvx | 0.8.12 | `uv --version` |
| AWS CLI | v2 | `aws --version` |
| cfn-lint | opcional | `cfn-lint --version` |

No Windows, se `uvx` falhar com pacote `awslabs.*`, atualize o `uv` para 0.8.12 ou superior.

## Passo a Passo para Novos Desenvolvedores (Onboarding)

O processo de configuração (bootstrap) automatiza quase tudo para você: desde instalar dependências, compilar o projeto, até configurar os agentes no seu Kiro/VS Code.

### Passo 1: Clone e Bootstrap
Abra o seu terminal, faça o clone e rode o script inicial. Não rode `npm install` ainda!

```bash
git clone <URL_DO_REPO>
cd migration-mcp-server
npm run bootstrap
```

O comando `npm run bootstrap` faz o trabalho pesado:
1. Valida se você tem as versões corretas de `node`, `npm`, `python`, `uv` e `aws`.
2. Cria e te ajuda a configurar o seu arquivo `.env` interativamente.
3. Roda `npm ci` (instalação limpa e previsível baseada no lockfile).
4. Roda `npm run build` para compilar o código dos MCPs para a pasta `dist/`.
5. Prepara o **Kiro**: instala os agentes em `~/.kiro/agents`, cria a configuração `.kiro/settings/mcp.json` e a pasta `runs/`.

### Passo 2: Configurando as Credenciais (AWS)
O seu `.env` foi criado no passo anterior, mas você precisa se certificar de que as credenciais da conta de **origem** e **destino** estão corretas.

Para usar o nosso assistente interativo e não correr o risco de colar credenciais no lugar errado, rode:
```bash
npm run env:configure
```
*(Mais detalhes de como as credenciais funcionam na seção "Configuração de credenciais AWS" abaixo).*

### Passo 3: Inicie os Agentes
Pronto! Seu ambiente está configurado.
- **Se você usa o Kiro:** Reinicie a janela/workspace do Kiro. Os agentes (como o `aws-migration-orchestrator`) e os 6 servidores MCP já devem aparecer conectados.
- **Se você usa VS Code / Cursor:** O `.vscode/mcp.json` já está no projeto. Basta abrir o painel do agente e confirmar a inicialização dos MCP Servers.

---

### Comandos Úteis no Dia a Dia

Para validar o ambiente sem reinstalar tudo:
```bash
npm run bootstrap -- --dry-run
```

Para apenas checar pre-requisitos:

```bash
npm run doctor
```

Para configurar ou trocar source/target depois:

```bash
npm run env:configure
npm run env:check
```

Para instalar os agentes Kiro em outro diretorio:

```bash
npm run bootstrap -- --out /caminho/para/agents
```

Para usar somente VS Code/Cursor e pular a copia para Kiro:

```bash
npm run bootstrap -- --skip-agents
```

## Configuracao de credenciais AWS

Use o `.env` local para definir a conta de origem e, quando houver cross-account, a conta de
destino. O arquivo e carregado automaticamente por `scripts/run-with-env.mjs` antes de iniciar
os MCP servers no VS Code, Cursor, Kiro e nos comandos do repo que usam o wrapper.

Existem dois modos.

### Modo A: perfis nomeados

Use quando as contas ja existem em `~/.aws/credentials` ou via SSO:

```env
AWS_PROFILE=cliente-a-source
AWS_REGION=us-east-1
AWS_PROFILE_TARGET=cliente-a-target
AWS_REGION_TARGET=sa-east-1
MIGRATION_TARGET_ACCOUNT_ID=123456789012
```

Nesse modo, o agente usa o perfil de origem como default e usa a conta destino nas fases
cross-account conforme configurado.

### Modo B: credenciais STS no `.env`

Use quando voce recebe credenciais temporarias de varias contas e quer trocar tudo editando um
arquivo local:

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

Quando essas chaves existem, o wrapper cria automaticamente `.aws/credentials` e `.aws/config`
dentro do repo, com dois perfis estaveis: `migration-source` e `migration-target`. Esses arquivos
sao locais e ignorados pelo Git.

Nao grave access key, secret key ou session token no repositorio. `.env` e `.aws/` ficam no
`.gitignore`.

Para configurar por prompt sem colar segredos:

```bash
npm run env:configure
```

Para conferir se a origem esta configurada:

```bash
npm run env:check
```

Se preferir usar perfis globais padrao:

Conta de origem:

```bash
aws configure --profile migration-source
```

Se a credencial for temporaria STS, adicione o token:

```bash
aws configure set aws_session_token "SEU_SESSION_TOKEN" --profile migration-source
```

Conta de destino, somente para cross-account:

```bash
aws configure --profile migration-target
aws configure set aws_session_token "SEU_SESSION_TOKEN_DESTINO" --profile migration-target
```

Teste as identidades antes de migrar:

```bash
aws sts get-caller-identity --profile migration-source
aws sts get-caller-identity --profile migration-target
```

## Rodando no VS Code

1. Abra a pasta clonada no VS Code.
2. Confirme que o arquivo `.vscode/mcp.json` aparece versionado no repo.
3. Configure `.env` com `npm run env:configure` ou editando a partir de `.env.example`.
4. Abra o Chat em Agent mode.
5. Inicie os MCP servers quando o VS Code pedir.
6. Selecione o agente `aws-migration-orchestrator`.
7. Envie um pedido como: `Migre o workload portal-cliente de us-east-1 para sa-east-1`.

O agente executa discovery, inventario total, grafo e agrupamento automaticamente. Ele para para perguntar o escopo e para de novo no approval gate antes de criar qualquer recurso na conta/regiao de destino.

## Rodando no Cursor

No Cursor, use o mesmo `.env`. A configuracao em `.cursor/mcp.json` tambem chama
`scripts/run-with-env.mjs`, entao nao precisa exportar `AWS_PROFILE` no shell antes de abrir a IDE.

## Rodando no Kiro

O bootstrap ja chama o instalador de agentes. Para rodar somente essa etapa:

```bash
npm run agents:install
```

O instalador faz três coisas importantes para o Kiro:
1. Copia `agents/*/agent.json` para `~/.kiro/agents` trocando `{{PROJECT_ROOT}}` pelo caminho absoluto do clone local.
2. Lê a configuração base em `.vscode/mcp.json` e gera o `.kiro/settings/mcp.json` automaticamente com os caminhos absolutos corretos da sua máquina (já listado no `.gitignore`).
3. Cria a pasta `runs/` na raiz do projeto (necessária para os MCPs da AWS iniciarem sem erros).

Se o clone mudar de pasta, basta rodar o comando de novo para atualizar todos os caminhos.

## Fluxo manual equivalente

Use este fluxo se precisar depurar uma etapa do bootstrap.

```bash
git clone <URL_DO_REPO>
cd migration-mcp-server
npm run env:configure
npm ci
npm run build
npm run agents:install
```

Opcional para console/API fora da IDE:

```bash
npm run env:configure
npm run api:start
```

## Como versionar e enviar para a equipe

Antes de abrir PR ou enviar para a branch compartilhada:

```bash
npm run bootstrap -- --dry-run
npm run build
npm test
git status
```

Inclua no Git somente arquivos de configuracao e codigo do projeto. Nao inclua:

- `.env` ou arquivos com segredos;
- `.aws/` gerado localmente pelo wrapper;
- `node_modules/`;
- `dist/`;
- `runs/` ou artefatos de migracao;
- arquivos `~/.aws/*` ou `~/.kiro/*` da sua maquina.

Checklist para o mantenedor:

1. Atualizar `.github/agents/aws-migration-orchestrator.agent.md` e `agents/aws-migration-orchestrator/agent.json` quando a persona mudar.
2. Rodar `npm run build` para garantir que os MCP servers compilam.
3. Rodar `npm run agents:install -- --dry-run` para validar JSON dos agentes Kiro.
4. Atualizar este guia se algum pre-requisito, comando ou variavel mudar.

## Troubleshooting rapido

- `dist/ not found`: rode `npm run build` ou `npm run bootstrap`.
- `uvx` nao encontra `awslabs.*`: atualize `uv` para 0.8.12+.
- VS Code nao mostra o agente: confirme que abriu a raiz do repo e que `.github/agents/aws-migration-orchestrator.agent.md` esta presente.
- MCP server falha com credencial expirada: renove o perfil AWS ou rode `aws sso login --profile <perfil>`.
- `.env` nao configurado: rode `npm run env:configure` ou copie `.env.example` para `.env` e ajuste.
- Kiro aponta para pasta antiga: rode `npm run agents:install` no clone atual.