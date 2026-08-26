import {
  DescribeVolumesCommand,
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
 * Collect EBS volumes and their attachments to EC2 instances.
 */
export async function collectEbsVolumes(
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
    let nextToken: string | undefined;
    do {
      const { Volumes = [], NextToken } = await ec2.send(
        new DescribeVolumesCommand({ NextToken: nextToken })
      );
      nextToken = NextToken;

      for (const vol of Volumes) {
        if (!vol.VolumeId) continue;

        const id = vol.VolumeId;
        const attachments = (vol.Attachments ?? []).map((a) => ({
          instanceId: a.InstanceId,
          device: a.Device,
          state: a.State,
        }));

        const r: AwsResource = {
          id,
          arn: `arn:aws:ec2:${region}:${accountId}:volume/${id}`,
          type: 'AWS::EC2::Volume' as AwsResource['type'],
          name: nameFromTags(vol.Tags),
          region,
          accountId,
          properties: {
            size: vol.Size,
            volumeType: vol.VolumeType,
            state: vol.State,
            encrypted: vol.Encrypted,
            iops: vol.Iops,
            throughput: vol.Throughput,
            availabilityZone: vol.AvailabilityZone,
            createTime: vol.CreateTime?.toISOString(),
            attachments,
          },
          dependencies: [],
        };

        // Relationships: ATTACHED_TO each instance
        for (const att of vol.Attachments ?? []) {
          if (att.InstanceId && att.State === 'attached') {
            r.dependencies.push(att.InstanceId);
            relationships.push({ source: id, target: att.InstanceId, relationship: 'ATTACHED_TO' as ResourceRelationship['relationship'] });
            logDependencyDiscovered(id, att.InstanceId, 'ATTACHED_TO');
          }
        }

        resources.push(r);
        logResourceDiscovered(region, r.type, r.id);
      }
    } while (nextToken);
  } catch (err) {
    errors.push({
      resourceType: 'AWS::EC2::Volume' as AwsResource['type'],
      message: err instanceof Error ? err.message : String(err),
      code: (err as { Code?: string }).Code,
    });
  }

  return { resources, relationships, errors };
}
