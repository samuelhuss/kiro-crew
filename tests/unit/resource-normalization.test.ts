import { groupByService, computeStats } from '../../domain/resources/inventory.js';
import type { AwsResource } from '../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../domain/relationships/relationship.js';
import { buildRelationshipMap } from '../../domain/relationships/relationship.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeResource(partial: Partial<AwsResource> & Pick<AwsResource, 'id' | 'type'>): AwsResource {
  return {
    arn: `arn:aws:ec2:us-east-1:123456789012:${partial.id}`,
    name: partial.id,
    region: 'us-east-1',
    accountId: '123456789012',
    properties: {},
    dependencies: [],
    ...partial,
  };
}

// ── Resource normalization ────────────────────────────────────────────────────

describe('Resource model normalization', () => {
  it('should have all required fields', () => {
    const r = makeResource({ id: 'vpc-123', type: 'AWS::EC2::VPC' });
    expect(r.id).toBe('vpc-123');
    expect(r.arn).toContain('vpc-123');
    expect(r.type).toBe('AWS::EC2::VPC');
    expect(r.region).toBe('us-east-1');
    expect(r.accountId).toBe('123456789012');
    expect(Array.isArray(r.dependencies)).toBe(true);
    expect(typeof r.properties).toBe('object');
  });

  it('dependencies should be an empty array by default', () => {
    const r = makeResource({ id: 'igw-abc', type: 'AWS::EC2::InternetGateway' });
    expect(r.dependencies).toHaveLength(0);
  });

  it('should allow non-empty dependencies', () => {
    const r = makeResource({
      id: 'subnet-123',
      type: 'AWS::EC2::Subnet',
      dependencies: ['vpc-456'],
    });
    expect(r.dependencies).toContain('vpc-456');
  });
});

// ── groupByService ────────────────────────────────────────────────────────────

describe('groupByService', () => {
  it('should group by the middle segment of the type', () => {
    const resources = [
      makeResource({ id: 'vpc-1', type: 'AWS::EC2::VPC' }),
      makeResource({ id: 'subnet-1', type: 'AWS::EC2::Subnet' }),
      makeResource({ id: 'ecs-1', type: 'AWS::ECS::Cluster' }),
    ];
    const groups = groupByService(resources);
    expect(Object.keys(groups)).toContain('EC2');
    expect(Object.keys(groups)).toContain('ECS');
    expect(groups['EC2']).toHaveLength(2);
    expect(groups['ECS']).toHaveLength(1);
  });

  it('should return empty object for empty input', () => {
    expect(groupByService([])).toEqual({});
  });
});

// ── computeStats ──────────────────────────────────────────────────────────────

describe('computeStats', () => {
  it('should count resources and relationships', () => {
    const resources = [
      makeResource({ id: 'r1', type: 'AWS::EC2::VPC' }),
      makeResource({ id: 'r2', type: 'AWS::EC2::Subnet' }),
      makeResource({ id: 'r3', type: 'AWS::EC2::Subnet' }),
    ];
    const relationships: ResourceRelationship[] = [
      { source: 'r2', target: 'r1', relationship: 'BELONGS_TO' },
      { source: 'r3', target: 'r1', relationship: 'BELONGS_TO' },
    ];
    const stats = computeStats(resources, relationships, [], 500);
    expect(stats.totalResources).toBe(3);
    expect(stats.totalRelationships).toBe(2);
    expect(stats.totalErrors).toBe(0);
    expect(stats.durationMs).toBe(500);
    expect(stats.byType['AWS::EC2::VPC']).toBe(1);
    expect(stats.byType['AWS::EC2::Subnet']).toBe(2);
  });
});

// ── Relationship model ────────────────────────────────────────────────────────

describe('buildRelationshipMap', () => {
  it('should group relationships by source', () => {
    const rels: ResourceRelationship[] = [
      { source: 'svc-1', target: 'subnet-1', relationship: 'RUNS_IN' },
      { source: 'svc-1', target: 'sg-1', relationship: 'USES' },
      { source: 'svc-2', target: 'subnet-1', relationship: 'RUNS_IN' },
    ];
    const map = buildRelationshipMap(rels);
    expect(map.get('svc-1')).toHaveLength(2);
    expect(map.get('svc-2')).toHaveLength(1);
    expect(map.get('svc-3')).toBeUndefined();
  });

  it('should handle empty input', () => {
    const map = buildRelationshipMap([]);
    expect(map.size).toBe(0);
  });
});
