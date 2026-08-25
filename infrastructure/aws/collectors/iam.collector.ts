import { ListRolesCommand } from '@aws-sdk/client-iam';
import type { IAMClient } from '@aws-sdk/client-iam';
import type { AwsResource, ResourceScanError } from '../../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../../domain/relationships/relationship.js';
import { logResourceDiscovered } from '../logger.js';

export async function collectIamResources(
  iam: IAMClient,
  region: string,
  accountId: string
): Promise<{
  resources: AwsResource[];
  relationships: ResourceRelationship[];
  errors: ResourceScanError[];
}> {
  const resources: AwsResource[] = [];
  const errors: ResourceScanError[] = [];

  try {
    let marker: string | undefined;
    do {
      const resp = await iam.send(new ListRolesCommand({ Marker: marker }));
      for (const role of resp.Roles ?? []) {
        if (!role.RoleId || !role.Arn) continue;
        const r: AwsResource = {
          id: role.RoleId,
          arn: role.Arn,
          type: 'AWS::IAM::Role',
          name: role.RoleName ?? '',
          // IAM is global — normalise to the scan region for consistency
          region: 'global',
          accountId,
          properties: {
            path: role.Path,
            createDate: role.CreateDate?.toISOString(),
            maxSessionDuration: role.MaxSessionDuration,
            description: role.Description,
          },
          dependencies: [],
        };
        resources.push(r);
        logResourceDiscovered(region, r.type, r.id);
      }
      marker = resp.IsTruncated ? resp.Marker : undefined;
    } while (marker);
  } catch (err) {
    errors.push({ resourceType: 'AWS::IAM::Role', message: String(err), code: (err as { Code?: string }).Code });
  }

  return { resources, relationships: [], errors };
}
