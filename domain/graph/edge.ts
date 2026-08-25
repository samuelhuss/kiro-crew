/**
 * Graph edge model — a semantic relationship between two infrastructure nodes.
 *
 * The edge vocabulary is intentionally EXTENSIBLE: new relationship types can be
 * added without changing the graph engine. We DO NOT collapse everything into
 * DEPENDS_ON — the semantic meaning of each relationship is preserved.
 *
 * IMPORTANT: The builder only ever produces edge types that can be determined
 * SAFELY from the inventory data. Types present in this enum but not currently
 * derivable (e.g. CONNECTS_TO between an app and its database) are documented as
 * known limitations and are never fabricated.
 */
export type EdgeType =
  // ── Structural containment ───────────────────────────────────────────────
  | 'CONTAINS' // VPC CONTAINS Subnet, Cluster CONTAINS Service (inverse of BELONGS_TO)
  | 'BELONGS_TO' // Subnet BELONGS_TO VPC, Service BELONGS_TO Cluster
  // ── Generic / dependency ─────────────────────────────────────────────────
  | 'DEPENDS_ON' // generic dependency when no more specific type applies
  | 'USES' // Service USES SecurityGroup, Lambda USES Role/SG
  | 'ASSOCIATED_WITH' // loose association with no stronger semantic
  // ── Runtime placement ────────────────────────────────────────────────────
  | 'RUNS_IN' // Service/LB/RDS/Lambda RUNS_IN Subnet
  // ── Networking / traffic ─────────────────────────────────────────────────
  | 'CONNECTS_TO' // app CONNECTS_TO database (NOT derivable from current data)
  | 'TARGETS' // LB TARGETS TargetGroup, Service TARGETS TargetGroup
  | 'ROUTES_TO' // RouteTable ROUTES_TO IGW/NAT (NOT derivable from current data)
  | 'ROUTES_THROUGH' // Subnet ROUTES_THROUGH RouteTable
  | 'ATTACHES_TO' // InternetGateway ATTACHES_TO VPC
  // ── Identity / access ────────────────────────────────────────────────────
  | 'ASSUMES_ROLE' // resource ASSUMES_ROLE IAM Role (partial: only Lambda today)
  | 'READS_FROM' // consumer READS_FROM S3/Secret (NOT derivable from current data)
  | 'WRITES_TO'; // consumer WRITES_TO S3 (NOT derivable from current data)

/** All edge types the engine understands, for validation. */
export const EDGE_TYPES: readonly EdgeType[] = [
  'CONTAINS',
  'BELONGS_TO',
  'DEPENDS_ON',
  'USES',
  'ASSOCIATED_WITH',
  'RUNS_IN',
  'CONNECTS_TO',
  'TARGETS',
  'ROUTES_TO',
  'ROUTES_THROUGH',
  'ATTACHES_TO',
  'ASSUMES_ROLE',
  'READS_FROM',
  'WRITES_TO',
] as const;

/**
 * Edge types that express structural containment and MUST remain acyclic.
 * A cycle among these indicates a data inconsistency worth reporting.
 */
export const ACYCLIC_EDGE_TYPES: readonly EdgeType[] = ['CONTAINS', 'BELONGS_TO'] as const;

export interface GraphEdge {
  /** id of the source node */
  source: string;
  /** id of the target node */
  target: string;
  /** semantic relationship label */
  type: EdgeType;
  /** optional metadata (port, protocol, derivation note, etc.) */
  metadata?: Record<string, unknown>;
}

/** Stable, order-independent key used for edge deduplication. */
export function edgeKey(edge: Pick<GraphEdge, 'source' | 'target' | 'type'>): string {
  return `${edge.source}\u0000${edge.type}\u0000${edge.target}`;
}

/** Type guard for a valid edge type. */
export function isEdgeType(value: string): value is EdgeType {
  return (EDGE_TYPES as readonly string[]).includes(value);
}

/** Whether an edge type is expected to form an acyclic (DAG) subgraph. */
export function isAcyclicEdgeType(type: EdgeType): boolean {
  return (ACYCLIC_EDGE_TYPES as readonly string[]).includes(type);
}
