import type { InfrastructureRepository } from './infrastructure.repository.js';
import { InMemoryInfrastructureRepository } from './infrastructure.repository.js';
import { FileInfrastructureRepository } from './file-infrastructure.repository.js';

/**
 * Select the inventory repository implementation for the running MCP server.
 *
 * Default is the shared JSON file inside the active run folder (see
 * infrastructure/run/run-context.ts) — the inventory the discovery agent writes
 * is immediately readable by the graph agent, with no re-scan and no exclusive
 * database lock. Set MIGRATION_STORE=memory for an isolated ephemeral store
 * (tests / CI).
 *
 * Why not Kuzu: the embedded store locks its directory exclusively for the life
 * of the holding process (so discovery + graph cannot both open the shared
 * inventory dir), and opening/closing it per operation segfaults the native
 * addon under sustained cycling. A JSON file avoids both.
 */
export function createInventoryRepository(): InfrastructureRepository {
  if (process.env['MIGRATION_STORE'] === 'memory') return new InMemoryInfrastructureRepository();
  return new FileInfrastructureRepository();
}
