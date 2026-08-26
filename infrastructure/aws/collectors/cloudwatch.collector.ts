import {
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import type { AwsResource, ResourceScanError } from '../../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../../domain/relationships/relationship.js';
import { logResourceDiscovered, logDependencyDiscovered } from '../logger.js';

/**
 * Collect CloudWatch Log Groups and link Lambda log groups to their function.
 */
export async function collectLogGroups(
  cwLogs: CloudWatchLogsClient,
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
      const { logGroups = [], nextToken: nt } = await cwLogs.send(
        new DescribeLogGroupsCommand({ nextToken })
      );
      nextToken = nt;

      for (const lg of logGroups) {
        if (!lg.logGroupName) continue;

        const id = lg.logGroupName;
        const r: AwsResource = {
          id,
          arn: lg.arn ?? `arn:aws:logs:${region}:${accountId}:log-group:${id}`,
          type: 'AWS::Logs::LogGroup' as AwsResource['type'],
          name: id,
          region,
          accountId,
          properties: {
            storedBytes: lg.storedBytes,
            retentionInDays: lg.retentionInDays,
            creationTime: lg.creationTime ? new Date(lg.creationTime).toISOString() : undefined,
            kmsKeyId: lg.kmsKeyId,
          },
          dependencies: [],
        };

        // Link /aws/lambda/<functionName> log groups to their Lambda function
        const lambdaMatch = id.match(/^\/aws\/lambda\/(.+)$/);
        if (lambdaMatch) {
          const functionName = lambdaMatch[1]!;
          r.dependencies.push(functionName);
          relationships.push({ source: id, target: functionName, relationship: 'LOGS_FOR' as ResourceRelationship['relationship'] });
          logDependencyDiscovered(id, functionName, 'LOGS_FOR');
        }

        resources.push(r);
        logResourceDiscovered(region, r.type, r.id);
      }
    } while (nextToken);
  } catch (err) {
    errors.push({
      resourceType: 'AWS::Logs::LogGroup' as AwsResource['type'],
      message: err instanceof Error ? err.message : String(err),
      code: (err as { Code?: string }).Code,
    });
  }

  return { resources, relationships, errors };
}
