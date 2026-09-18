/**
 * Unit tests for FileTotalInventoryRepository — the JSON-backed radar report
 * store. Proves persistence and cross-instance sharing (what aws-discovery-mcp
 * writes, migration-analysis-mcp must be able to read back).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTotalInventoryRepository } from '../../repositories/file-total-inventory.repository.js';
import { InMemoryTotalInventoryRepository } from '../../repositories/total-inventory.repository.js';
import type { TotalInventoryReport } from '../../domain/resources/total-inventory.js';

function makeReport(region: string): TotalInventoryReport {
  return {
    region,
    accountId: '123456789012',
    scannedAt: new Date().toISOString(),
    discoverySource: 'RESOURCE_EXPLORER',
    alreadyFidelityCount: 1,
    items: [
      {
        arn: `arn:aws:ec2:${region}:123456789012:vpc/vpc-0`,
        resourceType: 'AWS::EC2::VPC',
        region,
        tags: {},
        source: 'COLLECTOR',
        fidelity: 'ALREADY_FIDELITY',
        fidelityReason: 'Captured by a Stage-1 collector.',
        relevance: 'CORE',
        relevanceReason: 'No AWS-managed-scaffolding pattern matched.',
      },
    ],
    summary: { total: 1, core: 1, supporting: 0, noise: 0, fidelityViaConfig: 0, radarOnly: 0 },
    errors: [],
  };
}

describe('FileTotalInventoryRepository', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'total-inventory-repo-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists a report and reads it back from a different instance', async () => {
    const writer = new FileTotalInventoryRepository(dir);
    await writer.saveReport(makeReport('us-east-1'));

    const reader = new FileTotalInventoryRepository(dir);
    const report = await reader.getReport('us-east-1');

    expect(report?.region).toBe('us-east-1');
    expect(report?.items).toHaveLength(1);
  });

  it('keeps reports for different regions independent', async () => {
    const repo = new FileTotalInventoryRepository(dir);
    await repo.saveReport(makeReport('us-east-1'));
    await repo.saveReport(makeReport('sa-east-1'));

    expect((await repo.getReport('us-east-1'))?.region).toBe('us-east-1');
    expect((await repo.getReport('sa-east-1'))?.region).toBe('sa-east-1');
  });

  it('returns undefined for a region never scanned', async () => {
    const repo = new FileTotalInventoryRepository(dir);
    expect(await repo.getReport('eu-west-1')).toBeUndefined();
  });
});

describe('InMemoryTotalInventoryRepository', () => {
  it('saves and retrieves a report within the same process', async () => {
    const repo = new InMemoryTotalInventoryRepository();
    await repo.saveReport(makeReport('us-east-1'));
    expect((await repo.getReport('us-east-1'))?.accountId).toBe('123456789012');
  });
});
