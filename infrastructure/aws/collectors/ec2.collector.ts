import {
  DescribeInstancesCommand,
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
 * Collect EC2 instances — all states (running, stopped, terminated).
 * Discovers relationships to VPC, Subnet, SecurityGroups, and IAM Instance Profile.
 */
export async function collectEc2Instances(
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
      const { Reservations = [], NextToken } = await ec2.send(
        new DescribeInstancesCommand({ NextToken: nextToken })
      );
      nextToken = NextToken;

      for (const reservation of Reservations) {
        for (const inst of reservation.Instances ?? []) {
          if (!inst.InstanceId) continue;

          const id = inst.InstanceId;
          const r: AwsResource = {
            id,
            arn: `arn:aws:ec2:${region}:${accountId}:instance/${id}`,
            type: 'AWS::EC2::Instance',
            name: nameFromTags(inst.Tags),
            region,
            accountId,
            properties: {
              instanceType: inst.InstanceType,
              state: inst.State?.Name,
              subnetId: inst.SubnetId,
              vpcId: inst.VpcId,
              privateIpAddress: inst.PrivateIpAddress,
              publicIpAddress: inst.PublicIpAddress,
              imageId: inst.ImageId,
              launchTime: inst.LaunchTime?.toISOString(),
              iamInstanceProfile: inst.IamInstanceProfile?.Arn,
              keyName: inst.KeyName,
              platform: inst.Platform ?? 'linux',
            },
            dependencies: [],
          };

          // Dependencies + relationships
          if (inst.SubnetId) {
            r.dependencies.push(inst.SubnetId);
            relationships.push({ source: id, target: inst.SubnetId, relationship: 'RUNS_IN' });
            logDependencyDiscovered(id, inst.SubnetId, 'RUNS_IN');
          }
          if (inst.VpcId) {
            r.dependencies.push(inst.VpcId);
            relationships.push({ source: id, target: inst.VpcId, relationship: 'BELONGS_TO' });
            logDependencyDiscovered(id, inst.VpcId, 'BELONGS_TO');
          }
          for (const sg of inst.SecurityGroups ?? []) {
            if (sg.GroupId) {
              r.dependencies.push(sg.GroupId);
              relationships.push({ source: id, target: sg.GroupId, relationship: 'USES' });
              logDependencyDiscovered(id, sg.GroupId, 'USES');
            }
          }
          if (inst.IamInstanceProfile?.Arn) {
            // Extract role name from profile ARN: arn:aws:iam::123456:instance-profile/RoleName
            const profileArn = inst.IamInstanceProfile.Arn;
            const roleName = profileArn.split('/').pop();
            if (roleName) {
              r.dependencies.push(roleName);
              relationships.push({ source: id, target: roleName, relationship: 'USES' });
              logDependencyDiscovered(id, roleName, 'USES');
            }
          }

          resources.push(r);
          logResourceDiscovered(region, r.type, r.id);
        }
      }
    } while (nextToken);
  } catch (err) {
    errors.push({
      resourceType: 'AWS::EC2::Instance',
      message: err instanceof Error ? err.message : String(err),
      code: (err as { Code?: string }).Code,
    });
  }

  return { resources, relationships, errors };
}
