import {
  ListDistributionsCommand,
} from '@aws-sdk/client-cloudfront';
import type { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import type { AwsResource, ResourceScanError } from '../../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../../domain/relationships/relationship.js';
import { logResourceDiscovered, logDependencyDiscovered } from '../logger.js';

/**
 * Collect CloudFront distributions — global CDN, but origins are regional.
 */
export async function collectCloudFrontDistributions(
  cloudfront: CloudFrontClient,
  _region: string,
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
    let marker: string | undefined;
    let isTruncated = true;

    while (isTruncated) {
      const { DistributionList } = await cloudfront.send(
        new ListDistributionsCommand({ Marker: marker })
      );
      isTruncated = DistributionList?.IsTruncated ?? false;
      marker = DistributionList?.NextMarker;

      for (const dist of DistributionList?.Items ?? []) {
        if (!dist.Id) continue;

        const id = dist.Id;
        const origins = (dist.Origins?.Items ?? []).map((o) => ({
          domainName: o.DomainName,
          id: o.Id,
          s3Origin: o.S3OriginConfig !== undefined,
        }));

        const r: AwsResource = {
          id,
          arn: dist.ARN ?? `arn:aws:cloudfront::${accountId}:distribution/${id}`,
          type: 'AWS::CloudFront::Distribution' as AwsResource['type'],
          name: dist.Comment || dist.DomainName || id,
          region: 'global', // CloudFront is global
          accountId,
          properties: {
            domainName: dist.DomainName,
            status: dist.Status,
            enabled: dist.Enabled,
            aliases: dist.Aliases?.Items ?? [],
            origins,
            httpVersion: dist.HttpVersion,
            priceClass: dist.PriceClass,
            webACLId: dist.WebACLId,
          },
          dependencies: [],
        };

        // Link to S3/ALB origins
        for (const origin of dist.Origins?.Items ?? []) {
          if (origin.DomainName) {
            // S3 bucket: bucketname.s3.amazonaws.com or bucketname.s3.region.amazonaws.com
            const s3Match = origin.DomainName.match(/^([^.]+)\.s3[.\-]/);
            if (s3Match) {
              r.dependencies.push(s3Match[1]!);
              relationships.push({ source: id, target: s3Match[1]!, relationship: 'USES' });
              logDependencyDiscovered(id, s3Match[1]!, 'USES');
            }
          }
        }

        resources.push(r);
        logResourceDiscovered('global', r.type, r.id);
      }
    }
  } catch (err) {
    errors.push({
      resourceType: 'AWS::CloudFront::Distribution' as AwsResource['type'],
      message: err instanceof Error ? err.message : String(err),
      code: (err as { Code?: string }).Code,
    });
  }

  return { resources, relationships, errors };
}
