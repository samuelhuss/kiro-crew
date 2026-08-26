import {
  DescribeCacheClustersCommand,
} from '@aws-sdk/client-elasticache';
import type { ElastiCacheClient } from '@aws-sdk/client-elasticache';
import type { AwsResource, ResourceScanError } from '../../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../../domain/relationships/relationship.js';
import { logResourceDiscovered, logDependencyDiscovered } from '../logger.js';

/**
 * Collect ElastiCache clusters (Redis/Memcached) — in-memory data stores.
 */
export async function collectElastiCacheClusters(
  elasticache: ElastiCacheClient,
  region: string,
  accountId: string
): Promise<{
  resources: AwsResource[];
  relationships: ResourceRelationship[];
  errors: ResourceScanError[];
}> {
  const resources: AwsResource[] = [];
  const relationships: ResourceRelationship[] = [];
  const errors: ResourceScanError[] = [];

  try {
    let marker: string | undefined;
    do {
      const { CacheClusters = [], Marker } = await elasticache.send(
        new DescribeCacheClustersCommand({ Marker: marker, ShowCacheNodeInfo: true })
      );
      marker = Marker;

      for (const cluster of CacheClusters) {
        if (!cluster.CacheClusterId) continue;

        const id = cluster.CacheClusterId;
        const r: AwsResource = {
          id,
          arn: cluster.ARN ?? `arn:aws:elasticache:${region}:${accountId}:cluster:${id}`,
          type: 'AWS::ElastiCache::CacheCluster' as AwsResource['type'],
          name: id,
          region,
          accountId,
          properties: {
            engine: cluster.Engine,
            engineVersion: cluster.EngineVersion,
            cacheNodeType: cluster.CacheNodeType,
            numCacheNodes: cluster.NumCacheNodes,
            cacheClusterStatus: cluster.CacheClusterStatus,
            preferredAvailabilityZone: cluster.PreferredAvailabilityZone,
            cacheSubnetGroupName: cluster.CacheSubnetGroupName,
            replicationGroupId: cluster.ReplicationGroupId,
            transitEncryptionEnabled: cluster.TransitEncryptionEnabled,
            atRestEncryptionEnabled: cluster.AtRestEncryptionEnabled,
          },
          dependencies: [],
        };

        // Link to VPC via subnet group (name-based, not id)
        if (cluster.CacheSubnetGroupName) {
          r.dependencies.push(cluster.CacheSubnetGroupName);
        }

        // Link to security groups
        for (const sg of cluster.SecurityGroups ?? []) {
          if (sg.SecurityGroupId) {
            r.dependencies.push(sg.SecurityGroupId);
            relationships.push({ source: id, target: sg.SecurityGroupId, relationship: 'USES' });
            logDependencyDiscovered(id, sg.SecurityGroupId, 'USES');
          }
        }

        resources.push(r);
        logResourceDiscovered(region, r.type, r.id);
      }
    } while (marker);
  } catch (err) {
    errors.push({
      resourceType: 'AWS::ElastiCache::CacheCluster' as AwsResource['type'],
      message: err instanceof Error ? err.message : String(err),
      code: (err as { Code?: string }).Code,
    });
  }

  return { resources, relationships, errors };
}
