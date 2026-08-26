/**
 * Unit tests for the Phase 1+2 collectors:
 * EC2 Instances, EBS Volumes, Elastic IPs, CloudWatch Logs, Route53,
 * DynamoDB, ECR, SQS, SNS, ElastiCache, CloudFront.
 *
 * Pattern: mock the AWS SDK client, invoke the collector, assert:
 * - resources are mapped correctly (id, arn, type, properties)
 * - relationships are produced for known dependency patterns
 * - errors are captured without crashing
 * - pagination is handled (NextToken loop)
 */

import { collectEc2Instances } from '../../infrastructure/aws/collectors/ec2.collector.js';
import { collectEbsVolumes } from '../../infrastructure/aws/collectors/ebs.collector.js';
import { collectElasticIps } from '../../infrastructure/aws/collectors/eip.collector.js';
import { collectLogGroups } from '../../infrastructure/aws/collectors/cloudwatch.collector.js';
import { collectHostedZones } from '../../infrastructure/aws/collectors/route53.collector.js';
import { collectDynamoDbTables } from '../../infrastructure/aws/collectors/dynamodb.collector.js';
import { collectEcrRepositories } from '../../infrastructure/aws/collectors/ecr.collector.js';
import { collectSqsQueues } from '../../infrastructure/aws/collectors/sqs.collector.js';
import { collectSnsTopics } from '../../infrastructure/aws/collectors/sns.collector.js';
import { collectElastiCacheClusters } from '../../infrastructure/aws/collectors/elasticache.collector.js';
import { collectCloudFrontDistributions } from '../../infrastructure/aws/collectors/cloudfront.collector.js';

const REGION = 'us-east-1';
const ACCOUNT = '123456789012';

/** Helper: create a mock client that returns predefined responses */
function mockClient(responses: Record<string, unknown>): any {
  return {
    send: (cmd: any) => {
      const name = cmd.constructor.name;
      if (responses[name] instanceof Error) throw responses[name];
      return Promise.resolve(responses[name] ?? {});
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EC2 INSTANCES
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectEc2Instances', () => {
  it('should map instances with subnet/vpc/sg relationships', async () => {
    const client = mockClient({
      DescribeInstancesCommand: {
        Reservations: [{
          Instances: [{
            InstanceId: 'i-123',
            InstanceType: 't3.micro',
            State: { Name: 'running' },
            SubnetId: 'subnet-abc',
            VpcId: 'vpc-xyz',
            SecurityGroups: [{ GroupId: 'sg-001' }],
            Tags: [{ Key: 'Name', Value: 'web-server' }],
            PrivateIpAddress: '10.0.1.5',
            ImageId: 'ami-12345',
            LaunchTime: new Date('2024-01-01'),
          }],
        }],
      },
    });

    const { resources, relationships, errors } = await collectEc2Instances(client, REGION, ACCOUNT);

    expect(errors).toHaveLength(0);
    expect(resources).toHaveLength(1);
    expect(resources[0]!.id).toBe('i-123');
    expect(resources[0]!.type).toBe('AWS::EC2::Instance');
    expect(resources[0]!.name).toBe('web-server');
    expect(resources[0]!.properties['instanceType']).toBe('t3.micro');
    expect(resources[0]!.properties['state']).toBe('running');
    expect(resources[0]!.dependencies).toContain('subnet-abc');
    expect(resources[0]!.dependencies).toContain('vpc-xyz');
    expect(resources[0]!.dependencies).toContain('sg-001');

    expect(relationships).toHaveLength(3); // RUNS_IN, BELONGS_TO, USES(sg)
    expect(relationships.find(r => r.relationship === 'RUNS_IN')!.target).toBe('subnet-abc');
    expect(relationships.find(r => r.relationship === 'BELONGS_TO')!.target).toBe('vpc-xyz');
  });

  it('should handle API errors gracefully', async () => {
    const client = mockClient({ DescribeInstancesCommand: new Error('Access Denied') });
    const { resources, errors } = await collectEc2Instances(client, REGION, ACCOUNT);
    expect(resources).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Access Denied');
  });

  it('should handle pagination', async () => {
    let callCount = 0;
    const client = {
      send: () => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'running' } }] }],
            NextToken: 'page2',
          });
        }
        return Promise.resolve({
          Reservations: [{ Instances: [{ InstanceId: 'i-2', State: { Name: 'stopped' } }] }],
        });
      },
    };
    const { resources } = await collectEc2Instances(client as any, REGION, ACCOUNT);
    expect(resources).toHaveLength(2);
    expect(callCount).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EBS VOLUMES
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectEbsVolumes', () => {
  it('should map volumes with ATTACHED_TO relationships', async () => {
    const client = mockClient({
      DescribeVolumesCommand: {
        Volumes: [{
          VolumeId: 'vol-abc',
          Size: 100,
          VolumeType: 'gp3',
          State: 'in-use',
          Encrypted: true,
          AvailabilityZone: 'us-east-1a',
          CreateTime: new Date('2024-06-01'),
          Attachments: [{ InstanceId: 'i-123', Device: '/dev/sda1', State: 'attached' }],
          Tags: [{ Key: 'Name', Value: 'root-vol' }],
        }],
      },
    });

    const { resources, relationships, errors } = await collectEbsVolumes(client, REGION, ACCOUNT);

    expect(errors).toHaveLength(0);
    expect(resources[0]!.id).toBe('vol-abc');
    expect(resources[0]!.properties['size']).toBe(100);
    expect(resources[0]!.properties['encrypted']).toBe(true);
    expect(relationships).toHaveLength(1);
    expect(relationships[0]!.relationship).toBe('ATTACHED_TO');
    expect(relationships[0]!.target).toBe('i-123');
  });

  it('should not create relationship for detached volumes', async () => {
    const client = mockClient({
      DescribeVolumesCommand: {
        Volumes: [{ VolumeId: 'vol-det', State: 'available', Attachments: [] }],
      },
    });
    const { relationships } = await collectEbsVolumes(client, REGION, ACCOUNT);
    expect(relationships).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ELASTIC IPs
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectElasticIps', () => {
  it('should map EIPs with ASSOCIATED_WITH relationships', async () => {
    const client = mockClient({
      DescribeAddressesCommand: {
        Addresses: [{
          AllocationId: 'eipalloc-123',
          PublicIp: '54.1.2.3',
          Domain: 'vpc',
          InstanceId: 'i-abc',
          Tags: [{ Key: 'Name', Value: 'prod-eip' }],
        }],
      },
    });

    const { resources, relationships } = await collectElasticIps(client, REGION, ACCOUNT);
    expect(resources[0]!.id).toBe('eipalloc-123');
    expect(resources[0]!.properties['publicIp']).toBe('54.1.2.3');
    expect(relationships.find(r => r.target === 'i-abc')!.relationship).toBe('ASSOCIATED_WITH');
  });

  it('should handle unassociated EIPs', async () => {
    const client = mockClient({
      DescribeAddressesCommand: {
        Addresses: [{ AllocationId: 'eipalloc-free', PublicIp: '1.2.3.4', Domain: 'vpc' }],
      },
    });
    const { resources, relationships } = await collectElasticIps(client, REGION, ACCOUNT);
    expect(resources).toHaveLength(1);
    expect(relationships).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLOUDWATCH LOG GROUPS
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectLogGroups', () => {
  it('should link Lambda log groups with LOGS_FOR', async () => {
    const client = mockClient({
      DescribeLogGroupsCommand: {
        logGroups: [
          { logGroupName: '/aws/lambda/my-func', arn: 'arn:aws:logs:us-east-1:123:log-group:/aws/lambda/my-func', storedBytes: 1024 },
          { logGroupName: '/custom/app', arn: 'arn:aws:logs:us-east-1:123:log-group:/custom/app', storedBytes: 512 },
        ],
      },
    });

    const { resources, relationships } = await collectLogGroups(client, REGION, ACCOUNT);
    expect(resources).toHaveLength(2);
    // Only the lambda log group gets a LOGS_FOR relationship
    expect(relationships).toHaveLength(1);
    expect(relationships[0]!.source).toBe('/aws/lambda/my-func');
    expect(relationships[0]!.target).toBe('my-func');
    expect(relationships[0]!.relationship).toBe('LOGS_FOR');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE53 HOSTED ZONES
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectHostedZones', () => {
  it('should collect zones and strip /hostedzone/ prefix', async () => {
    const client = mockClient({
      ListHostedZonesCommand: {
        HostedZones: [
          { Id: '/hostedzone/Z123', Name: 'example.com.', Config: { PrivateZone: false }, ResourceRecordSetCount: 5 },
        ],
        IsTruncated: false,
      },
    });

    const { resources } = await collectHostedZones(client, REGION, ACCOUNT);
    expect(resources[0]!.id).toBe('Z123');
    expect(resources[0]!.name).toBe('example.com.');
    expect(resources[0]!.properties['privateZone']).toBe(false);
    expect(resources[0]!.region).toBe('global');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DYNAMODB TABLES
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectDynamoDbTables', () => {
  it('should list + describe tables', async () => {
    const client = {
      send: (cmd: any) => {
        if (cmd.constructor.name === 'ListTablesCommand') {
          return Promise.resolve({ TableNames: ['users', 'orders'] });
        }
        if (cmd.constructor.name === 'DescribeTableCommand') {
          const name = cmd.input.TableName;
          return Promise.resolve({
            Table: {
              TableName: name,
              TableArn: `arn:aws:dynamodb:us-east-1:123:table/${name}`,
              TableStatus: 'ACTIVE',
              ItemCount: name === 'users' ? 1000 : 500,
              TableSizeBytes: 50000,
              KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
            },
          });
        }
        return Promise.resolve({});
      },
    };

    const { resources, errors } = await collectDynamoDbTables(client as any, REGION, ACCOUNT);
    expect(errors).toHaveLength(0);
    expect(resources).toHaveLength(2);
    expect(resources[0]!.type).toBe('AWS::DynamoDB::Table');
    expect(resources[0]!.properties['itemCount']).toBe(1000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ECR REPOSITORIES
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectEcrRepositories', () => {
  it('should collect ECR repos', async () => {
    const client = mockClient({
      DescribeRepositoriesCommand: {
        repositories: [{
          repositoryName: 'my-app',
          repositoryArn: 'arn:aws:ecr:us-east-1:123:repository/my-app',
          repositoryUri: '123.dkr.ecr.us-east-1.amazonaws.com/my-app',
          createdAt: new Date('2024-01-01'),
          imageTagMutability: 'IMMUTABLE',
        }],
      },
    });

    const { resources } = await collectEcrRepositories(client, REGION, ACCOUNT);
    expect(resources[0]!.id).toBe('my-app');
    expect(resources[0]!.type).toBe('AWS::ECR::Repository');
    expect(resources[0]!.properties['repositoryUri']).toContain('dkr.ecr');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SQS QUEUES
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectSqsQueues', () => {
  it('should collect queues and link to DLQ', async () => {
    const client = {
      send: (cmd: any) => {
        if (cmd.constructor.name === 'ListQueuesCommand') {
          return Promise.resolve({ QueueUrls: ['https://sqs.us-east-1.amazonaws.com/123/my-queue'] });
        }
        if (cmd.constructor.name === 'GetQueueAttributesCommand') {
          return Promise.resolve({
            Attributes: {
              QueueArn: 'arn:aws:sqs:us-east-1:123:my-queue',
              VisibilityTimeout: '30',
              RedrivePolicy: JSON.stringify({ deadLetterTargetArn: 'arn:aws:sqs:us-east-1:123:my-queue-dlq' }),
            },
          });
        }
        return Promise.resolve({});
      },
    };

    const { resources, relationships } = await collectSqsQueues(client as any, REGION, ACCOUNT);
    expect(resources[0]!.id).toBe('my-queue');
    expect(resources[0]!.properties['fifoQueue']).toBe(false);
    // DLQ relationship
    expect(relationships).toHaveLength(1);
    expect(relationships[0]!.target).toBe('my-queue-dlq');
    expect(relationships[0]!.relationship).toBe('USES');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SNS TOPICS
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectSnsTopics', () => {
  it('should collect topics', async () => {
    const client = {
      send: (cmd: any) => {
        if (cmd.constructor.name === 'ListTopicsCommand') {
          return Promise.resolve({ Topics: [{ TopicArn: 'arn:aws:sns:us-east-1:123:alerts' }] });
        }
        if (cmd.constructor.name === 'GetTopicAttributesCommand') {
          return Promise.resolve({
            Attributes: { DisplayName: 'Alert Notifications', SubscriptionsConfirmed: '3' },
          });
        }
        return Promise.resolve({});
      },
    };

    const { resources } = await collectSnsTopics(client as any, REGION, ACCOUNT);
    expect(resources[0]!.id).toBe('alerts');
    expect(resources[0]!.name).toBe('Alert Notifications');
    expect(resources[0]!.type).toBe('AWS::SNS::Topic');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ELASTICACHE
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectElastiCacheClusters', () => {
  it('should collect clusters and link to security groups', async () => {
    const client = mockClient({
      DescribeCacheClustersCommand: {
        CacheClusters: [{
          CacheClusterId: 'redis-prod',
          ARN: 'arn:aws:elasticache:us-east-1:123:cluster:redis-prod',
          Engine: 'redis',
          EngineVersion: '7.0',
          CacheNodeType: 'cache.t3.micro',
          NumCacheNodes: 1,
          CacheClusterStatus: 'available',
          SecurityGroups: [{ SecurityGroupId: 'sg-cache' }],
        }],
      },
    });

    const { resources, relationships } = await collectElastiCacheClusters(client, REGION, ACCOUNT);
    expect(resources[0]!.id).toBe('redis-prod');
    expect(resources[0]!.properties['engine']).toBe('redis');
    expect(relationships[0]!.target).toBe('sg-cache');
    expect(relationships[0]!.relationship).toBe('USES');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLOUDFRONT
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectCloudFrontDistributions', () => {
  it('should collect distributions and link S3 origins', async () => {
    const client = mockClient({
      ListDistributionsCommand: {
        DistributionList: {
          IsTruncated: false,
          Items: [{
            Id: 'EDIST123',
            ARN: 'arn:aws:cloudfront::123:distribution/EDIST123',
            DomainName: 'd1234.cloudfront.net',
            Status: 'Deployed',
            Enabled: true,
            Origins: {
              Items: [{ DomainName: 'my-bucket.s3.amazonaws.com', Id: 'S3-origin' }],
            },
            Aliases: { Items: ['cdn.example.com'] },
          }],
        },
      },
    });

    const { resources, relationships } = await collectCloudFrontDistributions(client, REGION, ACCOUNT);
    expect(resources[0]!.id).toBe('EDIST123');
    expect(resources[0]!.region).toBe('global');
    expect(resources[0]!.properties['aliases']).toContain('cdn.example.com');
    // S3 origin link
    expect(relationships).toHaveLength(1);
    expect(relationships[0]!.target).toBe('my-bucket');
    expect(relationships[0]!.relationship).toBe('USES');
  });
});
