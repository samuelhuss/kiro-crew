import {
  ListHostedZonesCommand,
} from '@aws-sdk/client-route-53';
import type { Route53Client } from '@aws-sdk/client-route-53';
import type { AwsResource, ResourceScanError } from '../../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../../domain/relationships/relationship.js';
import { logResourceDiscovered } from '../logger.js';

/**
 * Collect Route53 Hosted Zones. DNS is critical for migration planning: knowing
 * which zones exist and whether they are public/private informs the migration
 * strategy (DNS cutover, private-zone recreation, etc.).
 *
 * Future: enumerate record sets to link ALIAS/CNAME targets to ELB/CloudFront.
 */
export async function collectHostedZones(
  route53: Route53Client,
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
      const resp = await route53.send(
        new ListHostedZonesCommand({ Marker: marker })
      );
      isTruncated = resp.IsTruncated ?? false;
      marker = resp.NextMarker;

      for (const zone of resp.HostedZones ?? []) {
        if (!zone.Id) continue;

        // Clean id: strip /hostedzone/ prefix
        const cleanId = zone.Id.replace(/^\/hostedzone\//, '');
        const r: AwsResource = {
          id: cleanId,
          arn: `arn:aws:route53:::hostedzone/${cleanId}`,
          type: 'AWS::Route53::HostedZone' as AwsResource['type'],
          name: zone.Name ?? cleanId,
          region: 'global', // Route53 is global
          accountId,
          properties: {
            privateZone: zone.Config?.PrivateZone ?? false,
            resourceRecordSetCount: zone.ResourceRecordSetCount,
            comment: zone.Config?.Comment,
            callerReference: zone.CallerReference,
          },
          dependencies: [],
        };

        resources.push(r);
        logResourceDiscovered('global', r.type, r.id);
      }
    }
  } catch (err) {
    errors.push({
      resourceType: 'AWS::Route53::HostedZone' as AwsResource['type'],
      message: err instanceof Error ? err.message : String(err),
      code: (err as { Code?: string }).Code,
    });
  }

  return { resources, relationships, errors };
}
