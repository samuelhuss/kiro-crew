import {
  ListTopicsCommand,
  GetTopicAttributesCommand,
} from '@aws-sdk/client-sns';
import type { SNSClient } from '@aws-sdk/client-sns';
import type { AwsResource, ResourceScanError } from '../../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../../domain/relationships/relationship.js';
import { logResourceDiscovered } from '../logger.js';

/**
 * Collect SNS topics — pub/sub messaging, often triggers Lambda/SQS.
 */
export async function collectSnsTopics(
  sns: SNSClient,
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
      const { Topics = [], NextToken } = await sns.send(
        new ListTopicsCommand({ NextToken: nextToken })
      );
      nextToken = NextToken;

      for (const topic of Topics) {
        if (!topic.TopicArn) continue;

        try {
          const { Attributes = {} } = await sns.send(
            new GetTopicAttributesCommand({ TopicArn: topic.TopicArn })
          );

          const topicName = topic.TopicArn.split(':').pop() ?? topic.TopicArn;
          const r: AwsResource = {
            id: topicName,
            arn: topic.TopicArn,
            type: 'AWS::SNS::Topic' as AwsResource['type'],
            name: Attributes['DisplayName'] || topicName,
            region,
            accountId,
            properties: {
              fifoTopic: topicName.endsWith('.fifo'),
              subscriptionsConfirmed: Attributes['SubscriptionsConfirmed'],
              subscriptionsPending: Attributes['SubscriptionsPending'],
              kmsMasterKeyId: Attributes['KmsMasterKeyId'],
            },
            dependencies: [],
          };

          resources.push(r);
          logResourceDiscovered(region, r.type, r.id);
        } catch (err) {
          errors.push({
            resourceType: 'AWS::SNS::Topic' as AwsResource['type'],
            message: `${topic.TopicArn}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    } while (nextToken);
  } catch (err) {
    errors.push({
      resourceType: 'AWS::SNS::Topic' as AwsResource['type'],
      message: err instanceof Error ? err.message : String(err),
      code: (err as { Code?: string }).Code,
    });
  }

  return { resources, relationships, errors };
}
