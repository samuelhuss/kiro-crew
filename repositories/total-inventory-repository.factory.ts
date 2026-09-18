import type { TotalInventoryRepository } from './total-inventory.repository.js';
import { InMemoryTotalInventoryRepository } from './total-inventory.repository.js';
import { FileTotalInventoryRepository } from './file-total-inventory.repository.js';

/**
 * Select the total-inventory repository implementation for the running MCP
 * server. When TOTAL_INVENTORY_DIR is configured, aws-discovery-mcp (writer)
 * and migration-analysis-mcp (reader) share ONE JSON file — same sharing
 * pattern as INVENTORY_DIR/GRAPH_DIR. When unset, an isolated in-memory store
 * is used (tests / ephemeral runs).
 */
export function createTotalInventoryRepository(): TotalInventoryRepository {
  const dir = process.env['TOTAL_INVENTORY_DIR'];
  return dir ? new FileTotalInventoryRepository(dir) : new InMemoryTotalInventoryRepository();
}
