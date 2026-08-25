import type { RegionInventory } from '../resources/inventory.js';
import type { AwsResource } from '../resources/resource.js';
import type { ResourceRelationship, RelationshipType } from '../relationships/relationship.js';
import type { GraphNode } from './node.js';
import type { GraphEdge, EdgeType } from './edge.js';
import { edgeKey, isEdgeType, isAcyclicEdgeType } from './edge.js';
import type { InfrastructureGraph } from './graph.js';
import type { GraphIssue } from './errors.js';
import { issue } from './errors.js';

/**
 * Maps the relationship vocabulary emitted by the Discovery collectors onto the
 * richer graph edge vocabulary. This preserves meaning rather than collapsing
 * everything to DEPENDS_ON.
 *
 * Discovery currently emits: BELONGS_TO, ROUTES_THROUGH, ATTACHES_TO, RUNS_IN,
 * TARGETS, USES. All of these map 1:1 to an EdgeType of the same name.
 */
const RELATIONSHIP_TO_EDGE: Record<RelationshipType, EdgeType> = {
  DEPENDS_ON: 'DEPENDS_ON',
  BELONGS_TO: 'BELONGS_TO',
  RUNS_IN: 'RUNS_IN',
  USES: 'USES',
  TARGETS: 'TARGETS',
  CONNECTS_TO: 'CONNECTS_TO',
  ATTACHES_TO: 'ATTACHES_TO',
  ROUTES_THROUGH: 'ROUTES_THROUGH',
  EXPOSES: 'ASSOCIATED_WITH',
};

/**
 * InfrastructureGraphBuilder
 *
 * Consumes a normalized inventory and produces a consistent InfrastructureGraph.
 * It NEVER calls AWS. Responsibilities:
 *   - create nodes (dedup by id)
 *   - create edges from discovered relationships (mapped to the edge vocabulary)
 *   - derive additional SAFE edges from resource properties (e.g. CONTAINS)
 *   - deduplicate edges
 *   - validate references (dangling edges), ARNs, region/account consistency
 *   - detect orphan nodes and unexpected cycles in acyclic relationships
 *   - record everything uncertain as an issue — no silent assumptions
 */
export class InfrastructureGraphBuilder {
  /**
   * If true, for every structural BELONGS_TO edge the builder adds the inverse
   * CONTAINS edge (VPC CONTAINS Subnet, Cluster CONTAINS Service). This makes
   * top-down architecture traversal natural. Enabled by default.
   */
  private readonly deriveContainment: boolean;

  constructor(options: { deriveContainment?: boolean } = {}) {
    this.deriveContainment = options.deriveContainment ?? true;
  }

  build(inventory: RegionInventory): InfrastructureGraph {
    const issues: GraphIssue[] = [];

    const nodes = this.buildNodes(inventory.resources, issues);
    const nodeIndex = new Map(nodes.map((n) => [n.id, n] as const));

    const edges = this.buildEdges(inventory.relationships, nodeIndex, issues);
    this.deriveEdges(nodes, nodeIndex, edges, issues);

    this.detectOrphans(nodes, edges, issues);
    this.detectCycles(edges, issues);
    this.recordKnownLimitations(nodes, edges, issues);

    const regions = [...new Set(nodes.map((n) => n.region))].sort();
    const accountIds = [...new Set(nodes.map((n) => n.accountId))].sort();
    const orphanNodeCount = issues.filter((i) => i.kind === 'ORPHAN_NODE').length;

    return {
      nodes,
      edges,
      issues,
      metadata: {
        regions,
        accountIds,
        builtAt: new Date().toISOString(),
        nodeCount: nodes.length,
        edgeCount: edges.length,
        orphanNodeCount,
      },
    };
  }

  // ── Nodes ───────────────────────────────────────────────────────────────────

  private buildNodes(resources: AwsResource[], issues: GraphIssue[]): GraphNode[] {
    const byId = new Map<string, GraphNode>();

    for (const r of resources) {
      if (byId.has(r.id)) {
        issues.push(
          issue('DUPLICATE_NODE', 'warning', `Duplicate node id "${r.id}" — keeping first occurrence.`, [r.id])
        );
        continue;
      }

      if (r.arn && !this.looksLikeArn(r.arn)) {
        issues.push(
          issue('INVALID_ARN', 'warning', `Node "${r.id}" has a malformed ARN "${r.arn}".`, [r.id])
        );
      }

      byId.set(r.id, {
        id: r.id,
        arn: r.arn,
        type: r.type,
        name: r.name,
        region: r.region,
        accountId: r.accountId,
        properties: r.properties,
      });
    }

    return [...byId.values()];
  }

  // ── Edges from discovered relationships ──────────────────────────────────────

  private buildEdges(
    relationships: ResourceRelationship[],
    nodeIndex: Map<string, GraphNode>,
    issues: GraphIssue[]
  ): GraphEdge[] {
    const seen = new Set<string>();
    const edges: GraphEdge[] = [];

    for (const rel of relationships) {
      const type = RELATIONSHIP_TO_EDGE[rel.relationship];
      if (!type || !isEdgeType(type)) {
        issues.push(
          issue(
            'INVALID_RELATIONSHIP',
            'warning',
            `Unknown relationship type "${rel.relationship}" between "${rel.source}" and "${rel.target}".`,
            [rel.source, rel.target],
            rel.relationship
          )
        );
        continue;
      }

      const edge: GraphEdge = {
        source: rel.source,
        target: rel.target,
        type,
        ...(rel.metadata ? { metadata: rel.metadata } : {}),
      };

      if (!this.addEdge(edge, edges, seen, nodeIndex, issues)) continue;
    }

    return edges;
  }

  /**
   * Derive additional edges that are SAFE to infer from properties the collectors
   * already captured, and add inverse CONTAINS edges for structural containment.
   * Nothing here is a guess — each derivation is backed by a concrete property.
   */
  private deriveEdges(
    nodes: GraphNode[],
    nodeIndex: Map<string, GraphNode>,
    edges: GraphEdge[],
    issues: GraphIssue[]
  ): void {
    const seen = new Set(edges.map((e) => edgeKey(e)));

    // 1. Inverse containment for structural BELONGS_TO edges.
    if (this.deriveContainment) {
      for (const e of [...edges]) {
        if (e.type === 'BELONGS_TO') {
          this.addEdge(
            { source: e.target, target: e.source, type: 'CONTAINS', metadata: { derived: 'inverse-of-BELONGS_TO' } },
            edges,
            seen,
            nodeIndex,
            issues
          );
        }
      }
    }

    // 2. VPC containment derivable from a `vpcId` property (SG, RouteTable, LB, TG, NAT).
    for (const n of nodes) {
      const vpcId = typeof n.properties['vpcId'] === 'string' ? (n.properties['vpcId'] as string) : undefined;
      if (vpcId && nodeIndex.has(vpcId) && vpcId !== n.id) {
        this.addEdge(
          { source: n.id, target: vpcId, type: 'BELONGS_TO', metadata: { derived: 'from-property:vpcId' } },
          edges,
          seen,
          nodeIndex,
          issues
        );
        if (this.deriveContainment) {
          this.addEdge(
            { source: vpcId, target: n.id, type: 'CONTAINS', metadata: { derived: 'from-property:vpcId' } },
            edges,
            seen,
            nodeIndex,
            issues
          );
        }
      }

      // 3. RDS instance BELONGS_TO its DB cluster, when both are present.
      const clusterId =
        typeof n.properties['dbClusterIdentifier'] === 'string'
          ? (n.properties['dbClusterIdentifier'] as string)
          : undefined;
      if (clusterId && nodeIndex.has(clusterId) && clusterId !== n.id) {
        this.addEdge(
          { source: n.id, target: clusterId, type: 'BELONGS_TO', metadata: { derived: 'from-property:dbClusterIdentifier' } },
          edges,
          seen,
          nodeIndex,
          issues
        );
        if (this.deriveContainment) {
          this.addEdge(
            { source: clusterId, target: n.id, type: 'CONTAINS', metadata: { derived: 'from-property:dbClusterIdentifier' } },
            edges,
            seen,
            nodeIndex,
            issues
          );
        }
      }
    }
  }

  /**
   * Central edge insertion: validates references, dedups, and checks
   * region/account consistency. Returns false if the edge was rejected.
   */
  private addEdge(
    edge: GraphEdge,
    edges: GraphEdge[],
    seen: Set<string>,
    nodeIndex: Map<string, GraphNode>,
    issues: GraphIssue[]
  ): boolean {
    const key = edgeKey(edge);
    if (seen.has(key)) {
      issues.push(
        issue('DUPLICATE_EDGE', 'info', `Duplicate edge ${edge.source} -[${edge.type}]-> ${edge.target} ignored.`, [
          edge.source,
          edge.target,
        ], edge.type)
      );
      return false;
    }

    const src = nodeIndex.get(edge.source);
    const tgt = nodeIndex.get(edge.target);
    if (!src || !tgt) {
      const missing = !src ? edge.source : edge.target;
      issues.push(
        issue(
          'DANGLING_EDGE',
          'error',
          `Edge ${edge.source} -[${edge.type}]-> ${edge.target} references missing node "${missing}".`,
          [edge.source, edge.target],
          edge.type
        )
      );
      return false;
    }

    // Region consistency — 'global' resources (IAM) are exempt.
    if (src.region !== tgt.region && src.region !== 'global' && tgt.region !== 'global') {
      issues.push(
        issue(
          'CROSS_REGION',
          'warning',
          `Edge ${edge.source} -[${edge.type}]-> ${edge.target} crosses regions (${src.region} → ${tgt.region}).`,
          [edge.source, edge.target],
          edge.type
        )
      );
    }

    if (src.accountId !== tgt.accountId) {
      issues.push(
        issue(
          'CROSS_ACCOUNT',
          'warning',
          `Edge ${edge.source} -[${edge.type}]-> ${edge.target} crosses accounts (${src.accountId} → ${tgt.accountId}).`,
          [edge.source, edge.target],
          edge.type
        )
      );
    }

    seen.add(key);
    edges.push(edge);
    return true;
  }

  // ── Structural analysis ───────────────────────────────────────────────────────

  private detectOrphans(nodes: GraphNode[], edges: GraphEdge[], issues: GraphIssue[]): void {
    const connected = new Set<string>();
    for (const e of edges) {
      connected.add(e.source);
      connected.add(e.target);
    }
    for (const n of nodes) {
      if (!connected.has(n.id)) {
        issues.push(
          issue('ORPHAN_NODE', 'info', `Node "${n.id}" (${n.type}) has no known relationships.`, [n.id])
        );
      }
    }
  }

  /**
   * Detect cycles among edge types that must form a DAG (CONTAINS, BELONGS_TO).
   * Uses DFS with a recursion stack over the acyclic-typed subgraph.
   */
  private detectCycles(edges: GraphEdge[], issues: GraphIssue[]): void {
    const adjacency = new Map<string, string[]>();
    for (const e of edges) {
      if (!isAcyclicEdgeType(e.type)) continue;
      const list = adjacency.get(e.source) ?? [];
      list.push(e.target);
      adjacency.set(e.source, list);
    }

    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    const reported = new Set<string>();

    const visit = (node: string, path: string[]): void => {
      color.set(node, GRAY);
      path.push(node);
      for (const next of adjacency.get(node) ?? []) {
        const c = color.get(next) ?? WHITE;
        if (c === GRAY) {
          const cycle = [...path.slice(path.indexOf(next)), next];
          const key = cycle.join('>');
          if (!reported.has(key)) {
            reported.add(key);
            issues.push(
              issue(
                'UNEXPECTED_CYCLE',
                'error',
                `Cycle detected in acyclic relationship: ${cycle.join(' → ')}.`,
                cycle
              )
            );
          }
        } else if (c === WHITE) {
          visit(next, path);
        }
      }
      path.pop();
      color.set(node, BLACK);
    };

    for (const node of adjacency.keys()) {
      if ((color.get(node) ?? WHITE) === WHITE) visit(node, []);
    }
  }

  /**
   * Record relationships that are KNOWN to be undeterminable from the current
   * inventory, so consumers understand the graph's coverage limits. These are
   * documented facts about the data, not per-graph anomalies.
   */
  private recordKnownLimitations(nodes: GraphNode[], edges: GraphEdge[], issues: GraphIssue[]): void {
    const hasType = (t: string): boolean => nodes.some((n) => n.type === t);
    const outTypes = new Set(edges.map((e) => e.type));

    if (hasType('AWS::S3::Bucket') && !outTypes.has('READS_FROM') && !outTypes.has('WRITES_TO')) {
      issues.push(
        issue(
          'UNKNOWN_RELATIONSHIP',
          'info',
          'S3 buckets present but no READS_FROM/WRITES_TO edges: consumer access is not derivable from the current inventory (requires task definitions / IAM policy analysis).',
          nodes.filter((n) => n.type === 'AWS::S3::Bucket').map((n) => n.id),
          'READS_FROM'
        )
      );
    }

    if (hasType('AWS::SecretsManager::Secret') && !outTypes.has('READS_FROM')) {
      issues.push(
        issue(
          'UNKNOWN_RELATIONSHIP',
          'info',
          'Secrets present but no consumer edges: which resource reads a secret is not exposed by the current inventory.',
          nodes.filter((n) => n.type === 'AWS::SecretsManager::Secret').map((n) => n.id),
          'READS_FROM'
        )
      );
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private looksLikeArn(arn: string): boolean {
    // arn:partition:service:region:account-id:resource — region/account may be empty
    return /^arn:[^:]+:[^:]+:[^:]*:[^:]*:.+/.test(arn);
  }
}

/** Convenience functional entry point matching the conceptual `build(inventory)`. */
export function buildGraph(inventory: RegionInventory): InfrastructureGraph {
  return new InfrastructureGraphBuilder().build(inventory);
}
