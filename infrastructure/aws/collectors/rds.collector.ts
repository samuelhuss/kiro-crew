import { DescribeDBInstancesCommand, DescribeDBClustersCommand } from '@aws-sdk/client-rds';
import type { RDSClient } from '@aws-sdk/client-rds';
import type { AwsResource, ResourceScanError } from '../../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../../domain/relationships/relationship.js';
import { logResourceDiscovered, logDependencyDiscovered } from '../logger.js';

export async function collectRdsResources(
  rds: RDSClient,
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
    const { DBInstances = [] } = await rds.send(new DescribeDBInstancesCommand({}));
    for (const db of DBInstances) {
      if (!db.DBInstanceIdentifier) continue;
      const arn = db.DBInstanceArn ?? `arn:aws:rds:${region}:${accountId}:db:${db.DBInstanceIdentifier}`;
      const subnetGroupSubnets = (db.DBSubnetGroup?.Subnets ?? [])
        .map((s) => s.SubnetIdentifier)
        .filter((id): id is string => !!id);
      const sgIds = (db.VpcSecurityGroups ?? [])
        .map((sg) => sg.VpcSecurityGroupId)
        .filter((id): id is string => !!id);
      const deps = [...subnetGroupSubnets, ...sgIds];

      const r: AwsResource = {
        id: db.DBInstanceIdentifier,
        arn,
        type: 'AWS::RDS::DBInstance',
        name: db.DBInstanceIdentifier,
        region,
        accountId,
        properties: {
          engine: db.Engine,
          engineVersion: db.EngineVersion,
          instanceClass: db.DBInstanceClass,
          status: db.DBInstanceStatus,
          multiAZ: db.MultiAZ,
          storageType: db.StorageType,
          allocatedStorage: db.AllocatedStorage,
          publiclyAccessible: db.PubliclyAccessible,
          dbSubnetGroupName: db.DBSubnetGroup?.DBSubnetGroupName,
          availabilityZone: db.AvailabilityZone,
          dbClusterIdentifier: db.DBClusterIdentifier,
        },
        dependencies: [...new Set(deps)],
      };
      resources.push(r);
      logResourceDiscovered(region, r.type, r.id);

      for (const subnetId of subnetGroupSubnets) {
        const rel: ResourceRelationship = { source: db.DBInstanceIdentifier, target: subnetId, relationship: 'RUNS_IN' };
        relationships.push(rel);
        logDependencyDiscovered(rel.source, rel.target, rel.relationship);
      }
      for (const sgId of sgIds) {
        const rel: ResourceRelationship = { source: db.DBInstanceIdentifier, target: sgId, relationship: 'USES' };
        relationships.push(rel);
        logDependencyDiscovered(rel.source, rel.target, rel.relationship);
      }
    }
  } catch (err) {
    errors.push({ resourceType: 'AWS::RDS::DBInstance', message: String(err), code: (err as { Code?: string }).Code });
  }

  try {
    const { DBClusters = [] } = await rds.send(new DescribeDBClustersCommand({}));
    for (const cluster of DBClusters) {
      if (!cluster.DBClusterIdentifier) continue;
      const arn = cluster.DBClusterArn ?? `arn:aws:rds:${region}:${accountId}:cluster:${cluster.DBClusterIdentifier}`;
      const sgIds = (cluster.VpcSecurityGroups ?? [])
        .map((sg) => sg.VpcSecurityGroupId)
        .filter((id): id is string => !!id);

      const r: AwsResource = {
        id: cluster.DBClusterIdentifier,
        arn,
        type: 'AWS::RDS::DBCluster',
        name: cluster.DBClusterIdentifier,
        region,
        accountId,
        properties: {
          engine: cluster.Engine,
          engineVersion: cluster.EngineVersion,
          engineMode: cluster.EngineMode,
          status: cluster.Status,
          multiAZ: cluster.MultiAZ,
          dbSubnetGroupName: cluster.DBSubnetGroup,
          availabilityZones: cluster.AvailabilityZones,
        },
        dependencies: sgIds,
      };
      resources.push(r);
      logResourceDiscovered(region, r.type, r.id);
    }
  } catch (err) {
    errors.push({ resourceType: 'AWS::RDS::DBCluster', message: String(err), code: (err as { Code?: string }).Code });
  }

  return { resources, relationships, errors };
}
