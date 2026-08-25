import { ListBucketsCommand, GetBucketLocationCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { AwsResource, ResourceScanError } from '../../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../../domain/relationships/relationship.js';
import { logResourceDiscovered } from '../logger.js';

export async function collectS3Resources(
  s3: S3Client,
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
    const { Buckets = [] } = await s3.send(new ListBucketsCommand({}));
    for (const bucket of Buckets) {
      if (!bucket.Name) continue;
      // Filter to the requested region — S3 ListBuckets returns ALL buckets globally
      let bucketRegion = 'us-east-1';
      try {
        const locResp = await s3.send(new GetBucketLocationCommand({ Bucket: bucket.Name }));
        bucketRegion = locResp.LocationConstraint ?? 'us-east-1';
      } catch {
        // If we can't check location, include it and note unknown region
        bucketRegion = 'unknown';
      }
      if (bucketRegion !== region && bucketRegion !== 'unknown') continue;

      const r: AwsResource = {
        id: bucket.Name,
        arn: `arn:aws:s3:::${bucket.Name}`,
        type: 'AWS::S3::Bucket',
        name: bucket.Name,
        region: bucketRegion,
        accountId,
        properties: {
          creationDate: bucket.CreationDate?.toISOString(),
        },
        dependencies: [],
      };
      resources.push(r);
      logResourceDiscovered(region, r.type, r.id);
    }
  } catch (err) {
    errors.push({ resourceType: 'AWS::S3::Bucket', message: String(err), code: (err as { Code?: string }).Code });
  }

  return { resources, relationships: [], errors };
}
