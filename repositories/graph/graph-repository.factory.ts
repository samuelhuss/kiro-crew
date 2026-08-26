import type { InfrastructureGraphRepository } from './graph.repository.js';
import { InMemoryGraphRepository } from './in-memory-graph.repository.js';
import { FileGraphRepository } from './file-graph.repository.js';

/**
 * Select the graph repository implementation for the running MCP server.
 *
 * When a graph directory is configured (GRAPH_DIR, or the legacy KUZU_GRAPH_DIR
 * / KUZU_DATA_DIR names kept for config compatibility), all MCP servers share
 * ONE JSON file — a graph written by any agent is immediately visible to the
 * others, with no re-scan and, crucially, no exclusive database lock: many
 * readers plus an atomic single-writer. When unset, each server uses an
 * isolated in-memory graph (good for tests / ephemeral runs).
 *
 * Why not Kuzu: the embedded store locks its directory exclusively for the life
 * of the holding process, so two pipeline servers pointing at the same dir
 * cannot both run; and opening/closing Kuzu per operation segfaults the native
 * addon under sustained cycling. A JSON file avoids both failure modes.
 */
export function createGraphRepository(): InfrastructureGraphRepository {
  const dir =
    process.env['GRAPH_DIR'] ??
    process.env['KUZU_GRAPH_DIR'] ??
    process.env['KUZU_DATA_DIR'];
  return dir ? new FileGraphRepository(dir) : new InMemoryGraphRepository();
}
