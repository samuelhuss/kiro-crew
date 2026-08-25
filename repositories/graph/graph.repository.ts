import type { GraphNode } from '../../domain/graph/node.js';
import type { GraphEdge, EdgeType } from '../../domain/graph/edge.js';
import type { InfrastructureGraph, ExportedGraph } from '../../domain/graph/graph.js';
import type { ResourceType } from '../../domain/resources/resource.js';

/**
 * A neighbor reached by traversing a single edge from a node, annotated with the
 * relationship that connected it and the traversal direction.
 */
export interface Neighbor {
  node: GraphNode;
  relationship: EdgeType;
  /** 'out' = this node is the edge source; 'in' = this node is the edge target */
  direction: 'out' | 'in';
}

/** A single hop in a path between two resources. */
export interface PathHop {
  from: string;
  to: string;
  relationship: EdgeType;
}

export interface GraphPath {
  nodes: string[];
  hops: PathHop[];
}

/** An affected resource discovered during impact analysis. */
export interface AffectedResource {
  id: string;
  type: ResourceType;
  name: string;
  /** the relationship on the first hop that connects it toward the changed resource */
  relationship: EdgeType;
  /** number of hops away from the analyzed resource */
  depth: number;
}

export interface ImpactResult {
  resource: string;
  affectedResources: AffectedResource[];
}

/**
 * InfrastructureGraphRepository — storage-independent contract for persisting and
 * querying the infrastructure graph.
 *
 * The domain is NOT coupled to Neo4j, PostgreSQL, DynamoDB or Neptune. The MVP
 * ships an in-memory implementation; a graph DB adapter can be dropped in later
 * WITHOUT changing agents, since they depend only on this interface.
 *
 * Supports incremental updates so a single changed resource does not require a
 * full account rescan / rebuild.
 */
export interface InfrastructureGraphRepository {
  /** optional lifecycle hooks */
  init?(): Promise<void>;
  close?(): Promise<void>;

  // ── Bulk ────────────────────────────────────────────────────────────────────
  /** Persist (replace) a full graph. */
  saveGraph(graph: InfrastructureGraph): Promise<void>;
  /** Return the full graph currently held. */
  getGraph(): Promise<InfrastructureGraph>;
  /** Serialize for web visualization (React Flow / Cytoscape / D3). */
  exportGraph(): Promise<ExportedGraph>;

  // ── Reads ─────────────────────────────────────────────────────────────────────
  getNode(nodeId: string): Promise<GraphNode | undefined>;
  getNodesByType(type: ResourceType | string): Promise<GraphNode[]>;
  getNeighbors(nodeId: string): Promise<Neighbor[]>;
  /** Resources this node depends on (outgoing edges). */
  getDependencies(nodeId: string): Promise<Neighbor[]>;
  /** Resources that depend on this node (incoming edges). */
  getDependents(nodeId: string): Promise<Neighbor[]>;
  /** Shortest path following edge direction, undefined when none exists. */
  findPath(sourceId: string, targetId: string): Promise<GraphPath | undefined>;
  /** Transitive set of resources affected if this node changes/is removed. */
  getImpact(nodeId: string): Promise<ImpactResult>;

  // ── Incremental mutations ──────────────────────────────────────────────────────
  addNode(node: GraphNode): Promise<void>;
  updateNode(node: GraphNode): Promise<void>;
  removeNode(nodeId: string): Promise<void>;
  addEdge(edge: GraphEdge): Promise<void>;
  removeEdge(edge: Pick<GraphEdge, 'source' | 'target' | 'type'>): Promise<void>;
  /** Replace all outgoing edges of a node with the provided set. */
  updateRelationships(nodeId: string, relationships: GraphEdge[]): Promise<void>;
}
