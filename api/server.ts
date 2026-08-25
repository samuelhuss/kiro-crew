import { createServer, type Server } from 'node:http';
import { createMigrationRouter, type MigrationRouterDeps } from './migration.routes.js';
import { logger } from '../infrastructure/aws/logger.js';

/**
 * Minimal HTTP server exposing the migration analysis API.
 * Uses only node:http — no web framework dependency.
 */
export function createApiServer(deps: MigrationRouterDeps): Server {
  const handleMigration = createMigrationRouter(deps);

  return createServer((req, res) => {
    void (async () => {
      try {
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }
        const handled = await handleMigration(req, res);
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      } catch (err) {
        logger.error('API request error', { error: err instanceof Error ? err.message : String(err) });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
    })();
  });
}
