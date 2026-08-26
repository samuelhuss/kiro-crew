import {
  DescribeAddressesCommand,
} from '@aws-sdk/client-ec2';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { AwsResource, ResourceScanError } from '../../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../../domain/relationships/relationship.js';
import { logResourceDiscovered, logDependencyDiscovered } from '../logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nameFromTags(tags?: any[]): string {
  return (tags ?? []).find((t: { Key?: string; Value?: string }) => t.Key === 'Name')?.Value ?? '';
}

/**
 * Collect Elastic IPs and their associations to instances/ENIs.
 */
export async function collectElasticIps(
  ec2: EC2Client,
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
    const { Addresses = [] } = await ec2.send(new DescribeAddressesCommand({}));

    for (const addr of Addresses) {
      if (!addr.AllocationId) continue;

      const id = addr.AllocationId;
      const r: AwsResource = {
        id,
        arn: `arn:aws:ec2:${region}:${accountId}:elastic-ip/${id}`,
        type: 'AWS::EC2::EIP' as AwsResource['type'],
        name: nameFromTags(addr.Tags),
        region,
        accountId,
        properties: {
          publicIp: addr.PublicIp,
          domain: addr.Domain,
          associationId: addr.AssociationId,
          instanceId: addr.InstanceId,
          networkInterfaceId: addr.NetworkInterfaceId,
          networkBorderGroup: addr.NetworkBorderGroup,
        },
        dependencies: [],
      };

      if (addr.InstanceId) {
        r.dependencies.push(addr.InstanceId);
        relationships.push({ source: id, target: addr.InstanceId, relationship: 'ASSOCIATED_WITH' as ResourceRelationship['relationship'] });
        logDependencyDiscovered(id, addr.InstanceId, 'ASSOCIATED_WITH');
      }
      if (addr.NetworkInterfaceId) {
        r.dependencies.push(addr.NetworkInterfaceId);
        relationships.push({ source: id, target: addr.NetworkInterfaceId, relationship: 'ASSOCIATED_WITH' as ResourceRelationship['relationship'] });
        logDependencyDiscovered(id, addr.NetworkInterfaceId, 'ASSOCIATED_WITH');
      }

      resources.push(r);
      logResourceDiscovered(region, r.type, r.id);
    }
  } catch (err) {
    errors.push({
      resourceType: 'AWS::EC2::EIP' as AwsResource['type'],
      message: err instanceof Error ? err.message : String(err),
      code: (err as { Code?: string }).Code,
    });
  }

  return { resources, relationships, errors };
}
