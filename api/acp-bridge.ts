import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { logger } from '../infrastructure/aws/logger.js';

/**
 * ACP Bridge — the thin connector between the web console and the
 * aws-migration-orchestrator agent.
 *
 * It has NO migration logic. It spawns `kiro-cli acp --agent
 * aws-migration-orchestrator`, speaks JSON-RPC (ACP) to it, and re-emits the
 * agent's notifications (message chunks, tool calls, turn end) as events the
 * web layer streams to the browser via SSE.
 *
 * All migration intelligence stays in the orchestrator agent + its 6 MCPs.
 */

export interface AcpEvent {
  type: 'message' | 'tool_call' | 'tool_update' | 'turn_end' | 'error' | 'ready' | 'context' | 'mcp';
  /** For message: streamed text. For tool_call: the tool name. */
  text?: string;
  toolName?: string;
  toolStatus?: string;
  /** Stable id to correlate a tool_call with its later tool_update(s). */
  toolId?: string;
  /** read | edit | execute | fetch | etc. */
  toolKind?: string;
  /** The tool's input (command/args) as a compact string. */
  toolInput?: string;
  /** The tool's output/result as a compact string. */
  toolOutput?: string;
  /** For type 'context': percentage of the model context window used. */
  contextPct?: number;
  /** For type 'mcp': the MCP server that just initialized. */
  mcpServer?: string;
  /** For turn_end: why the turn stopped (end_turn, max_tokens, refusal…). */
  stopReason?: string;
  raw?: unknown;
}

const ORCHESTRATOR_AGENT = 'aws-migration-orchestrator';

export class AcpSession extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private acpSessionId: string | null = null;
  /** Replay buffer so an SSE subscriber that attaches late sees earlier events. */
  private history: AcpEvent[] = [];
  readonly id: string;

  constructor() {
    super();
    this.id = randomUUID();
  }

  /** Emit an event to live listeners AND record it for replay. */
  private push(evt: AcpEvent): void {
    this.history.push(evt);
    if (this.history.length > 5000) this.history.shift();
    this.emit('event', evt);
  }

  /**
   * Subscribe to events, replaying the backlog first. Returns an unsubscribe fn.
   * This guarantees an SSE client attaching after the prompt was sent still
   * receives ready + early message chunks in order.
   */
  subscribe(onEvent: (evt: AcpEvent) => void): () => void {
    for (const evt of this.history) onEvent(evt);
    this.on('event', onEvent);
    return () => this.off('event', onEvent);
  }

  /** Start the acp child process and do the initialize + session/new handshake. */
  async start(): Promise<void> {
    this.proc = spawn(
      'kiro-cli',
      ['acp', '--agent', ORCHESTRATOR_AGENT, '--trust-all-tools'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    this.proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr.on('data', (chunk: Buffer) => {
      logger.debug('acp stderr', { session: this.id, data: chunk.toString().slice(0, 200) });
    });
    this.proc.on('exit', (code) => {
      this.push({ type: 'error', text: `acp process exited (code ${code})` } as AcpEvent);
    });

    // 1. initialize (protocolVersion is a NUMBER for kiro-cli acp)
    this.send('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });

    // 2. session/new — the --agent flag binds the orchestrator; params need
    //    cwd + mcpServers (empty: the agent's own config supplies its 6 MCPs).
    this.send('session/new', {
      cwd: process.env['ORCHESTRATOR_CWD'] ?? process.cwd(),
      mcpServers: [],
    });
  }

  /** Send a user message (prompt) to the orchestrator. */
  prompt(message: string): void {
    if (!this.acpSessionId) {
      // Queue until session is ready
      this.once('session_ready', () => this.doPrompt(message));
      return;
    }
    this.doPrompt(message);
  }

  private doPrompt(message: string): void {
    this.send('session/prompt', {
      sessionId: this.acpSessionId,
      prompt: [{ type: 'text', text: message }],
    });
  }

  cancel(): void {
    if (this.acpSessionId) {
      this.send('session/cancel', { sessionId: this.acpSessionId });
    }
  }

  stop(): void {
    this.proc?.kill('SIGTERM');
    this.proc = null;
  }

  // ── JSON-RPC framing ──────────────────────────────────────────────────────

  private send(method: string, params: unknown): void {
    if (!this.proc) return;
    const msg = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params });
    this.proc.stdin.write(msg + '\n');
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line));
      } catch {
        // non-JSON line — ignore
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // Response to session/new → capture the ACP session id.
    // Response to session/prompt → { result: { stopReason } } signals turn end.
    if (msg['result'] && typeof msg['result'] === 'object') {
      const result = msg['result'] as Record<string, unknown>;
      if (result['sessionId'] && !this.acpSessionId) {
        this.acpSessionId = String(result['sessionId']);
        this.push({ type: 'ready' } as AcpEvent);
        this.emit('session_ready');
        return;
      }
      if (result['stopReason']) {
        this.push({ type: 'turn_end', stopReason: String(result['stopReason']), raw: result } as AcpEvent);
        return;
      }
    }

    const method = String(msg['method'] ?? '');
    const params = (msg['params'] ?? {}) as Record<string, unknown>;

    // Kiro extension notifications: MCP servers coming up + context usage.
    if (method === '_kiro.dev/mcp/server_initialized') {
      this.push({ type: 'mcp', mcpServer: String(params['serverName'] ?? '') } as AcpEvent);
      return;
    }
    if (method === '_kiro.dev/metadata') {
      const pct = params['contextUsagePercentage'];
      if (typeof pct === 'number') this.push({ type: 'context', contextPct: pct } as AcpEvent);
      return;
    }

    // Notifications from the agent: method === 'session/update'
    if (method === 'session/update') {
      const update = (params['update'] ?? {}) as Record<string, unknown>;
      const kind = String(update['sessionUpdate'] ?? '');

      if (kind === 'agent_message_chunk') {
        const content = update['content'] as { text?: string } | undefined;
        this.push({ type: 'message', text: content?.text ?? '', raw: update } as AcpEvent);
      } else if (kind === 'tool_call') {
        this.push({
          type: 'tool_call',
          toolId: String(update['toolCallId'] ?? update['id'] ?? ''),
          toolName: String(update['title'] ?? update['toolName'] ?? update['kind'] ?? 'tool'),
          toolKind: String(update['kind'] ?? ''),
          toolStatus: String(update['status'] ?? 'pending'),
          toolInput: flattenIO(update['rawInput'] ?? update['input']),
          toolOutput: flattenContent(update['content']),
          raw: update,
        } as AcpEvent);
      } else if (kind === 'tool_call_update') {
        this.push({
          type: 'tool_update',
          toolId: String(update['toolCallId'] ?? update['id'] ?? ''),
          toolName: String(update['title'] ?? update['toolName'] ?? ''),
          toolStatus: String(update['status'] ?? ''),
          toolInput: flattenIO(update['rawInput'] ?? update['input']),
          toolOutput: flattenContent(update['content']),
          raw: update,
        } as AcpEvent);
      }
    }
  }
}

/** Compact a rawInput/input object into a short one-line string. */
function flattenIO(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.slice(0, 2000);
  try {
    // common ACP shape: { command: "aws ..." } or arbitrary args object
    const o = v as Record<string, unknown>;
    if (typeof o['command'] === 'string') return String(o['command']).slice(0, 2000);
    return JSON.stringify(v).slice(0, 2000);
  } catch {
    return '';
  }
}

/** Extract text from an ACP content array/object (tool output). */
function flattenContent(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.slice(0, 4000);
  try {
    if (Array.isArray(v)) {
      return v
        .map((c) => {
          const o = (c ?? {}) as Record<string, unknown>;
          const inner = (o['content'] ?? {}) as Record<string, unknown>;
          return String(o['text'] ?? inner['text'] ?? '');
        })
        .filter(Boolean)
        .join('\n')
        .slice(0, 4000);
    }
    const o = v as Record<string, unknown>;
    return String(o['text'] ?? JSON.stringify(v)).slice(0, 4000);
  } catch {
    return '';
  }
}

/** Registry of live sessions (one per browser session). */
const sessions = new Map<string, AcpSession>();

export async function createAcpSession(): Promise<AcpSession> {
  const session = new AcpSession();
  sessions.set(session.id, session);
  await session.start();
  return session;
}

export function getAcpSession(id: string): AcpSession | undefined {
  return sessions.get(id);
}

export function stopAcpSession(id: string): void {
  const s = sessions.get(id);
  if (s) {
    s.stop();
    sessions.delete(id);
  }
}
