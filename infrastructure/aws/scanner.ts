import type { AwsResource, ResourceScanError } from '../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../domain/relationships/relationship.js';
import type { RegionInventory } from '../../domain/resources/inventory.js';
import { computeStats } from '../../domain/resources/inventory.js';
import { getClients, resolveAccountId, validateRegion } from './client.js';
import {
  logScanStarted,
  logScanCompleted,
  logScanFailed,
} from './logger.js';
import { collectNetworkResources } from './collectors/network.collector.js';
import { collectEcsResources } from './collectors/ecs.collector.js';
import { collectElbResources } from './collectors/elb.collector.js';
import { collectRdsResources } from './collectors/rds.collector.js';
import { collectS3Resources } from './collectors/s3.collector.js';
import { collectLambdaResources } from './collectors/lambda.collector.js';
import { collectIamResources } from './collectors/iam.collector.js';
import { collectSecretsResources } from './collectors/secrets.collector.js';
import { collectEc2Instances } from './collectors/ec2.collector.js';
import { collectEbsVolumes } from './collectors/ebs.collector.js';
import { collectElasticIps } from './collectors/eip.collector.js';
import { collectLogGroups } from './collectors/cloudwatch.collector.js';
import { collectHostedZones } from './collectors/route53.collector.js';
import { collectDynamoDbTables } from './collectors/dynamodb.collector.js';
import { collectEcrRepositories } from './collectors/ecr.collector.js';
import { collectSqsQueues } from './collectors/sqs.collector.js';
import { collectSnsTopics } from './collectors/sns.collector.js';
import { collectElastiCacheClusters } from './collectors/elasticache.collector.js';
import { collectCloudFrontDistributions } from './collectors/cloudfront.collector.js';

export interface ScanResult {
  resources: AwsResource[];
  relationships: ResourceRelationship[];
  errors: ResourceScanError[];
}

/**
 * Orchestrates all resource collectors for a given region.
 * Collectors run concurrently where services are independent.
 * Each collector is fault-isolated: one failure never aborts the full scan.
 */
export async function scanRegion(region: string): Promise<RegionInventory> {
  validateRegion(region);

  const startedAt = Date.now();
  logScanStarted(region);

  let accountId: string;
  try {
    accountId = await resolveAccountId(region);
  } catch (err) {
    logScanFailed(region, err);
    throw new Error(
      `Cannot resolve AWS account: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const clients = getClients(region);

  // Run collectors concurrently — each returns a fault-isolated ScanResult
  const results = await Promise.allSettled([
    collectNetworkResources(clients.ec2, region, accountId),
    collectEc2Instances(clients.ec2, region, accountId),
    collectEbsVolumes(clients.ec2, region, accountId),
    collectElasticIps(clients.ec2, region, accountId),
    collectEcsResources(clients.ecs, region, accountId),
    collectElbResources(clients.elbv2, region, accountId),
    collectRdsResources(clients.rds, region, accountId),
    collectS3Resources(clients.s3, region, accountId),
    collectLambdaResources(clients.lambda, region, accountId),
    collectIamResources(clients.iam, region, accountId),
    collectSecretsResources(clients.secretsManager, region, accountId),
    collectLogGroups(clients.cloudwatchLogs, region, accountId),
    collectHostedZones(clients.route53, region, accountId),
    collectDynamoDbTables(clients.dynamodb, region, accountId),
    collectEcrRepositories(clients.ecr, region, accountId),
    collectSqsQueues(clients.sqs, region, accountId),
    collectSnsTopics(clients.sns, region, accountId),
    collectElastiCacheClusters(clients.elasticache, region, accountId),
    collectCloudFrontDistributions(clients.cloudfront, region, accountId),
  ]);

  const allResources: AwsResource[] = [];
  const allRelationships: ResourceRelationship[] = [];
  const allErrors: ResourceScanError[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allResources.push(...result.value.resources);
      allRelationships.push(...result.value.relationships);
      allErrors.push(...result.value.errors);
    } else {
      // Top-level collector crash — record as error, continue
      allErrors.push({
        resourceType: 'AWS::EC2::VPC', // generic placeholder
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  // Deduplicate relationships (same source-target-type triplet)
  const seen = new Set<string>();
  const deduped = allRelationships.filter((r) => {
    const key = `${r.source}|${r.target}|${r.relationship}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const durationMs = Date.now() - startedAt;
  const stats = computeStats(allResources, deduped, allErrors, durationMs);

  logScanCompleted(region, stats.totalResources, stats.totalRelationships, durationMs);

  return {
    region,
    accountId,
    scannedAt: new Date().toISOString(),
    resources: allResources,
    relationships: deduped,
    errors: allErrors,
    stats,
  };
}

/** Return a single resource by ID from a cached inventory */
export function getResourceById(
  inventory: RegionInventory,
  id: string
): AwsResource | undefined {
  return inventory.resources.find((r) => r.id === id || r.arn === id);
}

/** Return direct dependencies of a resource */
export function getResourceDependencies(
  inventory: RegionInventory,
  id: string
): AwsResource[] {
  const resource = getResourceById(inventory, id);
  if (!resource) return [];
  return resource.dependencies
    .map((depId) => getResourceById(inventory, depId))
    .filter((r): r is AwsResource => r !== undefined);
}
