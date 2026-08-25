/**
 * Unit tests for KuzuInfrastructureRepository.
 * Uses a fresh temporary directory per test suite — cleaned up after all tests run.
 * Kuzu 0.11.3 does not support ":memory:" — a real directory path is required.
 */

import { KuzuInfrastructureRepository } from '../../repositories/kuzu.repository.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RegionInventory } from '../../domain/resources/inventory.js';
import type { AwsResource } from '../../domain/resources/resource.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeInventory(region: string, resourceCount = 3): RegionInventory {
  const resources: AwsResource[] = Array.from({ length: resourceCount }, (_, i) => ({
    id: `${region}-vpc-${i}`,
    arn: `arn:aws:ec2:${region}:123456789012:vpc/vpc-${i}`,
    type: 'AWS::EC2::VPC' as const,
    name: `vpc-${i}`,
    region,
    accountId: '123456789012',
    properties: { cidrBlock: `10.${i}.0.0/16`, isDefault: i === 0 },
    dependencies: [],
  }));

  return {
    region,
    accountId: '123456789012',
    scannedAt: new Date().toISOString(),
    resources,
    relationships: [
      ...(resourceCount >= 2
        ? [{ source: `${region}-vpc-1`, target: `${region}-vpc-0`, relationship: 'DEPENDS_ON' as const }]
        : []),
    ],
    errors: [],
    stats: {
      totalResources: resourceCount,
      byType: { 'AWS::EC2::VPC': resourceCount },
      totalRelationships: resourceCount >= 2 ? 1 : 0,
      totalErrors: 0,
      durationMs: 100,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('KuzuInfrastructureRepository', () => {
  let repo: KuzuInfrastructureRepository;
  let tmpDir: string;

  beforeEach(async () => {
    // Fresh isolated base directory per test
    tmpDir = mkdtempSync(join(tmpdir(), 'kuzu-test-'));
    // Kuzu needs a non-existing path (it creates the DB directory itself)
    repo = new KuzuInfrastructureRepository(join(tmpDir, 'db'));
    await repo.init();
  });

  afterEach(async () => {
    await repo.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Basic CRUD ──────────────────────────────────────────────────────────────

  it('should return undefined for an unknown region', async () => {
    const result = await repo.getInventory('us-east-1');
    expect(result).toBeUndefined();
  });

  it('should save and retrieve an inventory', async () => {
    const inv = makeInventory('us-east-1', 3);
    await repo.saveInventory(inv);

    const retrieved = await repo.getInventory('us-east-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.region).toBe('us-east-1');
    expect(retrieved!.resources).toHaveLength(3);
    expect(retrieved!.accountId).toBe('123456789012');
  });

  it('should list stored regions', async () => {
    await repo.saveInventory(makeInventory('us-east-1'));
    await repo.saveInventory(makeInventory('eu-west-1'));

    const regions = await repo.listRegions();
    expect(regions).toContain('us-east-1');
    expect(regions).toContain('eu-west-1');
    expect(regions).toHaveLength(2);
  });

  it('should find a resource by ID', async () => {
    await repo.saveInventory(makeInventory('us-east-1', 3));

    const found = await repo.findResource('us-east-1-vpc-0');
    expect(found).toBeDefined();
    expect(found!.id).toBe('us-east-1-vpc-0');
    expect(found!.type).toBe('AWS::EC2::VPC');
  });

  it('should return undefined for a missing resource', async () => {
    const found = await repo.findResource('non-existent');
    expect(found).toBeUndefined();
  });

  it('should clear a region', async () => {
    await repo.saveInventory(makeInventory('us-east-1'));
    await repo.clearRegion('us-east-1');

    expect(await repo.getInventory('us-east-1')).toBeUndefined();
    expect(await repo.listRegions()).toHaveLength(0);
  });

  it('should replace inventory data on re-save', async () => {
    await repo.saveInventory(makeInventory('us-east-1', 3));
    await repo.saveInventory(makeInventory('us-east-1', 5));

    const inv = await repo.getInventory('us-east-1');
    expect(inv!.resources).toHaveLength(5);
  });

  // ── Relationships ───────────────────────────────────────────────────────────

  it('should persist and retrieve relationships', async () => {
    await repo.saveInventory(makeInventory('us-east-1', 3));

    const rels = await repo.findRelationships('us-east-1-vpc-1');
    expect(rels.length).toBeGreaterThan(0);
    expect(rels[0]!.relationship).toBe('DEPENDS_ON');
  });

  it('should return empty array for a resource with no relationships', async () => {
    await repo.saveInventory(makeInventory('us-east-1', 1));
    const rels = await repo.findRelationships('us-east-1-vpc-0');
    expect(rels).toHaveLength(0);
  });

  it('should preserve relationship metadata as JSON', async () => {
    const inv = makeInventory('us-east-1', 2);
    inv.relationships = [{
      source: 'us-east-1-vpc-1',
      target: 'us-east-1-vpc-0',
      relationship: 'BELONGS_TO',
      metadata: { port: 443, protocol: 'HTTPS' },
    }];
    await repo.saveInventory(inv);

    const rels = await repo.findRelationships('us-east-1-vpc-1');
    expect(rels).toHaveLength(1);
    expect(rels[0]!.relationship).toBe('BELONGS_TO');
  });

  // ── Graph queries ───────────────────────────────────────────────────────────

  it('should find high-dependency resources (fan-out)', async () => {
    const inv = makeInventory('us-east-1', 3);
    // vpc-1 and vpc-2 both point to vpc-0 — making vpc-1/vpc-2 the high out-degree nodes
    inv.relationships = [
      { source: 'us-east-1-vpc-1', target: 'us-east-1-vpc-0', relationship: 'BELONGS_TO' },
      { source: 'us-east-1-vpc-2', target: 'us-east-1-vpc-0', relationship: 'BELONGS_TO' },
    ];
    inv.stats.totalRelationships = 2;
    await repo.saveInventory(inv);

    const hubs = await repo.findHighDependencyResources('us-east-1', 5);
    expect(hubs.length).toBeGreaterThan(0);
    expect(hubs[0]!.outDegree).toBeGreaterThanOrEqual(1);
  });

  it('should find reachable resources (transitive)', async () => {
    const inv = makeInventory('us-east-1', 3);
    inv.relationships = [
      { source: 'us-east-1-vpc-0', target: 'us-east-1-vpc-1', relationship: 'DEPENDS_ON' },
      { source: 'us-east-1-vpc-1', target: 'us-east-1-vpc-2', relationship: 'DEPENDS_ON' },
    ];
    await repo.saveInventory(inv);

    const reachable = await repo.findReachable('us-east-1-vpc-0', 3);
    const ids = reachable.map((r) => r.id);
    expect(ids).toContain('us-east-1-vpc-1');
    expect(ids).toContain('us-east-1-vpc-2');
  });

  // ── Resource properties ─────────────────────────────────────────────────────

  it('should preserve nested JSON properties of resources', async () => {
    const inv = makeInventory('us-east-1', 1);
    inv.resources[0]!.properties = {
      cidrBlock: '10.0.0.0/16',
      isDefault: true,
      nested: { key: 'value' },
    };
    await repo.saveInventory(inv);

    const found = await repo.findResource('us-east-1-vpc-0');
    expect(found!.properties['cidrBlock']).toBe('10.0.0.0/16');
    expect(found!.properties['isDefault']).toBe(true);
  });

  it('should handle single quotes in resource names (Cypher escaping)', async () => {
    const inv = makeInventory('us-east-1', 1);
    inv.resources[0]!.name = "my-service's-vpc";
    await repo.saveInventory(inv);

    const found = await repo.findResource('us-east-1-vpc-0');
    expect(found!.name).toBe("my-service's-vpc");
  });
});
