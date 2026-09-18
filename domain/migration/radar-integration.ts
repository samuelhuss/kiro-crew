import type { InfrastructureGraph } from '../graph/graph.js';
import type { GraphNode } from '../graph/node.js';
import { issue } from '../graph/errors.js';
import type { ClassifiedResourceItem } from '../resources/total-inventory.js';
import type { ResourceType } from '../resources/resource.js';
import { deriveResourceIdFromArn } from '../resources/arn-utils.js';
import { hasMigrationRule } from './rules.js';

export interface RadarMergeResult {
  graph: InfrastructureGraph;
  /** Node ids actually added to the graph. */
  mergedNodeIds: string[];
  /** Items considered but not merged, each with an explicit reason — never silent. */
  skipped: Array<{ arn: string; reason: string }>;
}

/**
 * Merge total-inventory ("radar") items into the infrastructure graph as
 * isolated nodes, so they can be assessed/planned even without a dedicated
 * Stage-1 collector.
 *
 * Only merges items where:
 *   - AWS Config already has their configuration (fidelity FIDELITY_VIA_CONFIG
 *     — ALREADY_FIDELITY items are Stage-1 resources already in the graph;
 *     RADAR_ONLY items have no config to act on at all).
 *   - relevance is not NOISE (AWS-managed scaffolding is not migrated).
 *   - a deterministic migration rule exists for the type (otherwise the
 *     analyzer would just mark it UNKNOWN anyway).
 *   - a physical id can be derived from the ARN.
 *
 * Merged nodes have NO edges — they never went through a collector, so their
 * dependencies are genuinely unknown. This is recorded as an explicit
 * RADAR_SOURCED_NODE issue, not hidden as an ordinary orphan.
 */
export function mergeRadarItemsIntoGraph(
  graph: InfrastructureGraph,
  items: ClassifiedResourceItem[],
  accountId: string
): RadarMergeResult {
  const existingIds = new Set(graph.nodes.map((n) => n.id));
  const mergedNodeIds: string[] = [];
  const skipped: Array<{ arn: string; reason: string }> = [];
  const newNodes: GraphNode[] = [];
  const newIssues = [...graph.issues];

  for (const item of items) {
    if (item.fidelity !== 'FIDELITY_VIA_CONFIG') continue;

    if (item.relevance === 'NOISE') {
      skipped.push({ arn: item.arn, reason: 'Classified as NOISE (AWS-managed scaffolding) — not migrated.' });
      continue;
    }
    if (!hasMigrationRule(item.resourceType)) {
      skipped.push({ arn: item.arn, reason: `No deterministic migration rule defined yet for "${item.resourceType}".` });
      continue;
    }
    const id = deriveResourceIdFromArn(item.arn);
    if (!id) {
      skipped.push({ arn: item.arn, reason: 'Could not derive a physical resource id from the ARN.' });
      continue;
    }
    if (existingIds.has(id)) {
      skipped.push({ arn: item.arn, reason: 'Already present in the graph (Stage-1 collector covers it).' });
      continue;
    }

    newNodes.push({
      id,
      arn: item.arn,
      type: item.resourceType as ResourceType,
      name: id,
      region: item.region,
      accountId,
      properties: {},
    });
    existingIds.add(id);
    mergedNodeIds.push(id);
    newIssues.push(
      issue(
        'RADAR_SOURCED_NODE',
        'info',
        `"${id}" (${item.resourceType}) came from the total-inventory radar step (AWS Config), not a Stage-1 collector — its dependencies are unknown.`,
        [id]
      )
    );
  }

  if (newNodes.length === 0) {
    return { graph, mergedNodeIds, skipped };
  }

  const allNodes = [...graph.nodes, ...newNodes];
  return {
    graph: {
      nodes: allNodes,
      edges: graph.edges,
      issues: newIssues,
      metadata: {
        ...graph.metadata,
        regions: [...new Set(allNodes.map((n) => n.region))].sort(),
        accountIds: [...new Set(allNodes.map((n) => n.accountId))].sort(),
        nodeCount: allNodes.length,
        orphanNodeCount: graph.metadata.orphanNodeCount + newNodes.length,
      },
    },
    mergedNodeIds,
    skipped,
  };
}
