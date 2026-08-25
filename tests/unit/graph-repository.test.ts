import { buildGraph, InfrastructureGraphBuilder } from '../../domain/graph/builder.js';
import { InMemoryGraphRepository } from '../../repositories/graph/in-memory-graph.repository.js';
import { makeMockInventory, makeEmptyInventory } from '../fixtures/mock-inventory.js';

async function loadedRepo(): Promise<InMemoryGraphRepository> {
  const repo = new InMemoryGraphRepository();
  await repo.saveGraph(buildGraph(makeMockInventory()));
  return repo;
}

describe('InMemoryGraphRepository', () => {
  describe('reads', () => {
    it('gets a node by id', async () => {
      const repo = await loadedRepo();
      const node = await repo.getNode('ecs-api');
      expect(node?.name).toBe('api');
    });

    it('gets nodes by type', async () => {
      const repo = await loadedRepo();
      const subnets = await repo.getNodesByType('AWS::EC2::Subnet');
      expect(subnets.map((n) => n.id).sort()).toEqual(['private-subnet', 'public-subnet']);
    });
  });

  describe('dependencies', () => {
    it('returns what the ECS service depends on with relationship semantics', async () => {
      const repo = await loadedRepo();
      const deps = await repo.getDependencies('ecs-api');
      const byTarget = Object.fromEntries(deps.map((d) => [d.node.id, d.relationship]));
      expect(byTarget['tg-1']).toBe('TARGETS');
      expect(byTarget['private-subnet']).toBe('RUNS_IN');
      expect(byTarget['sg-app']).toBe('USES');
      expect(byTarget['cluster-1']).toBe('BELONGS_TO');
      expect(byTarget['role-app']).toBe('USES');
    });
  });

  describe('dependents', () => {
    it('returns resources that depend on the RDS instance', async () => {
      const repo = await loadedRepo();
      const dependents = await repo.getDependents('rds-prod');
      // In the fixture the app→DB link is not derivable, so direct dependents of
      // rds-prod are none — this documents the known limitation honestly.
      expect(dependents).toHaveLength(0);
    });

    it('returns dependents of a shared subnet', async () => {
      const repo = await loadedRepo();
      const dependents = await repo.getDependents('private-subnet');
      const ids = dependents.map((d) => d.node.id).sort();
      expect(ids).toContain('ecs-api');
      expect(ids).toContain('rds-prod');
    });
  });

  describe('impact analysis', () => {
    it('computes transitively affected resources for a subnet', async () => {
      const repo = await loadedRepo();
      const impact = await repo.getImpact('private-subnet');
      const ids = impact.affectedResources.map((a) => a.id);
      expect(impact.resource).toBe('private-subnet');
      expect(ids).toEqual(expect.arrayContaining(['ecs-api', 'rds-prod']));
      expect(impact.affectedResources.every((a) => a.depth >= 1)).toBe(true);
    });

    it('returns empty impact for an unknown resource', async () => {
      const repo = await loadedRepo();
      const impact = await repo.getImpact('does-not-exist');
      expect(impact.affectedResources).toHaveLength(0);
    });
  });

  describe('path finding', () => {
    it('finds a directed path from ALB to the target group', async () => {
      const repo = await loadedRepo();
      const path = await repo.findPath('alb-1', 'tg-1');
      expect(path?.nodes).toEqual(['alb-1', 'tg-1']);
      expect(path?.hops[0]?.relationship).toBe('TARGETS');
    });

    it('finds a path that traverses containment edges when one exists', async () => {
      const repo = await loadedRepo();
      // rds-prod RUNS_IN private-subnet BELONGS_TO vpc-1 CONTAINS alb-1.
      // The derived CONTAINS edges make alb-1 reachable from rds-prod.
      const path = await repo.findPath('rds-prod', 'alb-1');
      expect(path?.nodes).toEqual(['rds-prod', 'private-subnet', 'vpc-1', 'alb-1']);
    });

    it('returns undefined when the target is genuinely unreachable', async () => {
      // With containment derivation OFF there is no upward path from a leaf.
      const isolated = new InMemoryGraphRepository();
      await isolated.saveGraph(
        new InfrastructureGraphBuilder({ deriveContainment: false }).build(makeMockInventory())
      );
      const path = await isolated.findPath('rds-prod', 'alb-1');
      expect(path).toBeUndefined();
    });

    it('returns a trivial path for identical endpoints', async () => {
      const repo = await loadedRepo();
      const path = await repo.findPath('vpc-1', 'vpc-1');
      expect(path).toEqual({ nodes: ['vpc-1'], hops: [] });
    });
  });

  describe('export', () => {
    it('serializes to nodes/edges for visualization', async () => {
      const repo = await loadedRepo();
      const exported = await repo.exportGraph();
      expect(Array.isArray(exported.nodes)).toBe(true);
      expect(Array.isArray(exported.edges)).toBe(true);
      expect(exported.nodes[0]).toHaveProperty('data.label');
      expect(exported.edges[0]).toHaveProperty('label');
    });

    it('exports an empty graph cleanly', async () => {
      const repo = new InMemoryGraphRepository();
      await repo.saveGraph(buildGraph(makeEmptyInventory()));
      const exported = await repo.exportGraph();
      expect(exported).toEqual({ nodes: [], edges: [] });
    });
  });
});
