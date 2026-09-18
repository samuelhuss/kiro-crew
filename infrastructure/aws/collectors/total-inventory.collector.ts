import { SearchCommand } from '@aws-sdk/client-resource-explorer-2';
import type { ResourceExplorer2Client } from '@aws-sdk/client-resource-explorer-2';
import { GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api';
import type { ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api';
import type { RadarResourceItem, RadarSource } from '../../../domain/resources/total-inventory.js';
import { logger } from '../logger.js';

/**
 * Total Inventory — Stage 2a: BROAD DISCOVERY.
 *
 * Lists every ARN in the account/region, including types with no collector.
 * Prefers AWS Resource Explorer (richer, cross-region capable, needs an index
 * to be enabled); falls back to the Tagging API (always available, ARN+tags
 * only) if Resource Explorer is not set up. Read-only. Never throws — an
 * unavailable Resource Explorer index is an expected, handled condition, not
 * a scan failure.
 */
export interface TotalDiscoveryResult {
  items: RadarResourceItem[];
  source: RadarSource;
  errors: string[];
}

export async function collectTotalInventory(
  resourceExplorer: ResourceExplorer2Client,
  taggingApi: ResourceGroupsTaggingAPIClient,
  region: string
): Promise<TotalDiscoveryResult> {
  const viaExplorer = await tryResourceExplorer(resourceExplorer, region);
  if (viaExplorer) return viaExplorer;

  return collectViaTaggingApi(taggingApi, region);
}

async function tryResourceExplorer(
  client: ResourceExplorer2Client,
  region: string
): Promise<TotalDiscoveryResult | null> {
  const items: RadarResourceItem[] = [];
  try {
    let nextToken: string | undefined;
    do {
      const resp = await client.send(
        new SearchCommand({ QueryString: `region:${region}`, NextToken: nextToken, MaxResults: 100 })
      );
      for (const r of resp.Resources ?? []) {
        if (!r.Arn) continue;
        items.push({
          arn: r.Arn,
          resourceType: r.ResourceType ?? guessTypeFromArn(r.Arn) ?? 'unknown',
          region: r.Region ?? region,
          tags: {},
          source: 'RESOURCE_EXPLORER',
        });
      }
      nextToken = resp.NextToken;
    } while (nextToken);

    return { items, source: 'RESOURCE_EXPLORER', errors: [] };
  } catch (err) {
    // Resource Explorer not enabled / no default view — expected, fall back.
    logger.debug('Resource Explorer unavailable, falling back to Tagging API', {
      region,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function collectViaTaggingApi(
  client: ResourceGroupsTaggingAPIClient,
  region: string
): Promise<TotalDiscoveryResult> {
  const items: RadarResourceItem[] = [];
  const errors: string[] = [];
  try {
    let paginationToken: string | undefined;
    do {
      const resp = await client.send(
        new GetResourcesCommand({ PaginationToken: paginationToken, ResourcesPerPage: 100 })
      );
      for (const m of resp.ResourceTagMappingList ?? []) {
        if (!m.ResourceARN) continue;
        const tags: Record<string, string> = {};
        for (const t of m.Tags ?? []) {
          if (t.Key) tags[t.Key] = t.Value ?? '';
        }
        items.push({
          arn: m.ResourceARN,
          resourceType: guessTypeFromArn(m.ResourceARN) ?? 'unknown',
          region,
          tags,
          source: 'TAGGING_API',
        });
      }
      paginationToken = resp.PaginationToken || undefined;
    } while (paginationToken);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return { items, source: 'TAGGING_API', errors };
}

/** ARN service/resource segment → CloudFormation-style type, for the common cases. Best-effort. */
const ARN_TYPE_MAP: Array<{ test: RegExp; type: string }> = [
  { test: /^arn:aws:events:.*:rule\//, type: 'AWS::Events::Rule' },
  { test: /^arn:aws:ssm:.*:parameter\//, type: 'AWS::SSM::Parameter' },
  { test: /^arn:aws:states:.*:stateMachine:/, type: 'AWS::StepFunctions::StateMachine' },
  { test: /^arn:aws:kms:.*:key\//, type: 'AWS::KMS::Key' },
  { test: /^arn:aws:cloudformation:.*:stack\//, type: 'AWS::CloudFormation::Stack' },
  { test: /^arn:aws:apigateway:/, type: 'AWS::ApiGateway::RestApi' },
  { test: /^arn:aws:mediaconvert:/, type: 'AWS::MediaConvert::JobTemplate' },
  { test: /^arn:aws:backup:.*:backup-vault:/, type: 'AWS::Backup::BackupVault' },
];

/**
 * Best-effort mapping from an ARN to a CloudFormation-style resource type.
 * Returns null when we can't confidently identify it — that's fine, it just
 * means Config enrichment will be skipped for that item (stays RADAR_ONLY).
 */
export function guessTypeFromArn(arn: string): string | null {
  for (const { test, type } of ARN_TYPE_MAP) {
    if (test.test(arn)) return type;
  }
  return null;
}
