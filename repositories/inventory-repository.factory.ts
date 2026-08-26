import type { InfrastructureRepository } from './infrastructure.repository.js';
import { InMemoryInfrastructureRepository } from './infrastructure.repository.js';
import { FileInfrastructureRepository } from './file-infrastructure.repository.js';

/**
 * Select the inventory repository implementation for the running MCP server.
 *
 * When an inventory directory is configured (INVENTORY_DIR, or the legacy
 * KUZU_INVENTORY_DIR / KUZU_DATA_DIR names kept for config compatibility), the
 * discovery and graph servers share ONE JSON file — the inventory the discovery
 * agent writes is immediately readable by the graph agent, with no re-scan and
 * no exclusive database lock. When unset, an isolated in-memory store is used
 * (tests / ephemeral runs).
 *
 * Why not Kuzu: the embedded store locks its directory exclusively for the life
 * of the holding process (so discovery + graph cannot both open the shared
 * inventory dir), and opening/closing it per operation segfaults the native
 * addon under sustained cycling. A JSON file avoids both.
 */
export function createInventoryRepository(): InfrastructureRepository {
  const dir =
    process.env['INVENTORY_DIR'] ??
    process.env['KUZU_INVENTORY_DIR'] ??
    process.env['KUZU_DATA_DIR'];
  return dir ? new FileInfrastructureRepository(dir) : new InMemoryInfrastructureRepository();
}
