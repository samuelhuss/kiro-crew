import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GraphNode } from '../../domain/graph/node.js';
import type { GraphEdge } from '../../domain/graph/edge.js';
import type { InfrastructureGraph, ExportedGraph } from '../../domain/graph/graph.js';
import type { ResourceType } from '../../domain/resources/resource.js';
import type {
  InfrastructureGraphRepository,
  Neighbor,
  GraphPath,
  ImpactResult,
} from './graph.repository.js';
import { InMemoryGraphRepository } from './in-memory-graph.repository.js';

/**
 * File-backed InfrastructureGraphRepository — the SHARED graph store.
 *
 * Why not Kuzu here: the embedded Kuzu store takes an EXCLUSIVE directory lock
 * for the life of the holding process, so the graph agent and migration agent
 * cannot both open the same shared-graph directory — the second dies with
 * "Could not set lock". Opening/closing Kuzu per operation dodges the lock but
 * segfaults the native addon under sustained cycling in a long-lived server. A
 * JSON file has neither problem.
 *
 * Design: the file (`<dir>/graph.json`) is the source of truth for PERSISTENCE.
 * All queries and traversals delegate to a hydrated InMemoryGraphRepository —
 * the already-tested engine — refreshed from the file on load. Every write
 * persists the whole graph back to disk atomically (temp file + rename).
 */
export class FileGraphRepository implements InfrastructureGraphRepository {
  private readonly filePath: string;
  private mem = new InMemoryGraphRepository();
  private hydrated = false;

  constructor(dir?: string) {
    const baseDir =
      dir ??
      process.env['GRAPH_DIR'] ??
      process.env['KUZU_GRAPH_DIR'] ??
      process.env['KUZU_DATA_DIR'] ??
      join(process.cwd(), 'data');
    this.filePath = /\.json$/i.test(baseDir) ? baseDir : join(baseDir, 'graph.json');
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (!this.hydrated) await this.hydrate();
  }

  async close(): Promise<void> {
    this.hydrated = false;
  }

  private async hydrate(): Promise<void> {
    const graph = await this.readFromDisk();
    this.mem = new InMemoryGraphRepository();
    await this.mem.saveGraph(graph);
    this.hydrated = true;
  }

  /**
   * Always re-read from disk before answering a query. In a multi-process
   * pipeline (graph-agent writes, migration-agent reads) the file may have been
   * written AFTER this process booted — a one-shot hydrate would serve stale
   * (empty) data forever. Re-reading ~50-100KB of JSON per call is negligible
   * compared to the LLM round-trip that triggers it.
   */
  private async ensureHydrated(): Promise<void> {
    await this.hydrate();
  }

  private async readFromDisk(): Promise<InfrastructureGraph> {
    const empty: InfrastructureGraph = {
      nodes: [],
      edges: [],
      issues: [],
      metadata: {
        regions: [], accountIds: [], builtAt: new Date(0).toISOString(),
        nodeCount: 0, edgeCount: 0, orphanNodeCount: 0,
      },
    };
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<InfrastructureGraph>;
      return {
        nodes: parsed.nodes ?? [],
        edges: parsed.edges ?? [],
        issues: parsed.issues ?? [],
        metadata: parsed.metadata ?? empty.metadata,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty;
      throw err;
    }
  }

  /** Persist the current in-memory graph to disk atomically. */
  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const graph = await this.mem.getGraph();
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(graph, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }

  // ── Bulk ────────────────────────────────────────────────────────────────────

  async saveGraph(graph: InfrastructureGraph): Promise<void> {
    await this.mem.saveGraph(graph);
    this.hydrated = true;
    await this.persist();
  }

  async getGraph(): Promise<InfrastructureGraph> {
    await this.ensureHydrated();
    return this.mem.getGraph();
  }

  async exportGraph(): Promise<ExportedGraph> {
    await this.ensureHydrated();
    return this.mem.exportGraph();
  }

  // ── Reads (delegated to the hydrated engine) ──────────────────────────────────

  async getNode(nodeId: string): Promise<GraphNode | undefined> {
    await this.ensureHydrated();
    return this.mem.getNode(nodeId);
  }
  async getNodesByType(type: ResourceType | string): Promise<GraphNode[]> {
    await this.ensureHydrated();
    return this.mem.getNodesByType(type);
  }
  async getNeighbors(nodeId: string): Promise<Neighbor[]> {
    await this.ensureHydrated();
    return this.mem.getNeighbors(nodeId);
  }
  async getDependencies(nodeId: string): Promise<Neighbor[]> {
    await this.ensureHydrated();
    return this.mem.getDependencies(nodeId);
  }
  async getDependents(nodeId: string): Promise<Neighbor[]> {
    await this.ensureHydrated();
    return this.mem.getDependents(nodeId);
  }
  async findPath(sourceId: string, targetId: string): Promise<GraphPath | undefined> {
    await this.ensureHydrated();
    return this.mem.findPath(sourceId, targetId);
  }
  async getImpact(nodeId: string): Promise<ImpactResult> {
    await this.ensureHydrated();
    return this.mem.getImpact(nodeId);
  }

  // ── Incremental mutations — write-through to disk + engine ─────────────────────

  async addNode(node: GraphNode): Promise<void> {
    await this.ensureHydrated();
    await this.mem.addNode(node);
    await this.persist();
  }

  async updateNode(node: GraphNode): Promise<void> {
    await this.ensureHydrated();
    await this.mem.updateNode(node);
    await this.persist();
  }

  async removeNode(nodeId: string): Promise<void> {
    await this.ensureHydrated();
    await this.mem.removeNode(nodeId);
    await this.persist();
  }

  async addEdge(edge: GraphEdge): Promise<void> {
    await this.ensureHydrated();
    await this.mem.addEdge(edge);
    await this.persist();
  }

  async removeEdge(edge: Pick<GraphEdge, 'source' | 'target' | 'type'>): Promise<void> {
    await this.ensureHydrated();
    await this.mem.removeEdge(edge);
    await this.persist();
  }

  async updateRelationships(nodeId: string, relationships: GraphEdge[]): Promise<void> {
    await this.ensureHydrated();
    await this.mem.updateRelationships(nodeId, relationships);
    await this.persist();
  }
}
