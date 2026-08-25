import type { GraphNode } from '../../domain/graph/node.js';
import type { GraphEdge } from '../../domain/graph/edge.js';
import { edgeKey } from '../../domain/graph/edge.js';
import type { InfrastructureGraph, ExportedGraph } from '../../domain/graph/graph.js';
import { exportGraph as exportGraphValue } from '../../domain/graph/graph.js';
import type { ResourceType } from '../../domain/resources/resource.js';
import type {
  InfrastructureGraphRepository,
  Neighbor,
  GraphPath,
  ImpactResult,
  AffectedResource,
} from './graph.repository.js';

/**
 * In-memory graph repository for the MVP.
 *
 * Backed by adjacency maps for O(1) node lookup and efficient neighbor/impact
 * traversal. Deliberately storage-agnostic in shape so a Neo4j / Neptune /
 * PostgreSQL adapter can replace it behind InfrastructureGraphRepository without
 * touching the agents.
 *
 * All mutations are incremental — a single resource change never requires a
 * full rebuild.
 */
export class InMemoryGraphRepository implements InfrastructureGraphRepository {
  private nodes = new Map<string, GraphNode>();
  /** edge key → edge, for dedup and removal */
  private edges = new Map<string, GraphEdge>();
  /** node id → outgoing edge keys */
  private out = new Map<string, Set<string>>();
  /** node id → incoming edge keys */
  private in = new Map<string, Set<string>>();
  private issues: InfrastructureGraph['issues'] = [];
  private metadata: InfrastructureGraph['metadata'] = {
    regions: [],
    accountIds: [],
    builtAt: new Date(0).toISOString(),
    nodeCount: 0,
    edgeCount: 0,
    orphanNodeCount: 0,
  };

  // ── Bulk ────────────────────────────────────────────────────────────────────

  async saveGraph(graph: InfrastructureGraph): Promise<void> {
    this.nodes = new Map(graph.nodes.map((n) => [n.id, n] as const));
    this.edges = new Map();
    this.out = new Map();
    this.in = new Map();
    for (const edge of graph.edges) this.indexEdge(edge);
    this.issues = [...graph.issues];
    this.metadata = { ...graph.metadata };
  }

  async getGraph(): Promise<InfrastructureGraph> {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      issues: [...this.issues],
      metadata: this.recomputeMetadata(),
    };
  }

  async exportGraph(): Promise<ExportedGraph> {
    return exportGraphValue(await this.getGraph());
  }

  // ── Reads ─────────────────────────────────────────────────────────────────────

  async getNode(nodeId: string): Promise<GraphNode | undefined> {
    return this.nodes.get(nodeId);
  }

  async getNodesByType(type: ResourceType | string): Promise<GraphNode[]> {
    return [...this.nodes.values()].filter((n) => n.type === type);
  }

  async getNeighbors(nodeId: string): Promise<Neighbor[]> {
    const [deps, dependents] = await Promise.all([
      this.getDependencies(nodeId),
      this.getDependents(nodeId),
    ]);
    return [...deps, ...dependents];
  }

  async getDependencies(nodeId: string): Promise<Neighbor[]> {
    const result: Neighbor[] = [];
    for (const key of this.out.get(nodeId) ?? []) {
      const edge = this.edges.get(key);
      if (!edge) continue;
      const node = this.nodes.get(edge.target);
      if (node) result.push({ node, relationship: edge.type, direction: 'out' });
    }
    return result;
  }

  async getDependents(nodeId: string): Promise<Neighbor[]> {
    const result: Neighbor[] = [];
    for (const key of this.in.get(nodeId) ?? []) {
      const edge = this.edges.get(key);
      if (!edge) continue;
      const node = this.nodes.get(edge.source);
      if (node) result.push({ node, relationship: edge.type, direction: 'in' });
    }
    return result;
  }

  /**
   * Breadth-first shortest path following edge direction (source → target).
   * Returns undefined when unreachable.
   */
  async findPath(sourceId: string, targetId: string): Promise<GraphPath | undefined> {
    if (!this.nodes.has(sourceId) || !this.nodes.has(targetId)) return undefined;
    if (sourceId === targetId) return { nodes: [sourceId], hops: [] };

    const queue: string[] = [sourceId];
    const prev = new Map<string, { from: string; via: GraphEdge }>();
    const visited = new Set<string>([sourceId]);

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const key of this.out.get(current) ?? []) {
        const edge = this.edges.get(key);
        if (!edge || visited.has(edge.target)) continue;
        visited.add(edge.target);
        prev.set(edge.target, { from: current, via: edge });
        if (edge.target === targetId) return this.reconstructPath(sourceId, targetId, prev);
        queue.push(edge.target);
      }
    }
    return undefined;
  }

  /**
   * Impact analysis: every resource that transitively DEPENDS on the given node
   * (i.e. reachable by walking incoming edges). If the resource were removed or
   * migrated, these are the resources potentially affected.
   */
  async getImpact(nodeId: string): Promise<ImpactResult> {
    const affected: AffectedResource[] = [];
    if (!this.nodes.has(nodeId)) return { resource: nodeId, affectedResources: affected };

    const visited = new Set<string>([nodeId]);
    let frontier: Array<{ id: string; relationship: AffectedResource['relationship'] }> = [];

    // Seed with direct dependents.
    for (const key of this.in.get(nodeId) ?? []) {
      const edge = this.edges.get(key);
      if (edge && !visited.has(edge.source)) frontier.push({ id: edge.source, relationship: edge.type });
    }

    let depth = 1;
    while (frontier.length > 0) {
      const next: Array<{ id: string; relationship: AffectedResource['relationship'] }> = [];
      for (const item of frontier) {
        if (visited.has(item.id)) continue;
        visited.add(item.id);
        const node = this.nodes.get(item.id);
        if (node) {
          affected.push({
            id: node.id,
            type: node.type,
            name: node.name,
            relationship: item.relationship,
            depth,
          });
        }
        for (const key of this.in.get(item.id) ?? []) {
          const edge = this.edges.get(key);
          if (edge && !visited.has(edge.source)) next.push({ id: edge.source, relationship: edge.type });
        }
      }
      frontier = next;
      depth += 1;
    }

    return { resource: nodeId, affectedResources: affected };
  }

  // ── Incremental mutations ──────────────────────────────────────────────────────

  async addNode(node: GraphNode): Promise<void> {
    this.nodes.set(node.id, node);
  }

  async updateNode(node: GraphNode): Promise<void> {
    this.nodes.set(node.id, node);
  }

  async removeNode(nodeId: string): Promise<void> {
    // Remove all incident edges first, then the node.
    for (const key of [...(this.out.get(nodeId) ?? [])]) this.unindexEdgeByKey(key);
    for (const key of [...(this.in.get(nodeId) ?? [])]) this.unindexEdgeByKey(key);
    this.out.delete(nodeId);
    this.in.delete(nodeId);
    this.nodes.delete(nodeId);
  }

  async addEdge(edge: GraphEdge): Promise<void> {
    this.indexEdge(edge);
  }

  async removeEdge(edge: Pick<GraphEdge, 'source' | 'target' | 'type'>): Promise<void> {
    this.unindexEdgeByKey(edgeKey(edge));
  }

  async updateRelationships(nodeId: string, relationships: GraphEdge[]): Promise<void> {
    for (const key of [...(this.out.get(nodeId) ?? [])]) this.unindexEdgeByKey(key);
    for (const edge of relationships) {
      if (edge.source !== nodeId) continue; // only outgoing edges of this node
      this.indexEdge(edge);
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private indexEdge(edge: GraphEdge): void {
    const key = edgeKey(edge);
    if (this.edges.has(key)) return; // dedup
    this.edges.set(key, edge);
    this.addToSet(this.out, edge.source, key);
    this.addToSet(this.in, edge.target, key);
  }

  private unindexEdgeByKey(key: string): void {
    const edge = this.edges.get(key);
    if (!edge) return;
    this.edges.delete(key);
    this.out.get(edge.source)?.delete(key);
    this.in.get(edge.target)?.delete(key);
  }

  private addToSet(map: Map<string, Set<string>>, id: string, value: string): void {
    const set = map.get(id) ?? new Set<string>();
    set.add(value);
    map.set(id, set);
  }

  private reconstructPath(
    sourceId: string,
    targetId: string,
    prev: Map<string, { from: string; via: GraphEdge }>
  ): GraphPath {
    const hops: GraphPath['hops'] = [];
    const nodes: string[] = [targetId];
    let cursor = targetId;
    while (cursor !== sourceId) {
      const step = prev.get(cursor);
      if (!step) break;
      hops.unshift({ from: step.from, to: cursor, relationship: step.via.type });
      nodes.unshift(step.from);
      cursor = step.from;
    }
    return { nodes, hops };
  }

  private recomputeMetadata(): InfrastructureGraph['metadata'] {
    const nodes = [...this.nodes.values()];
    const connected = new Set<string>();
    for (const e of this.edges.values()) {
      connected.add(e.source);
      connected.add(e.target);
    }
    return {
      regions: [...new Set(nodes.map((n) => n.region))].sort(),
      accountIds: [...new Set(nodes.map((n) => n.accountId))].sort(),
      builtAt: this.metadata.builtAt,
      nodeCount: nodes.length,
      edgeCount: this.edges.size,
      orphanNodeCount: nodes.filter((n) => !connected.has(n.id)).length,
    };
  }
}
