import type { TotalInventoryRepository } from './total-inventory.repository.js';
import { InMemoryTotalInventoryRepository } from './total-inventory.repository.js';
import { FileTotalInventoryRepository } from './file-total-inventory.repository.js';

/**
 * Select the total-inventory repository implementation for the running MCP
 * server. Defaults to the shared JSON file inside the active run folder, so
 * aws-discovery-mcp (writer) and migration-analysis-mcp (reader) see the same
 * data. Set MIGRATION_STORE=memory for an isolated ephemeral store.
 */
export function createTotalInventoryRepository(): TotalInventoryRepository {
  if (process.env['MIGRATION_STORE'] === 'memory') return new InMemoryTotalInventoryRepository();
  return new FileTotalInventoryRepository();
}
