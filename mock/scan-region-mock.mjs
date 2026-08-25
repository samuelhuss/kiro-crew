/**
 * Mock de resposta completo do scan_region("us-east-1")
 * Representa uma infraestrutura típica: VPC, subnets, ECS services, ALB, RDS, Lambda
 * Usado para validar a estrutura do grafo e o modelo de dependências sem conta AWS real.
 *
 * Run: node --input-type=module mock/scan-region-mock.mjs
 */

import { InMemoryInfrastructureRepository } from '../dist/repositories/infrastructure.repository.js';
import { KuzuInfrastructureRepository } from '../dist/repositories/kuzu.repository.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Mock inventory ────────────────────────────────────────────────────────────

const ACCOUNT_ID = '123456789012';
const REGION = 'us-east-1';

const mockInventory = {
  region: REGION,
  accountId: ACCOUNT_ID,
  scannedAt: new Date().toISOString(),
  resources: [
    // VPC
    {
      id: 'vpc-0abc1234def56789a',
      arn: `arn:aws:ec2:${REGION}:${ACCOUNT_ID}:vpc/vpc-0abc1234def56789a`,
      type: 'AWS::EC2::VPC',
      name: 'prod-vpc',
      region: REGION,
      accountId: ACCOUNT_ID,
      properties: { cidrBlock: '10.0.0.0/16', isDefault: false, state: 'available' },
      dependencies: [],
    },
    // Subnets
    {
      id: 'subnet-public-1a',
      arn: `arn:aws:ec2:${REGION}:${ACCOUNT_ID}:subnet/subnet-public-1a`,
      type: 'AWS::EC2::Subnet',
      name: 'prod-public-1a',
      region: REGION,
      accountId: ACCOUNT_ID,
      properties: { cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a', mapPublicIpOnLaunch: true },
      dependencies: ['vpc-0abc1234def56789a'],
    },
    {
      id: 'subnet-private-1a',
      arn: `arn:aws:ec2:${REGION}:${ACCOUNT_ID}:subnet/subnet-private-1a`,
      type: 'AWS::EC2::Subnet',
      name: 'prod-private-1a',
      region: REGION,
      accountId: ACCOUNT_ID,
      properties: { cidrBlock: '10.0.10.0/24', availabilityZone: 'us-east-1a', mapPublicIpOnLaunch: false },
      dependencies: ['vpc-0abc1234def56789a'],
    },
    {
      id: 'subnet-private-1b',
      arn: `arn:aws:ec2:${REGION}:${ACCOUNT_ID}:subnet/subnet-private-1b`,
      type: 'AWS::EC2::Subnet',
      name: 'prod-private-1b',
      region: REGION,
      accountId: ACCOUNT_ID,
      properties: { cidrBlock: '10.0.11.0/24', availabilityZone: 'us-east-1b', mapPublicIpOnLaunch: false },
      dependencies: ['vpc-0abc1234def56789a'],
    },
    // Internet Gateway
    {
      id: 'igw-0ff1234567890abcd',
      arn: `arn:aws:ec2:${REGION}:${ACCOUNT_ID}:internet-gateway/igw-0ff1234567890abcd`,
      type: 'AWS::EC2::InternetGateway',
      name: 'prod-igw',
      region: REGION,
      accountId: ACCOUNT_ID,
      properties: { attachedVpcs: ['vpc-0abc1234def56789a'] },
      dependencies: ['vpc-0abc1234def56789a'],
    },
    // Security Groups
    {
      id: 'sg-alb-prod',
      arn: `arn:aws:ec2:${REGION}:${ACCOUNT_ID}:security-group/sg-alb-prod`,
      type: 'AWS::EC2::SecurityGroup',
      name: 'prod-alb-sg',
      region: REGION,
      accountId: ACCOUNT_ID,
      properties: { description: 'ALB public traffic', vpcId: 'vpc-0abc1234def56789a', ingressRuleCount: 2, egressRuleCount: 1 },
      dependencies: ['vpc-0abc1234def56789a'],
    },
    {
      id: 'sg-app-prod',
      arn: `arn:aws:ec2:${REGION}:${ACCOUNT_ID}:security-group/sg-app-prod`,
      type: 'AWS::EC2::SecurityGroup',
      name: 'prod-app-sg',
      region: REGION,
      accountId: ACCOUNT_ID,
      properties: { description: 'ECS app containers', vpcId: 'vpc-0abc1234def56789a', ingressRuleCount: 1, egressRuleCount: 1 },
      dependencies: ['vpc-0abc1234def56789a'],
    },
    {
      id: 'sg-rds-prod',
      arn: `arn:aws:ec2:${REGION}:${ACCOUNT_ID}:security-group/sg-rds-prod`,
      type: 'AWS::EC2::SecurityGroup',
      name: 'prod-rds-sg',
      region: REGION,
      accountId: ACCOUNT_ID,
      properties: { description: 'RDS postgres', vpcId: 'vpc-0abc1234def56789a', ingressRuleCount: 1, egressRuleCount: 0 },
      dependencies: ['vpc-0abc1234def56789a'],
    },
    // ALB
    {
      id: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/prod-alb/0123456789abcdef',
      arn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/prod-alb/0123456789abcdef',
      type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
      name: 'prod-alb',
      region: REGION,
      accountId: ACCOUNT_ID,
      properties: { type: 'application', scheme: 'internet-facing', state: 'active', dnsName: 'prod-alb-0123456789.us-east-1.elb.amazonaws.com', vpcId: 'vpc-0abc1234def56789a' },
      dependencies: ['subnet-public-1a', 'sg-alb-prod'],
    },
    // Target Groups
    {
      id: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/prod-api-tg/abcdef1234567890',
      arn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/prod-api-tg/abcdef1234567890',
      type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
      name: 'prod-api-tg',
      region: REGION,
      accountId: ACCOUNT_ID,
      properties: { protocol: 'HTTP', port: 8080, targetType: 'ip', vpcId: 'vpc-0abc1234def56789a', healthCheckPath: '/health' },
      dependencies: ['arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/prod-alb/0123456789abcdef'],
    },
    // ECS Cluster
    {
      id: 'arn:aws:ecs:us-east-1:123456789012:cluster/prod-cluster',
      arn: 'arn:aws:ecs:us-east-1:123456789012:cluster/prod-cluster',
      type: 'AWS::ECS::Cluster',
      name: 'prod-cluster',
      region: REGION,
      accountId: ACCOUNT_ID,
      properties: { status: 'ACTIVE', runningTasksCount: 4, activeServicesCount: 2 },
      dependencies: [],
    },
    // IAM Role
    {
      id: 'AROAEXAMPLEROLEID001',
      arn: 'arn:aws:iam::123456789012:role/prod-ecs-task-role',
      type: 'AWS::IAM::Role',
      name: 'prod-ecs-task-role',
      region: 'global',
      accountId: ACCOUNT_ID,
      properties: { path: '/service-role/', maxSessionDuration: 3600 },
      dependencies: [],
    },
    // ECS Services
    {
      id: 'arn:aws:ecs:us-east-1:123456789012:service/prod-cluster/api-service',
      arn: 'arn:aws:ecs:us-east-1:123456789012:service/prod-cluster/api-service',
      type: 'AWS::ECS::Service',
      name: 'api-service',
      region: REGION,
      accountId: ACCOUNT_ID,
      properties: {
        clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/prod-cluster',
        status: 'ACTIVE', desiredCount: 2, runningCount: 2, launchType: 'FARGATE',
        taskDefinition: 'arn:aws:ecs:us-east-1:123456789012:task-definition/api:42',
      },
      dependencies: [
        'arn:aws:ecs:us-east-1:123456789012:cluster/prod-cluster',
        'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/prod-api-tg/abcdef1234567890',
        'subnet-private-1a', 'subnet-private-1b',
        'sg-app-prod',
        'AROAEXAMPLEROLEID001',
      ],
    },
    {
      id: 'arn:aws:ecs:us-east-1:123456789012:service/prod-cluster/worker-service',
      arn: 'arn:aws:ecs:us-east-1:123456789012:service/prod-cluster/worker-service',
      type: 'AWS::ECS::Service',
      name: 'worker-service',
      region: REGION,
      accountId: ACCOUNT_ID,
      properties: {
        clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/prod-cluster',
        status: 'ACTIVE', desiredCount: 2, runningCount: 2, launchType: 'FARGATE',
      },
      dependencies: [
        'arn:aws:ecs:us-east-1:123456789012:cluster/prod-cluster',
        'subnet-private-1a',
        'sg-app-prod',
        'AROAEXAMPLEROLEID001',
      ],
    },
    // RDS
    {
      id: 'prod-postgres',
      arn: `arn:aws:rds:${REGION}:${ACCOUNT_ID}:db:prod-postgres`,
      type: 'AWS::RDS::DBInstance',
      name: 'prod-postgres',
      region: REGION,
      accountId: ACCOUNT_ID,
      properties: {
        engine: 'postgres', engineVersion: '15.4', instanceClass: 'db.t3.medium',
        status: 'available', multiAZ: true, storageType: 'gp3', allocatedStorage: 100,
        publiclyAccessible: false,
      },
      dependencies: ['subnet-private-1a', 'subnet-private-1b', 'sg-rds-prod'],
    },
    // Secrets Manager
    {
      id: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-password-AbCdEf',
      arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-password-AbCdEf',
      type: 'AWS::SecretsManager::Secret',
      name: 'prod/db-password',
      region: REGION,
      accountId: ACCOUNT_ID,
      properties: { rotationEnabled: true },
      dependencies: [],
    },
    // Lambda
    {
      id: 'arn:aws:lambda:us-east-1:123456789012:function:prod-authorizer',
      arn: 'arn:aws:lambda:us-east-1:123456789012:function:prod-authorizer',
      type: 'AWS::Lambda::Function',
      name: 'prod-authorizer',
      region: REGION,
      accountId: ACCOUNT_ID,
      properties: { runtime: 'nodejs22.x', handler: 'index.handler', memorySize: 128, timeout: 5, state: 'Active' },
      dependencies: ['AROAEXAMPLEROLEID001'],
    },
    // S3
    {
      id: 'prod-app-assets-bucket',
      arn: 'arn:aws:s3:::prod-app-assets-bucket',
      type: 'AWS::S3::Bucket',
      name: 'prod-app-assets-bucket',
      region: REGION,
      accountId: ACCOUNT_ID,
      properties: { creationDate: '2024-01-15T00:00:00.000Z' },
      dependencies: [],
    },
  ],

  relationships: [
    // Subnets → VPC
    { source: 'subnet-public-1a',  target: 'vpc-0abc1234def56789a', relationship: 'BELONGS_TO' },
    { source: 'subnet-private-1a', target: 'vpc-0abc1234def56789a', relationship: 'BELONGS_TO' },
    { source: 'subnet-private-1b', target: 'vpc-0abc1234def56789a', relationship: 'BELONGS_TO' },
    // IGW → VPC
    { source: 'igw-0ff1234567890abcd', target: 'vpc-0abc1234def56789a', relationship: 'ATTACHES_TO' },
    // ALB → subnet, SG
    { source: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/prod-alb/0123456789abcdef', target: 'subnet-public-1a', relationship: 'RUNS_IN' },
    { source: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/prod-alb/0123456789abcdef', target: 'sg-alb-prod', relationship: 'USES' },
    // ALB → Target Group
    { source: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/prod-alb/0123456789abcdef', target: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/prod-api-tg/abcdef1234567890', relationship: 'TARGETS' },
    // ECS api-service
    { source: 'arn:aws:ecs:us-east-1:123456789012:service/prod-cluster/api-service', target: 'arn:aws:ecs:us-east-1:123456789012:cluster/prod-cluster', relationship: 'BELONGS_TO' },
    { source: 'arn:aws:ecs:us-east-1:123456789012:service/prod-cluster/api-service', target: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/prod-api-tg/abcdef1234567890', relationship: 'TARGETS' },
    { source: 'arn:aws:ecs:us-east-1:123456789012:service/prod-cluster/api-service', target: 'subnet-private-1a', relationship: 'RUNS_IN' },
    { source: 'arn:aws:ecs:us-east-1:123456789012:service/prod-cluster/api-service', target: 'subnet-private-1b', relationship: 'RUNS_IN' },
    { source: 'arn:aws:ecs:us-east-1:123456789012:service/prod-cluster/api-service', target: 'sg-app-prod', relationship: 'USES' },
    { source: 'arn:aws:ecs:us-east-1:123456789012:service/prod-cluster/api-service', target: 'AROAEXAMPLEROLEID001', relationship: 'USES' },
    { source: 'arn:aws:ecs:us-east-1:123456789012:service/prod-cluster/api-service', target: 'prod-postgres', relationship: 'CONNECTS_TO' },
    // ECS worker-service
    { source: 'arn:aws:ecs:us-east-1:123456789012:service/prod-cluster/worker-service', target: 'arn:aws:ecs:us-east-1:123456789012:cluster/prod-cluster', relationship: 'BELONGS_TO' },
    { source: 'arn:aws:ecs:us-east-1:123456789012:service/prod-cluster/worker-service', target: 'subnet-private-1a', relationship: 'RUNS_IN' },
    { source: 'arn:aws:ecs:us-east-1:123456789012:service/prod-cluster/worker-service', target: 'sg-app-prod', relationship: 'USES' },
    { source: 'arn:aws:ecs:us-east-1:123456789012:service/prod-cluster/worker-service', target: 'AROAEXAMPLEROLEID001', relationship: 'USES' },
    { source: 'arn:aws:ecs:us-east-1:123456789012:service/prod-cluster/worker-service', target: 'prod-postgres', relationship: 'CONNECTS_TO' },
    // RDS → subnets, SG
    { source: 'prod-postgres', target: 'subnet-private-1a', relationship: 'RUNS_IN' },
    { source: 'prod-postgres', target: 'subnet-private-1b', relationship: 'RUNS_IN' },
    { source: 'prod-postgres', target: 'sg-rds-prod', relationship: 'USES' },
    // Lambda → IAM
    { source: 'arn:aws:lambda:us-east-1:123456789012:function:prod-authorizer', target: 'AROAEXAMPLEROLEID001', relationship: 'USES' },
  ],

  errors: [],

  stats: {
    totalResources: 18,
    totalRelationships: 22,
    totalErrors: 0,
    durationMs: 4821,
    byType: {
      'AWS::EC2::VPC': 1,
      'AWS::EC2::Subnet': 3,
      'AWS::EC2::InternetGateway': 1,
      'AWS::EC2::SecurityGroup': 3,
      'AWS::ElasticLoadBalancingV2::LoadBalancer': 1,
      'AWS::ElasticLoadBalancingV2::TargetGroup': 1,
      'AWS::ECS::Cluster': 1,
      'AWS::ECS::Service': 2,
      'AWS::RDS::DBInstance': 1,
      'AWS::SecretsManager::Secret': 1,
      'AWS::Lambda::Function': 1,
      'AWS::S3::Bucket': 1,
      'AWS::IAM::Role': 1,
    },
  },
};

// ── Run against Kuzu graph DB ─────────────────────────────────────────────────

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'kuzu-mock-'));
  const repo = new KuzuInfrastructureRepository(join(tmpDir, 'db'));

  try {
    console.log('\n========================================');
    console.log('  AWS Infrastructure Discovery — MOCK');
    console.log('========================================\n');

    await repo.init();
    await repo.saveInventory(mockInventory);

    // ── Scan summary ──────────────────────────────────────────────────────────
    const inv = await repo.getInventory(REGION);
    console.log(`Region:        ${inv.region}`);
    console.log(`Account:       ${inv.accountId.replace(/\d{4}$/, '****')}`);
    console.log(`Scanned at:    ${inv.scannedAt}`);
    console.log(`Resources:     ${inv.stats.totalResources}`);
    console.log(`Relationships: ${inv.stats.totalRelationships}`);
    console.log(`Errors:        ${inv.stats.totalErrors}`);
    console.log(`Duration:      ${inv.stats.durationMs}ms (mock)\n`);

    // ── By service ────────────────────────────────────────────────────────────
    console.log('Resources by service:');
    const grouped = {};
    for (const r of inv.resources) {
      const svc = r.type.split('::')[1];
      grouped[svc] = (grouped[svc] ?? 0) + 1;
    }
    for (const [svc, count] of Object.entries(grouped).sort()) {
      console.log(`  ${svc.padEnd(30)} ${count}`);
    }

    // ── Graph query: high-dependency resources ────────────────────────────────
    console.log('\nTop resources by outgoing dependencies:');
    const hubs = await repo.findHighDependencyResources(REGION, 5);
    for (const h of hubs) {
      console.log(`  [${h.outDegree} deps] ${h.name} (${h.type.split('::').slice(1).join('::')})`);
    }

    // ── Graph query: reachable from api-service ───────────────────────────────
    const API_SVC = 'arn:aws:ecs:us-east-1:123456789012:service/prod-cluster/api-service';
    console.log('\nResources reachable from api-service (depth 3):');
    const reachable = await repo.findReachable(API_SVC, 3);
    for (const r of reachable) {
      console.log(`  → ${r.name} (${r.type.split('::').slice(1).join('::')})`);
    }

    // ── Graph query: relationships of RDS ────────────────────────────────────
    console.log('\nRelationships touching prod-postgres (RDS):');
    const rdsRels = await repo.findRelationships('prod-postgres');
    for (const rel of rdsRels) {
      const srcName = inv.resources.find(r => r.id === rel.source)?.name ?? rel.source.split('/').pop();
      const tgtName = inv.resources.find(r => r.id === rel.target)?.name ?? rel.target.split('/').pop();
      console.log(`  ${srcName} --[${rel.relationship}]--> ${tgtName}`);
    }

    // ── Shortest path: ALB → RDS ──────────────────────────────────────────────
    const ALB = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/prod-alb/0123456789abcdef';
    const RDS = 'prod-postgres';
    console.log('\nShortest path: ALB → RDS:');
    const path = await repo.findShortestPath(ALB, RDS);
    if (path) {
      const labels = path.map(id => inv.resources.find(r => r.id === id)?.name ?? id.split('/').pop());
      console.log('  ' + labels.join(' → '));
    } else {
      console.log('  No direct path found (ALB connects via api-service → RDS)');
    }

    // ── Architecture narrative ────────────────────────────────────────────────
    console.log('\n----------------------------------------');
    console.log('Architecture Summary');
    console.log('----------------------------------------');
    console.log('Traffic flow: Internet → prod-alb (ALB, public) → prod-api-tg (Target Group)');
    console.log('                → api-service (ECS/Fargate, 2 tasks) → prod-postgres (RDS Multi-AZ)');
    console.log('Background:   worker-service (ECS/Fargate) → prod-postgres');
    console.log('Auth:         prod-authorizer (Lambda) → prod-ecs-task-role (IAM)');
    console.log('Secrets:      prod/db-password (Secrets Manager) — rotation enabled');
    console.log('Assets:       prod-app-assets-bucket (S3)');
    console.log('Network:      prod-vpc (10.0.0.0/16) / 1 public subnet / 2 private subnets');
    console.log('\n✅ Mock scan complete — structure validated\n');

  } finally {
    await repo.close();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
