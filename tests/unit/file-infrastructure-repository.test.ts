/**
 * Unit tests for FileInfrastructureRepository — the JSON-backed inventory store.
 * Proves persistence, cross-instance sharing (what the discovery + graph agents
 * rely on), and that two instances on the same dir do NOT collide (no lock).
 */

import { FileInfrastructureRepository } from '../../repositories/file-infrastructure.repository.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RegionInventory } from '../../domain/resources/inventory.js';
import type { AwsResource } from '../../domain/resources/resource.js';

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
    relationships:
      resourceCount >= 2
        ? [{ source: `${region}-vpc-1`, target: `${region}-vpc-0`, relationship: 'DEPENDS_ON' as const }]
        : [],
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

describe('FileInfrastructureRepository', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'file-inv-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return undefined for an unknown region', async () => {
    const repo = new FileInfrastructureRepository(tmpDir);
    await repo.init();
    expect(await repo.getInventory('us-east-1')).toBeUndefined();
  });

  it('should save and retrieve an inventory', async () => {
    const repo = new FileInfrastructureRepository(tmpDir);
    await repo.init();
    await repo.saveInventory(makeInventory('us-east-1', 3));

    const retrieved = await repo.getInventory('us-east-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.resources).toHaveLength(3);
    expect(retrieved!.accountId).toBe('123456789012');
  });

  it('should list stored regions and replace on re-save', async () => {
    const repo = new FileInfrastructureRepository(tmpDir);
    await repo.saveInventory(makeInventory('us-east-1', 3));
    await repo.saveInventory(makeInventory('eu-west-1'));
    expect((await repo.listRegions()).sort()).toEqual(['eu-west-1', 'us-east-1']);

    await repo.saveInventory(makeInventory('us-east-1', 5));
    expect((await repo.getInventory('us-east-1'))!.resources).toHaveLength(5);
  });

  it('should find a resource and its relationships', async () => {
    const repo = new FileInfrastructureRepository(tmpDir);
    await repo.saveInventory(makeInventory('us-east-1', 3));

    const found = await repo.findResource('us-east-1-vpc-0');
    expect(found!.type).toBe('AWS::EC2::VPC');

    const rels = await repo.findRelationships('us-east-1-vpc-1');
    expect(rels[0]!.relationship).toBe('DEPENDS_ON');
  });

  it('should clear a region', async () => {
    const repo = new FileInfrastructureRepository(tmpDir);
    await repo.saveInventory(makeInventory('us-east-1'));
    await repo.clearRegion('us-east-1');
    expect(await repo.getInventory('us-east-1')).toBeUndefined();
    expect(await repo.listRegions()).toHaveLength(0);
  });

  it('should share data across two instances on the same dir (no lock)', async () => {
    // Writer (discovery agent) persists.
    const writer = new FileInfrastructureRepository(tmpDir);
    await writer.saveInventory(makeInventory('us-east-1', 4));

    // Reader (graph agent) opens the SAME dir concurrently — this is exactly
    // the scenario the Kuzu lock made impossible.
    const reader = new FileInfrastructureRepository(tmpDir);
    const inv = await reader.getInventory('us-east-1');
    expect(inv!.resources).toHaveLength(4);
  });

  it('should preserve single quotes and nested JSON', async () => {
    const repo = new FileInfrastructureRepository(tmpDir);
    const inv = makeInventory('us-east-1', 1);
    inv.resources[0]!.name = "my-service's-vpc";
    inv.resources[0]!.properties = { cidrBlock: '10.0.0.0/16', nested: { key: 'value' } };
    await repo.saveInventory(inv);

    const found = await repo.findResource('us-east-1-vpc-0');
    expect(found!.name).toBe("my-service's-vpc");
    expect((found!.properties['nested'] as Record<string, unknown>)['key']).toBe('value');
  });
});
