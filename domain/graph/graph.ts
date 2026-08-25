import type { GraphNode } from './node.js';
import type { GraphEdge } from './edge.js';
import type { GraphIssue } from './errors.js';

/**
 * InfrastructureGraph — the storage-independent representation of discovered
 * infrastructure. It is a plain, serializable value object: nodes + edges +
 * consistency issues + provenance. It has NO behavior tied to any database.
 *
 * Repositories consume/produce this shape; the builder produces it from an
 * inventory. This is the contract the Migration Agent (future phase) will read.
 */
export interface InfrastructureGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** consistency issues and known limitations found while building */
  issues: GraphIssue[];
  metadata: GraphMetadata;
}

export interface GraphMetadata {
  /** regions represented in this graph */
  regions: string[];
  /** account ids represented in this graph */
  accountIds: string[];
  /** ISO 8601 timestamp of when the graph was built */
  builtAt: string;
  nodeCount: number;
  edgeCount: number;
  /** node ids that participate in no edge */
  orphanNodeCount: number;
}

// ── Serialization for web visualization (React Flow / Cytoscape / D3) ─────────

export interface ExportedNode {
  id: string;
  type: string;
  data: {
    label: string;
    resourceType: string;
    arn: string;
    region: string;
    accountId: string;
    properties: Record<string, unknown>;
  };
}

export interface ExportedEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  label: string;
  metadata: Record<string, unknown>;
}

export interface ExportedGraph {
  nodes: ExportedNode[];
  edges: ExportedEdge[];
}

/**
 * Serialize a graph into a shape suitable for common graph UI libraries.
 * Node `type` carries the resource type so the frontend can pick an icon;
 * edge `label` carries the relationship for display.
 */
export function exportGraph(graph: InfrastructureGraph): ExportedGraph {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      data: {
        label: n.name || n.id,
        resourceType: n.type,
        arn: n.arn,
        region: n.region,
        accountId: n.accountId,
        properties: n.properties,
      },
    })),
    edges: graph.edges.map((e) => ({
      id: `${e.source}__${e.type}__${e.target}`,
      source: e.source,
      target: e.target,
      type: e.type,
      label: e.type,
      metadata: e.metadata ?? {},
    })),
  };
}
