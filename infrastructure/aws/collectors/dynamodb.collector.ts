import {
  ListTablesCommand,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { AwsResource, ResourceScanError } from '../../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../../domain/relationships/relationship.js';
import { logResourceDiscovered } from '../logger.js';

/**
 * Collect DynamoDB tables — stateful, region-bound data stores.
 */
export async function collectDynamoDbTables(
  dynamodb: DynamoDBClient,
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
    let lastEvaluatedTableName: string | undefined;
    do {
      const { TableNames = [], LastEvaluatedTableName } = await dynamodb.send(
        new ListTablesCommand({ ExclusiveStartTableName: lastEvaluatedTableName })
      );
      lastEvaluatedTableName = LastEvaluatedTableName;

      for (const tableName of TableNames) {
        try {
          const { Table } = await dynamodb.send(new DescribeTableCommand({ TableName: tableName }));
          if (!Table) continue;

          const id = Table.TableName ?? tableName;
          const r: AwsResource = {
            id,
            arn: Table.TableArn ?? `arn:aws:dynamodb:${region}:${accountId}:table/${id}`,
            type: 'AWS::DynamoDB::Table' as AwsResource['type'],
            name: id,
            region,
            accountId,
            properties: {
              tableStatus: Table.TableStatus,
              itemCount: Table.ItemCount,
              tableSizeBytes: Table.TableSizeBytes,
              billingMode: Table.BillingModeSummary?.BillingMode ?? 'PROVISIONED',
              keySchema: Table.KeySchema,
              gsiCount: Table.GlobalSecondaryIndexes?.length ?? 0,
              lsiCount: Table.LocalSecondaryIndexes?.length ?? 0,
              streamEnabled: !!Table.StreamSpecification?.StreamEnabled,
              pointInTimeRecovery: undefined, // would need separate API call
              encryptionType: Table.SSEDescription?.SSEType,
            },
            dependencies: [],
          };

          resources.push(r);
          logResourceDiscovered(region, r.type, r.id);
        } catch (err) {
          errors.push({
            resourceType: 'AWS::DynamoDB::Table' as AwsResource['type'],
            message: `${tableName}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    } while (lastEvaluatedTableName);
  } catch (err) {
    errors.push({
      resourceType: 'AWS::DynamoDB::Table' as AwsResource['type'],
      message: err instanceof Error ? err.message : String(err),
      code: (err as { Code?: string }).Code,
    });
  }

  return { resources, relationships, errors };
}
