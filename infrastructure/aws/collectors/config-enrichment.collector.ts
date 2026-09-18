import { BatchGetResourceConfigCommand } from '@aws-sdk/client-config-service';
import type { ConfigServiceClient, ResourceType as ConfigResourceType } from '@aws-sdk/client-config-service';
import type { RadarResourceItem, EnrichedRadarResourceItem } from '../../../domain/resources/total-inventory.js';
import { deriveResourceIdFromArn } from '../../../domain/resources/arn-utils.js';
import { guessTypeFromArn } from './total-inventory.collector.js';
import { logger } from '../logger.js';

/**
 * Total Inventory — Stage 2b: CONFIG ENRICHMENT.
 *
 * For radar items with no Stage-1 collector, ask AWS Config whether it
 * already tracks that resource's configuration. If it does, the resource can
 * still get a faithful CloudFormation template via the IaC Generator (which
 * itself reads AWS Config) — no dedicated collector needed. If Config isn't
 * recording, or doesn't support the type, or we can't confidently derive its
 * resourceId from the ARN, the item is honestly marked RADAR_ONLY.
 *
 * Read-only (BatchGetResourceConfig never mutates). Never throws — a Config
 * lookup failure degrades a batch to RADAR_ONLY, it never aborts the scan.
 */
const BATCH_SIZE = 100;

export async function enrichWithAwsConfig(
  items: RadarResourceItem[],
  configService: ConfigServiceClient
): Promise<EnrichedRadarResourceItem[]> {
  const enriched: EnrichedRadarResourceItem[] = [];

  // Only attempt Config for items whose CFN-style type we could confidently
  // resolve — Config's BatchGetResourceConfig keys on that exact type string.
  const candidates: Array<{ item: RadarResourceItem; resourceType: string; resourceId: string }> = [];
  for (const item of items) {
    const resourceType = item.resourceType !== 'unknown' ? item.resourceType : guessTypeFromArn(item.arn);
    const resourceId = deriveResourceIdFromArn(item.arn);
    if (resourceType && resourceId) {
      candidates.push({ item, resourceType, resourceId });
    } else {
      enriched.push({
        ...item,
        fidelity: 'RADAR_ONLY',
        fidelityReason: 'Could not confidently derive a Config resourceType/resourceId from the ARN.',
      });
    }
  }

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    try {
      // Config's ResourceType is a closed enum; our CFN-style strings match its literal
      // values for supported types, and mismatches simply come back as "not found" below.
      const resp = await configService.send(
        new BatchGetResourceConfigCommand({
          resourceKeys: batch.map((c) => ({
            resourceType: c.resourceType as ConfigResourceType,
            resourceId: c.resourceId,
          })),
        })
      );
      const found = new Set(
        (resp.baseConfigurationItems ?? []).map((c) => `${c.resourceType}|${c.resourceId}`)
      );
      for (const c of batch) {
        const key = `${c.resourceType}|${c.resourceId}`;
        if (found.has(key)) {
          enriched.push({
            ...c.item,
            resourceType: c.resourceType,
            fidelity: 'FIDELITY_VIA_CONFIG',
            fidelityReason: 'AWS Config tracks this resource — the IaC Generator can produce a faithful template.',
          });
        } else {
          enriched.push({
            ...c.item,
            resourceType: c.resourceType,
            fidelity: 'RADAR_ONLY',
            fidelityReason: 'AWS Config does not have a configuration item for this resource (not recording, or type unsupported).',
          });
        }
      }
    } catch (err) {
      logger.debug('AWS Config batch lookup failed, marking batch RADAR_ONLY', {
        error: err instanceof Error ? err.message : String(err),
        batchSize: batch.length,
      });
      for (const c of batch) {
        enriched.push({
          ...c.item,
          resourceType: c.resourceType,
          fidelity: 'RADAR_ONLY',
          fidelityReason: 'AWS Config lookup failed (recorder likely not enabled in this account/region).',
        });
      }
    }
  }

  return enriched;
}
