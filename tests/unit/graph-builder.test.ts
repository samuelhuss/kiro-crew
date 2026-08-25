import { InfrastructureGraphBuilder, buildGraph } from '../../domain/graph/builder.js';
import { edgeKey } from '../../domain/graph/edge.js';
import {
  makeMockInventory,
  makeEmptyInventory,
  makeInconsistentInventory,
} from '../fixtures/mock-inventory.js';

describe('InfrastructureGraphBuilder', () => {
  describe('node creation', () => {
    it('creates one node per resource', () => {
      const graph = buildGraph(makeMockInventory());
      expect(graph.nodes).toHaveLength(13);
      expect(graph.nodes.find((n) => n.id === 'ecs-api')?.type).toBe('AWS::ECS::Service');
    });

    it('carries region, account and properties onto the node', () => {
      const graph = buildGraph(makeMockInventory());
      const vpc = graph.nodes.find((n) => n.id === 'vpc-1');
      expect(vpc).toMatchObject({ region: 'us-east-1', accountId: '123456789012' });
      expect(vpc?.properties['cidrBlock']).toBe('10.0.0.0/16');
    });
  });

  describe('edge creation', () => {
    it('maps discovered relationships preserving meaning (no forced DEPENDS_ON)', () => {
      const graph = buildGraph(makeMockInventory());
      const types = new Set(graph.edges.map((e) => e.type));
      expect(types.has('BELONGS_TO')).toBe(true);
      expect(types.has('RUNS_IN')).toBe(true);
      expect(types.has('USES')).toBe(true);
      expect(types.has('TARGETS')).toBe(true);
      expect(graph.edges.every((e) => e.type !== 'DEPENDS_ON')).toBe(true);
    });

    it('derives inverse CONTAINS edges for containment', () => {
      const graph = buildGraph(makeMockInventory());
      const contains = graph.edges.filter(
        (e) => e.type === 'CONTAINS' && e.source === 'vpc-1' && e.target === 'public-subnet'
      );
      expect(contains).toHaveLength(1);
    });

    it('derives BELONGS_TO VPC from the vpcId property (security groups)', () => {
      const graph = buildGraph(makeMockInventory());
      const belongs = graph.edges.find(
        (e) => e.source === 'sg-web' && e.target === 'vpc-1' && e.type === 'BELONGS_TO'
      );
      expect(belongs).toBeDefined();
      expect(belongs?.metadata?.['derived']).toBe('from-property:vpcId');
    });

    it('can disable containment derivation', () => {
      const graph = new InfrastructureGraphBuilder({ deriveContainment: false }).build(makeMockInventory());
      expect(graph.edges.some((e) => e.type === 'CONTAINS')).toBe(false);
    });
  });

  describe('deduplication', () => {
    it('deduplicates duplicate nodes and edges', () => {
      const graph = buildGraph(makeInconsistentInventory());
      const nodeIds = graph.nodes.map((n) => n.id);
      expect(nodeIds.filter((id) => id === 'subnet-1')).toHaveLength(1);
      expect(graph.issues.some((i) => i.kind === 'DUPLICATE_NODE')).toBe(true);

      const keys = graph.edges.map((e) => edgeKey(e));
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  describe('reference validation', () => {
    it('rejects edges pointing to missing nodes and records a DANGLING_EDGE issue', () => {
      const graph = buildGraph(makeInconsistentInventory());
      expect(graph.edges.some((e) => e.target === 'vpc-999')).toBe(false);
      expect(graph.issues.some((i) => i.kind === 'DANGLING_EDGE')).toBe(true);
    });

    it('flags malformed ARNs without dropping the node', () => {
      const graph = buildGraph(makeInconsistentInventory());
      expect(graph.nodes.some((n) => n.id === 'bad-arn')).toBe(true);
      expect(graph.issues.some((i) => i.kind === 'INVALID_ARN')).toBe(true);
    });
  });

  describe('orphan detection', () => {
    it('reports nodes with no relationships', () => {
      const graph = buildGraph(makeMockInventory());
      const orphanIssue = graph.issues.find((i) => i.kind === 'ORPHAN_NODE');
      expect(orphanIssue?.subjects).toContain('orphan-bucket');
    });
  });

  describe('known limitations', () => {
    it('records that S3 consumer access is not derivable', () => {
      const graph = buildGraph(makeMockInventory());
      expect(
        graph.issues.some((i) => i.kind === 'UNKNOWN_RELATIONSHIP' && i.relationship === 'READS_FROM')
      ).toBe(true);
    });
  });

  describe('empty and partial inventories', () => {
    it('builds an empty graph from an empty inventory', () => {
      const graph = buildGraph(makeEmptyInventory());
      expect(graph.nodes).toHaveLength(0);
      expect(graph.edges).toHaveLength(0);
      expect(graph.metadata.nodeCount).toBe(0);
    });

    it('tolerates a partially incomplete inventory (edges but missing endpoints)', () => {
      const graph = buildGraph(makeInconsistentInventory());
      // Build must not throw and must still produce the valid subset.
      expect(graph.nodes.length).toBeGreaterThan(0);
      expect(graph.edges.some((e) => e.source === 'subnet-1' && e.target === 'vpc-1')).toBe(true);
    });
  });

  describe('metadata', () => {
    it('summarizes regions, accounts and counts', () => {
      const graph = buildGraph(makeMockInventory());
      expect(graph.metadata.regions).toEqual(['global', 'us-east-1']);
      expect(graph.metadata.accountIds).toEqual(['123456789012']);
      expect(graph.metadata.nodeCount).toBe(graph.nodes.length);
      expect(graph.metadata.edgeCount).toBe(graph.edges.length);
    });
  });
});
