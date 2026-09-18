import { mergeRadarItemsIntoGraph } from '../../domain/migration/radar-integration.js';
import type { InfrastructureGraph } from '../../domain/graph/graph.js';
import type { ClassifiedResourceItem } from '../../domain/resources/total-inventory.js';

function emptyGraph(): InfrastructureGraph {
  return {
    nodes: [],
    edges: [],
    issues: [],
    metadata: {
      regions: [], accountIds: [], builtAt: new Date(0).toISOString(),
      nodeCount: 0, edgeCount: 0, orphanNodeCount: 0,
    },
  };
}

function radarItem(overrides: Partial<ClassifiedResourceItem> = {}): ClassifiedResourceItem {
  return {
    arn: 'arn:aws:events:us-east-1:123456789012:rule/my-rule',
    resourceType: 'AWS::Events::Rule',
    region: 'us-east-1',
    tags: {},
    source: 'RESOURCE_EXPLORER',
    fidelity: 'FIDELITY_VIA_CONFIG',
    fidelityReason: 'AWS Config tracks this resource.',
    relevance: 'CORE',
    relevanceReason: 'No AWS-managed-scaffolding pattern matched.',
    ...overrides,
  };
}

describe('mergeRadarItemsIntoGraph', () => {
  it('merges an eligible FIDELITY_VIA_CONFIG/CORE item as an isolated node', () => {
    const result = mergeRadarItemsIntoGraph(emptyGraph(), [radarItem()], '123456789012');

    expect(result.mergedNodeIds).toEqual(['my-rule']);
    expect(result.skipped).toHaveLength(0);
    expect(result.graph.nodes).toHaveLength(1);
    expect(result.graph.nodes[0]).toMatchObject({ id: 'my-rule', type: 'AWS::Events::Rule', accountId: '123456789012' });
    expect(result.graph.issues.some((i) => i.kind === 'RADAR_SOURCED_NODE')).toBe(true);
    expect(result.graph.metadata.nodeCount).toBe(1);
    expect(result.graph.metadata.orphanNodeCount).toBe(1);
  });

  it('skips NOISE items with an explicit reason', () => {
    const result = mergeRadarItemsIntoGraph(emptyGraph(), [radarItem({ relevance: 'NOISE' })], '123456789012');

    expect(result.mergedNodeIds).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/NOISE/);
  });

  it('skips items with no deterministic migration rule for the type', () => {
    const result = mergeRadarItemsIntoGraph(
      emptyGraph(),
      [radarItem({ resourceType: 'AWS::MediaConvert::JobTemplate', arn: 'arn:aws:mediaconvert:us-east-1:123456789012:jobTemplates/x' })],
      '123456789012'
    );

    expect(result.mergedNodeIds).toHaveLength(0);
    expect(result.skipped[0]!.reason).toMatch(/No deterministic migration rule/);
  });

  it('does not merge an item whose id already exists in the graph', () => {
    const graph = emptyGraph();
    graph.nodes.push({ id: 'my-rule', arn: 'x', type: 'AWS::Events::Rule', name: 'my-rule', region: 'us-east-1', accountId: '123456789012', properties: {} });

    const result = mergeRadarItemsIntoGraph(graph, [radarItem()], '123456789012');

    expect(result.mergedNodeIds).toHaveLength(0);
    expect(result.skipped[0]!.reason).toMatch(/Already present/);
  });

  it('ignores ALREADY_FIDELITY and RADAR_ONLY items (out of scope for this merge)', () => {
    const result = mergeRadarItemsIntoGraph(
      emptyGraph(),
      [radarItem({ fidelity: 'ALREADY_FIDELITY' }), radarItem({ fidelity: 'RADAR_ONLY', arn: 'arn:aws:events:us-east-1:123456789012:rule/other' })],
      '123456789012'
    );

    expect(result.mergedNodeIds).toHaveLength(0);
    expect(result.graph.nodes).toHaveLength(0);
  });
});
