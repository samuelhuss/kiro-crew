/**
 * Tests for Phase 1+2 migration rules — the 10 new resource types.
 * Each rule is deterministic (no LLM) — these tests assert the exact strategy,
 * status, risk, and blockers for each type.
 */

import { evaluateRule } from '../../domain/migration/rules.js';
import type { RuleContext } from '../../domain/migration/rules.js';
import type { GraphNode } from '../../domain/graph/node.js';

function makeCtx(type: string, overrides?: Partial<GraphNode>): RuleContext {
  return {
    node: {
      id: `test-${type}`,
      arn: `arn:test:${type}`,
      type: type as GraphNode['type'],
      name: 'test-resource',
      region: 'us-east-1',
      accountId: '123456789012',
      properties: {},
      ...overrides,
    },
    sourceRegion: 'us-east-1',
    targetRegion: 'sa-east-1',
    dependencies: [],
  };
}

describe('Migration Rules — new resource types', () => {
  it('EC2::Volume → SNAPSHOT_RESTORE / MEDIUM', () => {
    const r = evaluateRule(makeCtx('AWS::EC2::Volume'));
    expect(r.strategy).toBe('SNAPSHOT_RESTORE');
    expect(r.status).toBe('SUPPORTED_WITH_CHANGES');
    expect(r.baseRisk).toBe('MEDIUM');
    expect(r.blockers.length).toBeGreaterThan(0);
  });

  it('EC2::EIP → MANUAL / MEDIUM (regional, IP changes)', () => {
    const r = evaluateRule(makeCtx('AWS::EC2::EIP'));
    expect(r.strategy).toBe('MANUAL');
    expect(r.status).toBe('REQUIRES_MANUAL_ACTION');
    expect(r.baseRisk).toBe('MEDIUM');
    expect(r.manualActions.length).toBeGreaterThan(0);
    expect(r.manualActions[0]).toContain('sa-east-1');
  });

  it('Logs::LogGroup → RECREATE / LOW', () => {
    const r = evaluateRule(makeCtx('AWS::Logs::LogGroup'));
    expect(r.strategy).toBe('RECREATE');
    expect(r.baseRisk).toBe('LOW');
    expect(r.warnings.length).toBeGreaterThan(0); // warns about log history
  });

  it('Route53::HostedZone → NO_ACTION / MEDIUM (global, DNS repoint)', () => {
    const r = evaluateRule(makeCtx('AWS::Route53::HostedZone'));
    expect(r.strategy).toBe('NO_ACTION');
    expect(r.status).toBe('REQUIRES_MANUAL_ACTION');
    expect(r.blockers[0]!.blocker).toBe('MANUAL_DNS_CHANGE_REQUIRED');
  });

  it('DynamoDB::Table → REPLICATE / HIGH', () => {
    const r = evaluateRule(makeCtx('AWS::DynamoDB::Table'));
    expect(r.strategy).toBe('REPLICATE');
    expect(r.baseRisk).toBe('HIGH');
    expect(r.blockers.some(b => b.blocker === 'CROSS_REGION_DATA_TRANSFER_REQUIRED')).toBe(true);
  });

  it('ECR::Repository → REPLICATE / MEDIUM', () => {
    const r = evaluateRule(makeCtx('AWS::ECR::Repository'));
    expect(r.strategy).toBe('REPLICATE');
    expect(r.baseRisk).toBe('MEDIUM');
    expect(r.manualActions[0]).toContain('sa-east-1');
  });

  it('SQS::Queue → RECREATE / MEDIUM (in-flight messages lost)', () => {
    const r = evaluateRule(makeCtx('AWS::SQS::Queue'));
    expect(r.strategy).toBe('RECREATE');
    expect(r.baseRisk).toBe('MEDIUM');
    expect(r.warnings.some(w => w.toLowerCase().includes('messages'))).toBe(true);
  });

  it('SNS::Topic → RECREATE / LOW', () => {
    const r = evaluateRule(makeCtx('AWS::SNS::Topic'));
    expect(r.strategy).toBe('RECREATE');
    expect(r.baseRisk).toBe('LOW');
  });

  it('ElastiCache::CacheCluster → SNAPSHOT_RESTORE / MEDIUM', () => {
    const r = evaluateRule(makeCtx('AWS::ElastiCache::CacheCluster'));
    expect(r.strategy).toBe('SNAPSHOT_RESTORE');
    expect(r.baseRisk).toBe('MEDIUM');
    expect(r.warnings.some(w => w.includes('Memcached'))).toBe(true);
  });

  it('CloudFront::Distribution → NO_ACTION / LOW (global, repoint origins)', () => {
    const r = evaluateRule(makeCtx('AWS::CloudFront::Distribution'));
    expect(r.strategy).toBe('NO_ACTION');
    expect(r.baseRisk).toBe('LOW');
    expect(r.manualActions.some(a => a.includes('origins'))).toBe(true);
  });
});
