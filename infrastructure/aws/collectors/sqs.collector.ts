import {
  ListQueuesCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { AwsResource, ResourceScanError } from '../../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../../domain/relationships/relationship.js';
import { logResourceDiscovered, logDependencyDiscovered } from '../logger.js';

/**
 * Collect SQS queues — event-driven messaging, often linked to Lambda/ECS.
 */
export async function collectSqsQueues(
  sqs: SQSClient,
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
      const { QueueUrls = [], NextToken } = await sqs.send(
        new ListQueuesCommand({ NextToken: nextToken })
      );
      nextToken = NextToken;

      for (const queueUrl of QueueUrls) {
        try {
          const { Attributes = {} } = await sqs.send(
            new GetQueueAttributesCommand({
              QueueUrl: queueUrl,
              AttributeNames: ['All'],
            })
          );

          const queueArn = Attributes['QueueArn'] ?? '';
          const queueName = queueUrl.split('/').pop() ?? queueUrl;
          const r: AwsResource = {
            id: queueName,
            arn: queueArn,
            type: 'AWS::SQS::Queue' as AwsResource['type'],
            name: queueName,
            region,
            accountId,
            properties: {
              queueUrl,
              fifoQueue: queueName.endsWith('.fifo'),
              visibilityTimeout: Attributes['VisibilityTimeout'],
              messageRetentionPeriod: Attributes['MessageRetentionPeriod'],
              approximateMessages: Attributes['ApproximateNumberOfMessages'],
              dlqArn: Attributes['RedrivePolicy']
                ? JSON.parse(Attributes['RedrivePolicy'])?.deadLetterTargetArn
                : undefined,
              kmsMasterKeyId: Attributes['KmsMasterKeyId'],
            },
            dependencies: [],
          };

          // Link to DLQ if configured
          if (r.properties['dlqArn']) {
            const dlqName = String(r.properties['dlqArn']).split(':').pop() ?? '';
            if (dlqName) {
              r.dependencies.push(dlqName);
              relationships.push({ source: queueName, target: dlqName, relationship: 'USES' });
              logDependencyDiscovered(queueName, dlqName, 'USES');
            }
          }

          resources.push(r);
          logResourceDiscovered(region, r.type, r.id);
        } catch (err) {
          errors.push({
            resourceType: 'AWS::SQS::Queue' as AwsResource['type'],
            message: `${queueUrl}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    } while (nextToken);
  } catch (err) {
    errors.push({
      resourceType: 'AWS::SQS::Queue' as AwsResource['type'],
      message: err instanceof Error ? err.message : String(err),
      code: (err as { Code?: string }).Code,
    });
  }

  return { resources, relationships, errors };
}
