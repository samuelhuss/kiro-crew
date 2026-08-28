# Migration Console — Design (ACP Bridge)

A minimal visual frontend that is the **face of the orchestrator**, NOT an
alternative to it. The frontend sends a message to the `aws-migration-orchestrator`
agent and streams back what the agent does (its messages + tool calls), rendering
the pipeline visually. All migration logic stays in the orchestrator.

## Key principle

```
Frontend  →  ACP bridge  →  aws-migration-orchestrator (the brain, 6 MCPs)
   ▲                              │
   └──── streams agent output ────┘
```

The bridge has ZERO migration logic. It only:
1. Spawns `kiro-cli acp --agent aws-migration-orchestrator --trust-all-tools`
2. Speaks JSON-RPC (ACP) to it: initialize → session/new → session/prompt
3. Relays the agent's `session/notification` events (AgentMessageChunk, ToolCall,
   ToolCallUpdate, TurnEnd) to the browser via SSE
4. Sends the user's approval/next message back as another session/prompt

## ACP protocol (from `kiro-cli acp`)

Transport: JSON-RPC 2.0 over stdin/stdout. Methods used:
- `initialize` — capabilities handshake
- `session/new` — create a session bound to the orchestrator agent
- `session/prompt` — send the user's message ("migre tstsrv us-east-1 → sa-east-1")
- `session/cancel` — cancel current turn

Agent → client notifications (`session/notification`):
- `AgentMessageChunk` — streaming text from the orchestrator (narration)
- `ToolCall` — a tool invocation (scan_region, build_graph, generate_faithful_cfn, deploy…)
- `ToolCallUpdate` — progress of a running tool
- `TurnEnd` — the agent finished its turn (e.g. reached the approval gate)

CLI invocation:
```
kiro-cli acp --agent aws-migration-orchestrator --trust-all-tools
```
(--trust-all-tools so the bridge does not stall on permission prompts; the
approval gate is enforced by the orchestrator's prompt, not by tool prompts.)

## Mapping ACP events → visual pipeline

The frontend maps the orchestrator's tool calls to pipeline stages:

| Tool call (from ACP ToolCall) | Visual stage |
|-------------------------------|--------------|
| `scan_region` | Discovery |
| `build_graph` | Graph |
| `analyze_resource_migration` | Assessment |
| `generate_faithful_cfn` | Faithful CFN |
| `aws cloudformation deploy` (shell) | Execution: networking/compute |
| `aws ec2 create-image` / `copy-image` (shell) | Execution: data |
| TurnEnd after CFN | → show approval gate |

AgentMessageChunk text streams into a narration log so the user "só quer entender
o que está acontecendo".

## API bridge (node:http)

```
GET  /                          → serve public/index.html
GET  /health                    → { status: ok }
POST /api/chat                  → start/continue an orchestrator session
     body: { sessionId?, message }
     resp: { sessionId }        (the turn streams over SSE)
GET  /api/chat/:sessionId/stream → SSE of ACP events (mapped for the UI)
POST /api/chat/:sessionId/cancel → session/cancel
```

One `kiro-cli acp` child process per browser session, kept alive for the
conversation. The bridge parses its stdout JSON-RPC and re-emits SSE.

## Credentials (cross-account, Option B)

Credentials are NOT handled by the bridge or frontend. They live where they
already do — in the orchestrator's agent config (`~/.kiro/agents/aws-migration-orchestrator.json`),
which the MCP servers read. For cross-account, the target credentials are added
to the relevant MCP env (same pattern as the source). The frontend just tells
the orchestrator "migre para a conta B (<id>) região sa-east-1" in natural
language; the orchestrator uses the configured target credentials.

(If per-session credentials are needed later, the bridge could inject them via a
session/prompt preamble — but that is a future enhancement, not the MVP.)

## Files

| File | Role |
|------|------|
| `api/acp-bridge.ts` | Spawn kiro-cli acp, JSON-RPC framing, SSE relay |
| `api/server.ts` | (extend) serve static + /api/chat routes |
| `public/index.html` | Console UI (setup, pipeline stages, narration, approval, execution) |
| `public/app.js` | fetch /api/chat + EventSource; map ACP events → stages |
| `public/style.css` | (inline in index.html for MVP) |

## Security

- Bridge binds 127.0.0.1 only.
- No credentials in the frontend or bridge — they stay in the agent config.
- The orchestrator's own prompt enforces the approval gate before any execution.
- `--trust-all-tools` is safe here because the destructive gate is the human
  approval the orchestrator asks for, and the source is never modified.

## Environment caveat

Earlier we found the gateway could not spawn custom MCPs in the dashboard chat on
this host. `kiro-cli acp` runs the agent as a direct child process (not through
the gateway's MCP spawner), so the bridge must be validated to confirm the 6 MCPs
come up under acp on this host. If they do not, the bridge still works from the
user's own environment where the MCPs spawn correctly.
