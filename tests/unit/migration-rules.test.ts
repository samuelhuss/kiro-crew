import { evaluateRule, getMigrationRule, hasMigrationRule } from '../../domain/migration/rules.js';
import type { GraphNode } from '../../domain/graph/node.js';
import type { ResourceType } from '../../domain/resources/resource.js';

function node(id: string, type: ResourceType, properties: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    arn: `arn:aws:test:us-east-1:123456789012:${id}`,
    type,
    name: id,
    region: 'us-east-1',
    accountId: '123456789012',
    properties,
  };
}

const ctx = (n: GraphNode) => ({ node: n, sourceRegion: 'us-east-1', targetRegion: 'sa-east-1', dependencies: [] });

describe('Migration Rules', () => {
  it('VPC → RECREATE / SUPPORTED / LOW', () => {
    const r = evaluateRule(ctx(node('vpc-1', 'AWS::EC2::VPC')));
    expect(r.strategy).toBe('RECREATE');
    expect(r.status).toBe('SUPPORTED');
    expect(r.baseRisk).toBe('LOW');
  });

  it('RDS → SNAPSHOT_RESTORE / SUPPORTED / HIGH with persistent-data reasons', () => {
    const r = evaluateRule(ctx(node('rds-1', 'AWS::RDS::DBInstance')));
    expect(r.strategy).toBe('SNAPSHOT_RESTORE');
    expect(r.status).toBe('SUPPORTED');
    expect(r.baseRisk).toBe('HIGH');
    expect(r.riskReasons.join(' ')).toMatch(/persistent data/i);
  });

  it('Secrets Manager → REPLICATE / REQUIRES_MANUAL_ACTION with SECRET_VALUE blocker', () => {
    const r = evaluateRule(ctx(node('secret-1', 'AWS::SecretsManager::Secret')));
    expect(r.strategy).toBe('REPLICATE');
    expect(r.status).toBe('REQUIRES_MANUAL_ACTION');
    expect(r.blockers.some((b) => b.blocker === 'SECRET_VALUE_NOT_REPLICATED')).toBe(true);
  });

  it('ECS Service → RECREATE / SUPPORTED_WITH_CHANGES with ECR blocker', () => {
    const r = evaluateRule(ctx(node('ecs-1', 'AWS::ECS::Service')));
    expect(r.strategy).toBe('RECREATE');
    expect(r.status).toBe('SUPPORTED_WITH_CHANGES');
    expect(r.blockers.some((b) => b.blocker === 'ECR_IMAGE_NOT_AVAILABLE')).toBe(true);
  });

  it('S3 → REPLICATE with global-name blocker', () => {
    const r = evaluateRule(ctx(node('bucket-1', 'AWS::S3::Bucket')));
    expect(r.strategy).toBe('REPLICATE');
    expect(r.blockers.some((b) => b.blocker === 'S3_BUCKET_NAME_GLOBAL_CONFLICT')).toBe(true);
  });

  it('IAM Role → NO_ACTION (global service)', () => {
    const r = evaluateRule(ctx(node('role-1', 'AWS::IAM::Role')));
    expect(r.strategy).toBe('NO_ACTION');
    expect(r.status).toBe('SUPPORTED');
  });

  it('KMS (forward-looking) → CRITICAL with KMS_KEY_UNAVAILABLE blocker', () => {
    const r = evaluateRule(ctx(node('kms-1', 'AWS::KMS::Key' as ResourceType)));
    expect(r.baseRisk).toBe('CRITICAL');
    expect(r.blockers.some((b) => b.blocker === 'KMS_KEY_UNAVAILABLE')).toBe(true);
  });

  it('unknown type → NOT_SUPPORTED strategy / UNKNOWN status (never guesses)', () => {
    const r = evaluateRule(ctx(node('x-1', 'AWS::Foo::Bar' as ResourceType)));
    expect(r.strategy).toBe('NOT_SUPPORTED');
    expect(r.status).toBe('UNKNOWN');
    expect(r.blockers.some((b) => b.blocker === 'UNSUPPORTED_RESOURCE')).toBe(true);
  });

  it('rule lookup helpers', () => {
    expect(hasMigrationRule('AWS::EC2::VPC')).toBe(true);
    expect(hasMigrationRule('AWS::Foo::Bar')).toBe(false);
    expect(typeof getMigrationRule('AWS::RDS::DBInstance')).toBe('function');
  });
});
