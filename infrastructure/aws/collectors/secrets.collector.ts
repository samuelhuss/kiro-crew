import { ListSecretsCommand } from '@aws-sdk/client-secrets-manager';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { AwsResource, ResourceScanError } from '../../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../../domain/relationships/relationship.js';
import { logResourceDiscovered } from '../logger.js';

export async function collectSecretsResources(
  secretsManager: SecretsManagerClient,
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
    let nextToken: string | undefined;
    do {
      const resp = await secretsManager.send(
        new ListSecretsCommand({ NextToken: nextToken, MaxResults: 100 })
      );
      for (const secret of resp.SecretList ?? []) {
        if (!secret.ARN) continue;
        // IMPORTANT: We log ONLY metadata — never the secret value
        const r: AwsResource = {
          id: secret.ARN,
          arn: secret.ARN,
          type: 'AWS::SecretsManager::Secret',
          name: secret.Name ?? '',
          region,
          accountId,
          properties: {
            description: secret.Description,
            rotationEnabled: secret.RotationEnabled,
            lastChangedDate: secret.LastChangedDate?.toISOString(),
            lastAccessedDate: secret.LastAccessedDate?.toISOString(),
            // Deliberately OMIT: SecretString, SecretBinary, KmsKeyId
          },
          dependencies: [],
        };
        resources.push(r);
        logResourceDiscovered(region, r.type, r.id);
      }
      nextToken = resp.NextToken;
    } while (nextToken);
  } catch (err) {
    errors.push({ resourceType: 'AWS::SecretsManager::Secret', message: String(err), code: (err as { Code?: string }).Code });
  }

  return { resources, relationships: [], errors };
}
