/**
 * Unit tests for KuzuGraphRepository — the SHARED graph store.
 * Proves that a graph written by one instance is visible to another instance
 * pointing at the same Kuzu directory (i.e. what lets the 3 MCP agents share it).
 */

import { KuzuGraphRepository } from '../../repositories/graph/kuzu-graph.repository.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InfrastructureGraph } from '../../domain/graph/graph.js';
import type { GraphNode } from '../../domain/graph/node.js';
import type { GraphEdge } from '../../domain/graph/edge.js';

function node(id: string, type: GraphNode['type'], name = id): GraphNode {
  return { id, arn: `arn:${id}`, type, name, region: 'us-east-1', accountId: '123456789012', properties: {} };
}

function makeGraph(): InfrastructureGraph {
  const nodes: GraphNode[] = [
    node('vpc-1', 'AWS::EC2::VPC', 'prod-vpc'),
    node('subnet-1', 'AWS::EC2::Subnet', 'private-1a'),
    node('svc-1', 'AWS::ECS::Service', 'api-service'),
    node('rds-1', 'AWS::RDS::DBInstance', 'prod-db'),
  ];
  const edges: GraphEdge[] = [
    { source: 'subnet-1', target: 'vpc-1', type: 'BELONGS_TO' },
    { source: 'svc-1', target: 'subnet-1', type: 'RUNS_IN' },
    { source: 'svc-1', target: 'rds-1', type: 'CONNECTS_TO', metadata: { port: 5432 } },
  ];
  return {
    nodes,
    edges,
    issues: [],
    metadata: {
      regions: ['us-east-1'], accountIds: ['123456789012'],
      builtAt: new Date().toISOString(),
      nodeCount: nodes.length, edgeCount: edges.length, orphanNodeCount: 0,
    },
  };
}

describe('KuzuGraphRepository', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kuzu-graph-'));
    dbPath = join(tmpDir, 'graph');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should save and read back a graph', async () => {
    const repo = new KuzuGraphRepository(dbPath);
    await repo.init();
    await repo.saveGraph(makeGraph());

    const g = await repo.getGraph();
    expect(g.nodes).toHaveLength(4);
    expect(g.edges).toHaveLength(3);
    await repo.close();
  });

  it('should share the graph across two separate instances (the whole point)', async () => {
    // Instance A (e.g. discovery/graph agent) writes.
    const writer = new KuzuGraphRepository(dbPath);
    await writer.init();
    await writer.saveGraph(makeGraph());
    await writer.close();

    // Instance B (e.g. migration agent) opens the SAME dir and reads — no re-scan.
    const reader = new KuzuGraphRepository(dbPath);
    await reader.init();
    const g = await reader.getGraph();
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['rds-1', 'subnet-1', 'svc-1', 'vpc-1']);
    expect(g.edges).toHaveLength(3);

    // Traversal works on the reader too.
    const deps = await reader.getDependencies('svc-1');
    const depIds = deps.map((d) => d.node.id).sort();
    expect(depIds).toContain('subnet-1');
    expect(depIds).toContain('rds-1');
    await reader.close();
  });

  it('should answer dependents and impact from persisted data', async () => {
    const repo = new KuzuGraphRepository(dbPath);
    await repo.init();
    await repo.saveGraph(makeGraph());

    const dependents = await repo.getDependents('vpc-1');
    expect(dependents.map((d) => d.node.id)).toContain('subnet-1');

    const impact = await repo.getImpact('vpc-1');
    expect(impact.affectedResources.length).toBeGreaterThan(0);
    await repo.close();
  });

  it('should preserve edge metadata JSON round-trip', async () => {
    const repo = new KuzuGraphRepository(dbPath);
    await repo.init();
    await repo.saveGraph(makeGraph());

    const exported = await repo.exportGraph();
    const connectsTo = exported.edges.find((e) => e.type === 'CONNECTS_TO');
    expect(connectsTo).toBeDefined();
    expect(connectsTo!.metadata['port']).toBe(5432);
    await repo.close();
  });

  it('should support incremental addNode / addEdge with write-through persistence', async () => {
    const writer = new KuzuGraphRepository(dbPath);
    await writer.init();
    await writer.saveGraph(makeGraph());
    await writer.addNode(node('lambda-1', 'AWS::Lambda::Function', 'authorizer'));
    await writer.addEdge({ source: 'lambda-1', target: 'rds-1', type: 'CONNECTS_TO' });
    await writer.close();

    const reader = new KuzuGraphRepository(dbPath);
    await reader.init();
    const g = await reader.getGraph();
    expect(g.nodes.map((n) => n.id)).toContain('lambda-1');
    const lambdaDeps = await reader.getDependencies('lambda-1');
    expect(lambdaDeps.map((d) => d.node.id)).toContain('rds-1');
    await reader.close();
  });

  it('should replace the graph on re-save', async () => {
    const repo = new KuzuGraphRepository(dbPath);
    await repo.init();
    await repo.saveGraph(makeGraph());

    const smaller: InfrastructureGraph = {
      nodes: [node('only-1', 'AWS::S3::Bucket', 'bucket')],
      edges: [],
      issues: [],
      metadata: {
        regions: ['us-east-1'], accountIds: ['123456789012'],
        builtAt: new Date().toISOString(), nodeCount: 1, edgeCount: 0, orphanNodeCount: 1,
      },
    };
    await repo.saveGraph(smaller);

    const g = await repo.getGraph();
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]!.id).toBe('only-1');
    await repo.close();
  });
});
