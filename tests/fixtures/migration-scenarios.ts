import type { RegionInventory } from '../../domain/resources/inventory.js';
import type { AwsResource, ResourceType } from '../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../domain/relationships/relationship.js';
import { computeStats } from '../../domain/resources/inventory.js';
import { buildGraph } from '../../domain/graph/builder.js';
import type { InfrastructureGraph } from '../../domain/graph/graph.js';

/**
 * Migration analysis test fixtures — NO AWS access.
 * Each scenario returns a ready-to-analyze InfrastructureGraph.
 */

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';

function res(
  id: string,
  type: ResourceType,
  extra: Partial<AwsResource> = {}
): AwsResource {
  return {
    id,
    arn: extra.arn ?? `arn:aws:test:${REGION}:${ACCOUNT}:${id}`,
    type,
    name: extra.name ?? id,
    region: extra.region ?? REGION,
    accountId: ACCOUNT,
    properties: extra.properties ?? {},
    dependencies: extra.dependencies ?? [],
  };
}

function toGraph(resources: AwsResource[], relationships: ResourceRelationship[]): InfrastructureGraph {
  const inventory: RegionInventory = {
    region: REGION,
    accountId: ACCOUNT,
    scannedAt: '2026-08-25T14:00:00.000Z',
    resources,
    relationships,
    errors: [],
    stats: computeStats(resources, relationships, [], 0),
  };
  return buildGraph(inventory);
}

/** Scenario 1: VPC → ECS. Both RECREATE. */
export function scenarioVpcEcs(): InfrastructureGraph {
  return toGraph(
    [
      res('vpc-1', 'AWS::EC2::VPC'),
      res('cluster-1', 'AWS::ECS::Cluster'),
      res('ecs-1', 'AWS::ECS::Service', {
        properties: { vpcId: 'vpc-1' },
        dependencies: ['cluster-1'],
      }),
    ],
    [{ source: 'ecs-1', target: 'cluster-1', relationship: 'BELONGS_TO' }]
  );
}

/** Scenario 2: ECS → RDS (RDS drives a stateful strategy the ECS must respect). */
export function scenarioEcsRds(): InfrastructureGraph {
  return toGraph(
    [
      res('rds-1', 'AWS::RDS::DBInstance', { name: 'prod-db', properties: { engine: 'postgres' } }),
      res('ecs-1', 'AWS::ECS::Service', { name: 'api', dependencies: ['rds-1'] }),
    ],
    // The app→DB link is modeled explicitly as CONNECTS_TO for this scenario.
    [{ source: 'ecs-1', target: 'rds-1', relationship: 'CONNECTS_TO' }]
  );
}

/** Scenario 3: ECS → Secrets Manager → KMS (full dependency chain). */
export function scenarioEcsSecretsKms(): InfrastructureGraph {
  return toGraph(
    [
      res('kms-1', 'AWS::KMS::Key' as ResourceType, { name: 'app-key' }),
      res('secret-1', 'AWS::SecretsManager::Secret', {
        name: 'db-credentials',
        arn: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:db-credentials`,
        dependencies: ['kms-1'],
      }),
      res('ecs-1', 'AWS::ECS::Service', { name: 'api', dependencies: ['secret-1'] }),
    ],
    [
      { source: 'secret-1', target: 'kms-1', relationship: 'USES' },
      { source: 'ecs-1', target: 'secret-1', relationship: 'USES' },
    ]
  );
}

/** Scenario 4: an unsupported resource type (no rule). Expect NOT_SUPPORTED/UNKNOWN. */
export function scenarioUnsupported(): InfrastructureGraph {
  return toGraph([res('mystery-1', 'AWS::Unknown::Thing' as ResourceType, { name: 'mystery' })], []);
}

/**
 * Scenario 5: insufficient information. A resource with no rule and no
 * dependencies — the analyzer must return UNKNOWN, not a guess.
 */
export function scenarioInsufficientInfo(): InfrastructureGraph {
  return toGraph(
    [res('unclear-1', 'AWS::AppMesh::Mesh' as ResourceType, { name: 'unclear' })],
    []
  );
}

/** A broad, mixed scenario for summary/phases/blocker aggregation tests. */
export function scenarioMixed(): InfrastructureGraph {
  return toGraph(
    [
      res('vpc-1', 'AWS::EC2::VPC'),
      res('subnet-1', 'AWS::EC2::Subnet', { properties: { vpcId: 'vpc-1' }, dependencies: ['vpc-1'] }),
      res('sg-1', 'AWS::EC2::SecurityGroup', { properties: { vpcId: 'vpc-1' }, dependencies: ['vpc-1'] }),
      res('role-1', 'AWS::IAM::Role', { region: 'global', arn: `arn:aws:iam::${ACCOUNT}:role/app` }),
      res('rds-1', 'AWS::RDS::DBInstance', { name: 'prod-db', dependencies: ['subnet-1', 'sg-1'] }),
      res('secret-1', 'AWS::SecretsManager::Secret', {
        name: 'creds',
        arn: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:creds`,
      }),
      res('tg-1', 'AWS::ElasticLoadBalancingV2::TargetGroup', {
        arn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:targetgroup/tg-1`,
        properties: { vpcId: 'vpc-1' },
      }),
      res('alb-1', 'AWS::ElasticLoadBalancingV2::LoadBalancer', {
        arn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/alb-1`,
        properties: { vpcId: 'vpc-1' },
        dependencies: ['subnet-1', 'sg-1', 'tg-1'],
      }),
      res('ecs-1', 'AWS::ECS::Service', {
        name: 'api',
        dependencies: ['subnet-1', 'sg-1', 'tg-1', 'role-1', 'secret-1'],
      }),
    ],
    [
      { source: 'subnet-1', target: 'vpc-1', relationship: 'BELONGS_TO' },
      { source: 'rds-1', target: 'subnet-1', relationship: 'RUNS_IN' },
      { source: 'rds-1', target: 'sg-1', relationship: 'USES' },
      { source: 'alb-1', target: 'subnet-1', relationship: 'RUNS_IN' },
      { source: 'alb-1', target: 'sg-1', relationship: 'USES' },
      { source: 'alb-1', target: 'tg-1', relationship: 'TARGETS' },
      { source: 'ecs-1', target: 'subnet-1', relationship: 'RUNS_IN' },
      { source: 'ecs-1', target: 'sg-1', relationship: 'USES' },
      { source: 'ecs-1', target: 'tg-1', relationship: 'TARGETS' },
      { source: 'ecs-1', target: 'role-1', relationship: 'USES' },
      { source: 'ecs-1', target: 'secret-1', relationship: 'USES' },
    ]
  );
}

/** An empty graph. */
export function scenarioEmpty(): InfrastructureGraph {
  return toGraph([], []);
}
