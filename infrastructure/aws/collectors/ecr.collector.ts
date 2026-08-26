import {
  DescribeRepositoriesCommand,
} from '@aws-sdk/client-ecr';
import type { ECRClient } from '@aws-sdk/client-ecr';
import type { AwsResource, ResourceScanError } from '../../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../../domain/relationships/relationship.js';
import { logResourceDiscovered } from '../logger.js';

/**
 * Collect ECR repositories — container image stores that ECS services depend on.
 */
export async function collectEcrRepositories(
  ecr: ECRClient,
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
      const { repositories = [], nextToken: nt } = await ecr.send(
        new DescribeRepositoriesCommand({ nextToken })
      );
      nextToken = nt;

      for (const repo of repositories) {
        if (!repo.repositoryName) continue;

        const id = repo.repositoryName;
        const r: AwsResource = {
          id,
          arn: repo.repositoryArn ?? `arn:aws:ecr:${region}:${accountId}:repository/${id}`,
          type: 'AWS::ECR::Repository' as AwsResource['type'],
          name: id,
          region,
          accountId,
          properties: {
            repositoryUri: repo.repositoryUri,
            createdAt: repo.createdAt?.toISOString(),
            imageTagMutability: repo.imageTagMutability,
            imageScanningEnabled: repo.imageScanningConfiguration?.scanOnPush,
            encryptionType: repo.encryptionConfiguration?.encryptionType,
          },
          dependencies: [],
        };

        resources.push(r);
        logResourceDiscovered(region, r.type, r.id);
      }
    } while (nextToken);
  } catch (err) {
    errors.push({
      resourceType: 'AWS::ECR::Repository' as AwsResource['type'],
      message: err instanceof Error ? err.message : String(err),
      code: (err as { Code?: string }).Code,
    });
  }

  return { resources, relationships, errors };
}
