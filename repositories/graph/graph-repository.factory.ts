import type { InfrastructureGraphRepository } from './graph.repository.js';
import { InMemoryGraphRepository } from './in-memory-graph.repository.js';
import { FileGraphRepository } from './file-graph.repository.js';

/**
 * Select the graph repository implementation for the running MCP server.
 *
 * Defaults to the shared JSON file inside the active run folder (see
 * infrastructure/run/run-context.ts), so a graph written by any agent is
 * immediately visible to the others, with no re-scan and, crucially, no
 * exclusive database lock: many readers plus an atomic single-writer. Set
 * MIGRATION_STORE=memory for an isolated in-memory graph (tests / CI).
 *
 * Why not Kuzu: the embedded store locks its directory exclusively for the life
 * of the holding process, so two pipeline servers pointing at the same dir
 * cannot both run; and opening/closing Kuzu per operation segfaults the native
 * addon under sustained cycling. A JSON file avoids both failure modes.
 */
export function createGraphRepository(): InfrastructureGraphRepository {
  if (process.env['MIGRATION_STORE'] === 'memory') return new InMemoryGraphRepository();
  return new FileGraphRepository();
}
