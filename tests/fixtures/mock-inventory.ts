import type { RegionInventory } from '../../domain/resources/inventory.js';
import type { AwsResource } from '../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../domain/relationships/relationship.js';
import { computeStats } from '../../domain/resources/inventory.js';

/**
 * Fictional infrastructure fixture — NO AWS access required.
 *
 * Topology (mirrors the Phase 2 spec example):
 *
 *   VPC (vpc-1)
 *   ├── CONTAINS public-subnet
 *   │     └── ALB (alb-1) RUNS_IN public-subnet, USES sg-web, TARGETS tg-1
 *   │           └── tg-1 TARGETS ecs-api
 *   └── CONTAINS private-subnet
 *         ├── ECS Service (ecs-api) RUNS_IN private-subnet, USES sg-app,
 *         │       TARGETS tg-1, BELONGS_TO cluster-1, USES role-app
 *         └── RDS (rds-prod) RUNS_IN private-subnet, USES sg-db
 *
 *   Plus an intentionally ORPHAN bucket to exercise orphan detection.
 */

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';

function res(partial: Partial<AwsResource> & Pick<AwsResource, 'id' | 'type'>): AwsResource {
  return {
    arn: partial.arn ?? `arn:aws:test:${REGION}:${ACCOUNT}:${partial.id}`,
    name: partial.name ?? partial.id,
    region: partial.region ?? REGION,
    accountId: partial.accountId ?? ACCOUNT,
    properties: partial.properties ?? {},
    dependencies: partial.dependencies ?? [],
    ...partial,
  };
}

export const MOCK_RESOURCES: AwsResource[] = [
  res({ id: 'vpc-1', type: 'AWS::EC2::VPC', name: 'main-vpc', properties: { cidrBlock: '10.0.0.0/16' } }),
  res({ id: 'public-subnet', type: 'AWS::EC2::Subnet', properties: { vpcId: 'vpc-1' }, dependencies: ['vpc-1'] }),
  res({ id: 'private-subnet', type: 'AWS::EC2::Subnet', properties: { vpcId: 'vpc-1' }, dependencies: ['vpc-1'] }),
  res({ id: 'sg-web', type: 'AWS::EC2::SecurityGroup', properties: { vpcId: 'vpc-1' }, dependencies: ['vpc-1'] }),
  res({ id: 'sg-app', type: 'AWS::EC2::SecurityGroup', properties: { vpcId: 'vpc-1' }, dependencies: ['vpc-1'] }),
  res({ id: 'sg-db', type: 'AWS::EC2::SecurityGroup', properties: { vpcId: 'vpc-1' }, dependencies: ['vpc-1'] }),
  res({
    id: 'alb-1',
    type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    name: 'web-alb',
    properties: { vpcId: 'vpc-1', scheme: 'internet-facing' },
    dependencies: ['public-subnet', 'sg-web'],
  }),
  res({
    id: 'tg-1',
    type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
    name: 'api-tg',
    properties: { vpcId: 'vpc-1', port: 8080 },
    dependencies: ['alb-1'],
  }),
  res({ id: 'cluster-1', type: 'AWS::ECS::Cluster', name: 'app-cluster' }),
  res({
    id: 'ecs-api',
    type: 'AWS::ECS::Service',
    name: 'api',
    properties: { clusterArn: 'cluster-1', desiredCount: 2 },
    dependencies: ['tg-1', 'private-subnet', 'sg-app', 'cluster-1', 'role-app'],
  }),
  res({
    id: 'rds-prod',
    type: 'AWS::RDS::DBInstance',
    name: 'prod-db',
    properties: { engine: 'postgres' },
    dependencies: ['private-subnet', 'sg-db'],
  }),
  res({
    id: 'role-app',
    type: 'AWS::IAM::Role',
    name: 'app-task-role',
    region: 'global',
    arn: `arn:aws:iam::${ACCOUNT}:role/app-task-role`,
  }),
  // Orphan — no relationships reference it.
  res({ id: 'orphan-bucket', type: 'AWS::S3::Bucket', name: 'lonely-bucket', arn: 'arn:aws:s3:::lonely-bucket' }),
];

export const MOCK_RELATIONSHIPS: ResourceRelationship[] = [
  { source: 'public-subnet', target: 'vpc-1', relationship: 'BELONGS_TO' },
  { source: 'private-subnet', target: 'vpc-1', relationship: 'BELONGS_TO' },
  { source: 'alb-1', target: 'public-subnet', relationship: 'RUNS_IN' },
  { source: 'alb-1', target: 'sg-web', relationship: 'USES' },
  { source: 'alb-1', target: 'tg-1', relationship: 'TARGETS' },
  { source: 'ecs-api', target: 'tg-1', relationship: 'TARGETS' },
  { source: 'ecs-api', target: 'private-subnet', relationship: 'RUNS_IN' },
  { source: 'ecs-api', target: 'sg-app', relationship: 'USES' },
  { source: 'ecs-api', target: 'cluster-1', relationship: 'BELONGS_TO' },
  { source: 'ecs-api', target: 'role-app', relationship: 'USES' },
  { source: 'rds-prod', target: 'private-subnet', relationship: 'RUNS_IN' },
  { source: 'rds-prod', target: 'sg-db', relationship: 'USES' },
];

export function makeMockInventory(): RegionInventory {
  const stats = computeStats(MOCK_RESOURCES, MOCK_RELATIONSHIPS, [], 42);
  return {
    region: REGION,
    accountId: ACCOUNT,
    scannedAt: '2026-08-25T14:00:00.000Z',
    resources: MOCK_RESOURCES,
    relationships: MOCK_RELATIONSHIPS,
    errors: [],
    stats,
  };
}

/** An empty but well-formed inventory. */
export function makeEmptyInventory(): RegionInventory {
  return {
    region: REGION,
    accountId: ACCOUNT,
    scannedAt: '2026-08-25T14:00:00.000Z',
    resources: [],
    relationships: [],
    errors: [],
    stats: computeStats([], [], [], 0),
  };
}

/** Inventory with a dangling edge and a duplicate node — for consistency tests. */
export function makeInconsistentInventory(): RegionInventory {
  const resources: AwsResource[] = [
    res({ id: 'vpc-1', type: 'AWS::EC2::VPC' }),
    res({ id: 'subnet-1', type: 'AWS::EC2::Subnet', dependencies: ['vpc-1'] }),
    res({ id: 'subnet-1', type: 'AWS::EC2::Subnet', dependencies: ['vpc-1'] }), // duplicate
    res({ id: 'bad-arn', type: 'AWS::S3::Bucket', arn: 'not-an-arn' }),
  ];
  const relationships: ResourceRelationship[] = [
    { source: 'subnet-1', target: 'vpc-1', relationship: 'BELONGS_TO' },
    { source: 'subnet-1', target: 'vpc-999', relationship: 'BELONGS_TO' }, // dangling target
    { source: 'subnet-1', target: 'vpc-1', relationship: 'BELONGS_TO' }, // duplicate edge
  ];
  return {
    region: REGION,
    accountId: ACCOUNT,
    scannedAt: '2026-08-25T14:00:00.000Z',
    resources,
    relationships,
    errors: [],
    stats: computeStats(resources, relationships, [], 0),
  };
}
