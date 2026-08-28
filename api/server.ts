import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createMigrationRouter, type MigrationRouterDeps } from './migration.routes.js';
import { createAcpSession, getAcpSession, stopAcpSession, type AcpEvent } from './acp-bridge.js';
import { applyCredentials, validateCreds, type AwsCredentials } from './creds.js';
import { logger } from '../infrastructure/aws/logger.js';

/**
 * HTTP server: serves the Migration Console (static public/) and bridges the
 * browser to the aws-migration-orchestrator agent over ACP.
 *
 * The /api/chat routes have NO migration logic — they only relay to the agent.
 */

const PUBLIC_DIR = join(process.cwd(), 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString();
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createApiServer(deps: MigrationRouterDeps): Server {
  const handleMigration = createMigrationRouter(deps);

  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;

        if (path === '/health') return json(res, 200, { status: 'ok' });

        // ── Credentials setup (writes AWS creds into the MCP env blocks) ───
        if (path === '/api/creds' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}') as Partial<AwsCredentials>;
          const err = validateCreds(body);
          if (err) return json(res, 400, { error: err });
          const status = await applyCredentials(body as AwsCredentials);
          return json(res, 200, status);
        }

        // ── ACP bridge routes ──────────────────────────────────────────────
        if (path === '/api/chat' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}') as { sessionId?: string; message: string };
          let session = body.sessionId ? getAcpSession(body.sessionId) : undefined;
          if (!session) session = await createAcpSession();
          session.prompt(body.message);
          return json(res, 200, { sessionId: session.id });
        }

        const streamMatch = path.match(/^\/api\/chat\/([^/]+)\/stream$/);
        if (streamMatch && req.method === 'GET') {
          const session = getAcpSession(streamMatch[1]!);
          if (!session) return json(res, 404, { error: 'session not found' });
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          const unsubscribe = session.subscribe((evt: AcpEvent) => {
            res.write(`data: ${JSON.stringify(evt)}\n\n`);
          });
          req.on('close', () => unsubscribe());
          return;
        }

        const cancelMatch = path.match(/^\/api\/chat\/([^/]+)\/cancel$/);
        if (cancelMatch && req.method === 'POST') {
          getAcpSession(cancelMatch[1]!)?.cancel();
          return json(res, 200, { ok: true });
        }

        // ── Legacy migration analysis API (kept for direct/testing use) ────
        const handled = await handleMigration(req, res);
        if (handled) return;

        // ── Static files (the console) ─────────────────────────────────────
        const filePath = path === '/' ? '/index.html' : path;
        try {
          const content = await readFile(join(PUBLIC_DIR, filePath));
          res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
          res.end(content);
          return;
        } catch {
          json(res, 404, { error: 'Not found' });
        }
      } catch (err) {
        logger.error('API request error', { error: err instanceof Error ? err.message : String(err) });
        if (!res.headersSent) json(res, 500, { error: 'Internal server error' });
      }
    })();
  });
}

// Graceful cleanup of ACP child processes on shutdown
export function shutdownBridge(): void {
  // sessions self-clean on process exit; explicit stop is best-effort
}
export { stopAcpSession };
