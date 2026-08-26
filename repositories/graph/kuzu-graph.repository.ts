import { Database, Connection } from 'kuzu';
import { mkdir } from 'node:fs/promises';
import type { GraphNode } from '../../domain/graph/node.js';
import type { GraphEdge } from '../../domain/graph/edge.js';
import { isEdgeType } from '../../domain/graph/edge.js';
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
 * Kuzu-backed InfrastructureGraphRepository — the SHARED graph store.
 *
 * All three MCP servers (discovery, graph, migration) point at the same Kuzu
 * database directory via the KUZU_GRAPH_DIR / KUZU_DATA_DIR env var, so a graph
 * built once by any agent is immediately visible to the others — no re-scan.
 *
 * Design: Kuzu is the source of truth for PERSISTENCE (nodes + edges + metadata).
 * Traversal queries (findPath, getImpact, getDependents, …) delegate to a
 * hydrated InMemoryGraphRepository — the already-tested traversal engine — which
 * is refreshed from Kuzu on load. This avoids re-implementing recursive Cypher
 * and keeps behavior identical to the in-memory adapter.
 *
 * Schema
 * ──────
 * NODE TABLE GraphNode  (id PK, arn, type, name, region, accountId, properties JSON)
 * NODE TABLE GraphMeta  (key PK, value JSON)   — single row 'graph' holds metadata + issues
 * REL  TABLE GraphEdge  (FROM GraphNode TO GraphNode, type, metadata JSON)
 */
export class KuzuGraphRepository implements InfrastructureGraphRepository {
  private db!: Database;
  private conn!: Connection;
  private readonly dataDir: string;
  private initialised = false;
  /** hydrated traversal engine, kept in sync with Kuzu */
  private mem = new InMemoryGraphRepository();
  private hydrated = false;

  constructor(dataDir?: string) {
    this.dataDir =
      dataDir ??
      process.env['KUZU_GRAPH_DIR'] ??
      process.env['KUZU_DATA_DIR'] ??
      'data/infrastructure-graph.kuzu';
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this.initialised) return;
    const parent = this.dataDir.includes('/') || this.dataDir.includes('\\')
      ? this.dataDir.split(/[/\\]/).slice(0, -1).join('/')
      : '.';
    if (parent && parent !== '.') await mkdir(parent, { recursive: true });

    this.db = new Database(this.dataDir);
    this.conn = new Connection(this.db);
    await this.ensureSchema();
    await this.hydrate();
    this.initialised = true;
  }

  async close(): Promise<void> {
    if (!this.initialised) return;
    await this.conn.close();
    await this.db.close();
    this.initialised = false;
    this.hydrated = false;
  }

  private async ensureSchema(): Promise<void> {
    await this.exec(`
      CREATE NODE TABLE IF NOT EXISTS GraphNode (
        id STRING, arn STRING, type STRING, name STRING,
        region STRING, accountId STRING, properties STRING,
        PRIMARY KEY (id)
      )`);
    await this.exec(`
      CREATE NODE TABLE IF NOT EXISTS GraphMeta (
        key STRING, value STRING, PRIMARY KEY (key)
      )`);
    await this.exec(`
      CREATE REL TABLE IF NOT EXISTS GraphEdge (
        FROM GraphNode TO GraphNode, type STRING, metadata STRING
      )`);
  }

  /** Load everything from Kuzu into the in-memory traversal engine. */
  private async hydrate(): Promise<void> {
    const graph = await this.readGraphFromKuzu();
    this.mem = new InMemoryGraphRepository();
    await this.mem.saveGraph(graph);
    this.hydrated = true;
  }

  private async ensureHydrated(): Promise<void> {
    await this.init();
    if (!this.hydrated) await this.hydrate();
  }

  // ── Bulk ────────────────────────────────────────────────────────────────────

  async saveGraph(graph: InfrastructureGraph): Promise<void> {
    await this.init();

    // Replace: clear existing edges then nodes, then re-insert.
    await this.exec('MATCH ()-[e:GraphEdge]->() DELETE e');
    await this.exec('MATCH (n:GraphNode) DELETE n');

    for (const node of graph.nodes) {
      await this.exec(`
        CREATE (:GraphNode {
          id: '${esc(node.id)}', arn: '${esc(node.arn)}', type: '${esc(node.type)}',
          name: '${esc(node.name)}', region: '${esc(node.region)}',
          accountId: '${esc(node.accountId)}', properties: '${esc(JSON.stringify(node.properties))}'
        })`);
    }
    for (const edge of graph.edges) {
      await this.exec(`
        MATCH (s:GraphNode {id: '${esc(edge.source)}'}), (t:GraphNode {id: '${esc(edge.target)}'})
        CREATE (s)-[:GraphEdge {type: '${esc(edge.type)}', metadata: '${esc(JSON.stringify(edge.metadata ?? {}))}'}]->(t)`);
    }

    // Persist metadata + issues as one JSON row.
    const metaBlob = JSON.stringify({ metadata: graph.metadata, issues: graph.issues });
    await this.exec(`MERGE (m:GraphMeta {key: 'graph'}) SET m.value = '${esc(metaBlob)}'`);

    // Refresh the traversal engine.
    await this.mem.saveGraph(graph);
    this.hydrated = true;
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

  // ── Incremental mutations — write-through to Kuzu + engine ─────────────────────

  async addNode(node: GraphNode): Promise<void> {
    await this.ensureHydrated();
    await this.exec(`
      MERGE (n:GraphNode {id: '${esc(node.id)}'})
      SET n.arn = '${esc(node.arn)}', n.type = '${esc(node.type)}', n.name = '${esc(node.name)}',
          n.region = '${esc(node.region)}', n.accountId = '${esc(node.accountId)}',
          n.properties = '${esc(JSON.stringify(node.properties))}'`);
    await this.mem.addNode(node);
  }

  async updateNode(node: GraphNode): Promise<void> {
    await this.addNode(node); // MERGE handles upsert
    await this.mem.updateNode(node);
  }

  async removeNode(nodeId: string): Promise<void> {
    await this.ensureHydrated();
    await this.exec(`MATCH (n:GraphNode {id: '${esc(nodeId)}'})-[e:GraphEdge]-() DELETE e`);
    await this.exec(`MATCH (n:GraphNode {id: '${esc(nodeId)}'}) DELETE n`);
    await this.mem.removeNode(nodeId);
  }

  async addEdge(edge: GraphEdge): Promise<void> {
    await this.ensureHydrated();
    await this.exec(`
      MATCH (s:GraphNode {id: '${esc(edge.source)}'}), (t:GraphNode {id: '${esc(edge.target)}'})
      CREATE (s)-[:GraphEdge {type: '${esc(edge.type)}', metadata: '${esc(JSON.stringify(edge.metadata ?? {}))}'}]->(t)`);
    await this.mem.addEdge(edge);
  }

  async removeEdge(edge: Pick<GraphEdge, 'source' | 'target' | 'type'>): Promise<void> {
    await this.ensureHydrated();
    await this.exec(`
      MATCH (s:GraphNode {id: '${esc(edge.source)}'})-[e:GraphEdge {type: '${esc(edge.type)}'}]->(t:GraphNode {id: '${esc(edge.target)}'})
      DELETE e`);
    await this.mem.removeEdge(edge);
  }

  async updateRelationships(nodeId: string, relationships: GraphEdge[]): Promise<void> {
    await this.ensureHydrated();
    // Drop all outgoing edges of the node, then insert the provided set.
    await this.exec(`MATCH (n:GraphNode {id: '${esc(nodeId)}'})-[e:GraphEdge]->() DELETE e`);
    for (const edge of relationships) {
      await this.exec(`
        MATCH (s:GraphNode {id: '${esc(edge.source)}'}), (t:GraphNode {id: '${esc(edge.target)}'})
        CREATE (s)-[:GraphEdge {type: '${esc(edge.type)}', metadata: '${esc(JSON.stringify(edge.metadata ?? {}))}'}]->(t)`);
    }
    await this.mem.updateRelationships(nodeId, relationships);
  }

  // ── Kuzu helpers ──────────────────────────────────────────────────────────────

  private async exec(cypher: string): Promise<void> {
    const result = await this.conn.query(cypher);
    const r = Array.isArray(result) ? result[0] : result;
    if (r) await r.getAll();
  }

  private async queryAll(cypher: string): Promise<Record<string, unknown>[]> {
    const result = await this.conn.query(cypher);
    const r = Array.isArray(result) ? result[0] : result;
    if (!r) return [];
    return (await r.getAll()) as Record<string, unknown>[];
  }

  /** Reconstruct a full InfrastructureGraph from the Kuzu tables. */
  private async readGraphFromKuzu(): Promise<InfrastructureGraph> {
    const nodeRows = await this.queryAll('MATCH (n:GraphNode) RETURN n');
    const nodes: GraphNode[] = nodeRows.map((row) => {
      const n = row['n'] as Record<string, unknown>;
      return {
        id: String(n['id'] ?? ''),
        arn: String(n['arn'] ?? ''),
        type: String(n['type'] ?? '') as ResourceType,
        name: String(n['name'] ?? ''),
        region: String(n['region'] ?? ''),
        accountId: String(n['accountId'] ?? ''),
        properties: safeParse(n['properties'], {}),
      };
    });

    const edgeRows = await this.queryAll(
      'MATCH (s:GraphNode)-[e:GraphEdge]->(t:GraphNode) RETURN s.id AS source, t.id AS target, e.type AS type, e.metadata AS metadata'
    );
    const edges: GraphEdge[] = edgeRows
      .map((row): GraphEdge | undefined => {
        const type = String(row['type'] ?? '');
        if (!isEdgeType(type)) return undefined;
        return {
          source: String(row['source'] ?? ''),
          target: String(row['target'] ?? ''),
          type,
          metadata: safeParse<Record<string, unknown>>(row['metadata'], {}),
        };
      })
      .filter((e): e is GraphEdge => e !== undefined);

    // Metadata + issues.
    const metaRows = await this.queryAll(`MATCH (m:GraphMeta {key: 'graph'}) RETURN m.value AS value`);
    let metadata: InfrastructureGraph['metadata'] = {
      regions: [], accountIds: [], builtAt: new Date(0).toISOString(),
      nodeCount: nodes.length, edgeCount: edges.length, orphanNodeCount: 0,
    };
    let issues: InfrastructureGraph['issues'] = [];
    if (metaRows.length > 0) {
      const blob = safeParse<{ metadata?: typeof metadata; issues?: typeof issues }>(metaRows[0]!['value'], {});
      if (blob.metadata) metadata = blob.metadata;
      if (blob.issues) issues = blob.issues;
    }

    return { nodes, edges, issues, metadata };
  }
}

// ── pure helpers ──────────────────────────────────────────────────────────────

function esc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function safeParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
