import { buildGraph } from '../../domain/graph/builder.js';
import { InMemoryGraphRepository } from '../../repositories/graph/in-memory-graph.repository.js';
import { makeMockInventory } from '../fixtures/mock-inventory.js';
import type { GraphNode } from '../../domain/graph/node.js';
import type { GraphEdge } from '../../domain/graph/edge.js';

async function loadedRepo(): Promise<InMemoryGraphRepository> {
  const repo = new InMemoryGraphRepository();
  await repo.saveGraph(buildGraph(makeMockInventory()));
  return repo;
}

const newNode: GraphNode = {
  id: 'lambda-worker',
  arn: 'arn:aws:lambda:us-east-1:123456789012:function:worker',
  type: 'AWS::Lambda::Function',
  name: 'worker',
  region: 'us-east-1',
  accountId: '123456789012',
  properties: { runtime: 'nodejs22.x' },
};

describe('incremental graph updates', () => {
  it('adds a node without a full rebuild', async () => {
    const repo = await loadedRepo();
    await repo.addNode(newNode);
    expect((await repo.getNode('lambda-worker'))?.name).toBe('worker');
  });

  it('updates a node in place', async () => {
    const repo = await loadedRepo();
    await repo.updateNode({ ...newNode });
    await repo.updateNode({ ...newNode, name: 'worker-v2' });
    expect((await repo.getNode('lambda-worker'))?.name).toBe('worker-v2');
  });

  it('adds an edge and reflects it in dependencies', async () => {
    const repo = await loadedRepo();
    await repo.addNode(newNode);
    const edge: GraphEdge = { source: 'lambda-worker', target: 'private-subnet', type: 'RUNS_IN' };
    await repo.addEdge(edge);
    const deps = await repo.getDependencies('lambda-worker');
    expect(deps.map((d) => d.node.id)).toContain('private-subnet');
  });

  it('deduplicates edges added twice', async () => {
    const repo = await loadedRepo();
    await repo.addNode(newNode);
    const edge: GraphEdge = { source: 'lambda-worker', target: 'private-subnet', type: 'RUNS_IN' };
    await repo.addEdge(edge);
    await repo.addEdge(edge);
    expect(await repo.getDependencies('lambda-worker')).toHaveLength(1);
  });

  it('removes an edge', async () => {
    const repo = await loadedRepo();
    await repo.removeEdge({ source: 'ecs-api', target: 'sg-app', type: 'USES' });
    const deps = await repo.getDependencies('ecs-api');
    expect(deps.map((d) => d.node.id)).not.toContain('sg-app');
  });

  it('removes a node and all its incident edges', async () => {
    const repo = await loadedRepo();
    await repo.removeNode('private-subnet');
    expect(await repo.getNode('private-subnet')).toBeUndefined();
    // ecs-api no longer has a RUNS_IN edge to the removed subnet.
    const deps = await repo.getDependencies('ecs-api');
    expect(deps.map((d) => d.node.id)).not.toContain('private-subnet');
    // The subnet is gone from the dependents view of the VPC too.
    const dependents = await repo.getDependents('vpc-1');
    expect(dependents.map((d) => d.node.id)).not.toContain('private-subnet');
  });

  it('replaces all outgoing relationships of a node', async () => {
    const repo = await loadedRepo();
    const replacement: GraphEdge[] = [
      { source: 'ecs-api', target: 'cluster-1', type: 'BELONGS_TO' },
    ];
    await repo.updateRelationships('ecs-api', replacement);
    const deps = await repo.getDependencies('ecs-api');
    expect(deps).toHaveLength(1);
    expect(deps[0]?.node.id).toBe('cluster-1');
  });

  it('keeps metadata counts consistent after mutations', async () => {
    const repo = await loadedRepo();
    const before = (await repo.getGraph()).metadata.nodeCount;
    await repo.addNode(newNode);
    const after = (await repo.getGraph()).metadata.nodeCount;
    expect(after).toBe(before + 1);
  });
});
