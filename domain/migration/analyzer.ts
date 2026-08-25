import { randomUUID } from 'node:crypto';
import type { InfrastructureGraph } from '../graph/graph.js';
import type { GraphNode } from '../graph/node.js';
import type { GraphEdge } from '../graph/edge.js';
import { evaluateRule } from './rules.js';
import type {
  MigrationAssessment,
  ResourceAssessment,
  MigrationSummary,
  MigrationPhase,
  MigrationBlocker,
  ManualAction,
} from './assessment.js';
import type { MigrationStatus, RiskLevel } from './strategy.js';
import { maxRisk, worseStatus } from './strategy.js';
import {
  logAnalysisStarted,
  logAnalysisCompleted,
  logResourceAnalysisStarted,
  logResourceAnalysisCompleted,
  logMigrationBlockerFound,
  logHighRiskResourceFound,
  type MigrationEventContext,
} from './events.js';

/**
 * MigrationAnalyzer
 *
 * Consumes an InfrastructureGraph + source/target regions and produces a
 * deterministic MigrationAssessment. It:
 *   - applies Migration Rules per resource (deterministic strategy/status/risk)
 *   - resolves direct + indirect dependencies from the graph
 *   - propagates status/risk from critical dependencies (dependency-aware)
 *   - detects migration blockers (only rule/data-derived, never fictional)
 *   - orders resources into phases by graph dependency topology
 *   - aggregates a summary
 *
 * NO AWS calls, NO side effects. Pure analysis.
 */
export class MigrationAnalyzer {
  /**
   * Edge types that represent a "hard" dependency for migration ordering and
   * status propagation. Containment inverse (CONTAINS) is excluded so we don't
   * treat "a VPC contains a subnet" as "the VPC depends on the subnet".
   */
  private static readonly DEPENDENCY_EDGE_TYPES = new Set<GraphEdge['type']>([
    'BELONGS_TO',
    'RUNS_IN',
    'USES',
    'TARGETS',
    'DEPENDS_ON',
    'CONNECTS_TO',
    'ASSUMES_ROLE',
    'READS_FROM',
    'WRITES_TO',
    'ROUTES_THROUGH',
    'ATTACHES_TO',
    'ASSOCIATED_WITH',
  ]);

  analyze(
    graph: InfrastructureGraph,
    sourceRegion: string,
    targetRegion: string
  ): MigrationAssessment {
    const assessmentId = `assessment-${randomUUID()}`;
    const baseCtx: MigrationEventContext = { assessmentId, sourceRegion, targetRegion };
    logAnalysisStarted(baseCtx, graph.nodes.length);

    const nodeIndex = new Map(graph.nodes.map((n) => [n.id, n] as const));
    const depAdjacency = this.buildDependencyAdjacency(graph);

    // Pass 1 — evaluate each resource in isolation via the rules.
    const assessments = new Map<string, ResourceAssessment>();
    for (const node of graph.nodes) {
      logResourceAnalysisStarted({ ...baseCtx, resourceId: node.id, resourceType: node.type });
      assessments.set(node.id, this.assessResource(node, sourceRegion, targetRegion, depAdjacency, nodeIndex));
    }

    // Pass 2 — dependency-aware propagation. A resource cannot be "cleaner" than
    // a critical dependency: unresolved/blocked dependencies raise status/risk.
    this.propagateDependencyEffects(assessments, depAdjacency, nodeIndex);

    // Emit per-resource completion + blocker/high-risk events after finalization.
    for (const a of assessments.values()) {
      const ctx = { ...baseCtx, resourceId: a.resourceId, resourceType: a.resourceType };
      for (const b of a.blockers) logMigrationBlockerFound(ctx, b.blocker, b.severity);
      if (a.risk === 'HIGH' || a.risk === 'CRITICAL') logHighRiskResourceFound(ctx, a.risk);
      logResourceAnalysisCompleted(ctx, a.strategy, a.migrationStatus, a.risk);
    }

    const resources = [...assessments.values()];
    const phases = this.buildPhases(graph, depAdjacency);
    const summary = this.buildSummary(resources, sourceRegion, targetRegion);
    const blockers = resources.flatMap((r) => r.blockers);
    const warnings = [...new Set(resources.flatMap((r) => r.warnings))];
    const highRiskResources = resources.filter((r) => r.risk === 'HIGH' || r.risk === 'CRITICAL').map((r) => r.resourceId);
    const manualActions: ManualAction[] = resources.flatMap((r) =>
      r.manualActions.map((action) => ({ resourceId: r.resourceId, action }))
    );

    logAnalysisCompleted(baseCtx, { totalResources: resources.length, risk: summary.risk });

    return {
      assessmentId,
      sourceRegion,
      targetRegion,
      createdAt: new Date().toISOString(),
      summary,
      resources,
      phases,
      blockers,
      warnings,
      highRiskResources,
      manualActions,
    };
  }

  // ── Per-resource assessment ─────────────────────────────────────────────────

  private assessResource(
    node: GraphNode,
    sourceRegion: string,
    targetRegion: string,
    depAdjacency: Map<string, Set<string>>,
    nodeIndex: Map<string, GraphNode>
  ): ResourceAssessment {
    const directDepIds = [...(depAdjacency.get(node.id) ?? [])];
    const dependencies = directDepIds.map((id) => nodeIndex.get(id)).filter((n): n is GraphNode => !!n);
    const indirectDependencies = this.collectTransitive(node.id, depAdjacency).filter(
      (id) => !directDepIds.includes(id) && id !== node.id
    );

    const rule = evaluateRule({ node, sourceRegion, targetRegion, dependencies });

    const blockers: MigrationBlocker[] = rule.blockers.map((b) => ({ ...b, resourceId: node.id }));

    return {
      resourceId: node.id,
      resourceType: node.type,
      name: node.name,
      sourceRegion,
      targetRegion,
      strategy: rule.strategy,
      migrationStatus: rule.status,
      risk: rule.baseRisk,
      riskReasons: [...rule.riskReasons],
      dependencies: directDepIds,
      indirectDependencies,
      requiredResources: [...rule.requiredTargetResources],
      manualActions: [...rule.manualActions],
      warnings: [...rule.warnings],
      blockers,
      reasoning: rule.reasoning,
    };
  }

  // ── Dependency-aware propagation ─────────────────────────────────────────────

  private propagateDependencyEffects(
    assessments: Map<string, ResourceAssessment>,
    depAdjacency: Map<string, Set<string>>,
    nodeIndex: Map<string, GraphNode>
  ): void {
    for (const a of assessments.values()) {
      for (const depId of depAdjacency.get(a.resourceId) ?? []) {
        const dep = assessments.get(depId);
        if (!dep) continue;

        // A dependency that cannot be migrated blocks this resource.
        if (dep.migrationStatus === 'NOT_SUPPORTED' || dep.migrationStatus === 'UNKNOWN') {
          a.migrationStatus = worseStatus(a.migrationStatus, 'REQUIRES_MANUAL_ACTION');
          a.blockers.push({
            resourceId: a.resourceId,
            blocker: 'DEPENDENCY_NOT_MIGRATABLE',
            severity: 'HIGH',
            description: `Depends on "${depId}" (${nodeIndex.get(depId)?.type ?? 'unknown'}) which is ${dep.migrationStatus}.`,
          });
          a.riskReasons.push(`Critical dependency ${depId} is ${dep.migrationStatus}`);
        } else if (dep.migrationStatus === 'REQUIRES_MANUAL_ACTION') {
          // Manual dependency means this resource isn't fully automatic either.
          a.migrationStatus = worseStatus(a.migrationStatus, 'SUPPORTED_WITH_CHANGES');
          a.warnings.push(`Dependency ${depId} requires a manual action before this resource can migrate.`);
        }

        // Risk never lower than a critical dependency's risk.
        if (dep.risk === 'HIGH' || dep.risk === 'CRITICAL') {
          a.risk = maxRisk(a.risk, dep.risk === 'CRITICAL' ? 'HIGH' : 'MEDIUM');
          a.riskReasons.push(`Depends on ${dep.risk.toLowerCase()}-risk resource ${depId}`);
        }
      }
      a.riskReasons = [...new Set(a.riskReasons)];
      a.warnings = [...new Set(a.warnings)];
    }
  }

  // ── Phases (topological, dependency-driven) ──────────────────────────────────

  /**
   * Order resources into phases using Kahn's algorithm over the dependency graph:
   * resources whose dependencies are already placed go into the next phase.
   * The phase NAME is a readable label derived from the dominant resource kinds;
   * the ORDER is purely dependency-driven, not a fixed service ranking.
   */
  private buildPhases(graph: InfrastructureGraph, depAdjacency: Map<string, Set<string>>): MigrationPhase[] {
    const remaining = new Set(graph.nodes.map((n) => n.id));
    const nodeIndex = new Map(graph.nodes.map((n) => [n.id, n] as const));
    const placed = new Set<string>();
    const layers: string[][] = [];

    let guard = 0;
    while (remaining.size > 0 && guard <= graph.nodes.length + 1) {
      const layer: string[] = [];
      for (const id of remaining) {
        const deps = [...(depAdjacency.get(id) ?? [])].filter((d) => remaining.has(d) && d !== id);
        // A node is ready when all its (still-remaining) deps are already placed.
        if (deps.every((d) => placed.has(d))) layer.push(id);
      }

      if (layer.length === 0) {
        // Cycle or unresolved deps — place the rest to avoid infinite loop.
        layers.push([...remaining]);
        break;
      }

      for (const id of layer) {
        remaining.delete(id);
        placed.add(id);
      }
      layers.push(layer);
      guard += 1;
    }

    return layers.map((ids, i) => ({
      order: i + 1,
      name: this.phaseName(i, ids, nodeIndex),
      resourceIds: ids,
    }));
  }

  private phaseName(index: number, ids: string[], nodeIndex: Map<string, GraphNode>): string {
    const types = ids.map((id) => nodeIndex.get(id)?.type ?? '');
    const has = (prefixes: string[]): boolean => types.some((t) => prefixes.some((p) => t.includes(p)));

    if (has(['::EC2::VPC', '::EC2::Subnet', '::EC2::RouteTable', '::EC2::InternetGateway', '::IAM::'])) {
      return `Phase ${index + 1} — Foundation (network & identity)`;
    }
    if (has(['::S3::', '::RDS::', '::SecretsManager::'])) {
      return `Phase ${index + 1} — Data`;
    }
    if (has(['::ECS::', '::ElasticLoadBalancingV2::', '::Lambda::', '::EC2::Instance'])) {
      return `Phase ${index + 1} — Compute`;
    }
    return `Phase ${index + 1} — Application`;
  }

  // ── Summary ─────────────────────────────────────────────────────────────────

  private buildSummary(
    resources: ResourceAssessment[],
    sourceRegion: string,
    targetRegion: string
  ): MigrationSummary {
    const count = (s: MigrationStatus): number => resources.filter((r) => r.migrationStatus === s).length;
    let overall: RiskLevel = 'LOW';
    for (const r of resources) overall = maxRisk(overall, r.risk);

    return {
      sourceRegion,
      targetRegion,
      totalResources: resources.length,
      supported: count('SUPPORTED'),
      supportedWithChanges: count('SUPPORTED_WITH_CHANGES'),
      manualAction: count('REQUIRES_MANUAL_ACTION'),
      notSupported: count('NOT_SUPPORTED'),
      unknown: count('UNKNOWN'),
      risk: resources.length === 0 ? 'LOW' : overall,
    };
  }

  // ── Graph helpers ─────────────────────────────────────────────────────────────

  /** node id → set of resource ids it depends on (hard dependency edges only). */
  private buildDependencyAdjacency(graph: InfrastructureGraph): Map<string, Set<string>> {
    const adjacency = new Map<string, Set<string>>();
    for (const node of graph.nodes) adjacency.set(node.id, new Set());
    for (const edge of graph.edges) {
      if (!MigrationAnalyzer.DEPENDENCY_EDGE_TYPES.has(edge.type)) continue;
      if (edge.source === edge.target) continue;
      adjacency.get(edge.source)?.add(edge.target);
    }
    return adjacency;
  }

  /** All transitive dependencies of a node (DFS, cycle-safe). */
  private collectTransitive(start: string, adjacency: Map<string, Set<string>>): string[] {
    const seen = new Set<string>();
    const stack = [...(adjacency.get(start) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id) || id === start) continue;
      seen.add(id);
      for (const next of adjacency.get(id) ?? []) if (!seen.has(next)) stack.push(next);
    }
    return [...seen];
  }
}

/** Convenience functional entry point. */
export function analyzeMigration(
  graph: InfrastructureGraph,
  sourceRegion: string,
  targetRegion: string
): MigrationAssessment {
  return new MigrationAnalyzer().analyze(graph, sourceRegion, targetRegion);
}
