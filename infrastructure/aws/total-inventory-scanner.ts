import type { RegionInventory } from '../../domain/resources/inventory.js';
import type { ClassifiedResourceItem, TotalInventoryReport } from '../../domain/resources/total-inventory.js';
import { classifyRadarItem, classifyResourceRelevance } from '../../domain/resources/relevance.js';
import { getClients, resolveAccountId, validateRegion } from './client.js';
import { collectTotalInventory } from './collectors/total-inventory.collector.js';
import { enrichWithAwsConfig } from './collectors/config-enrichment.collector.js';

/**
 * Total Inventory orchestration — the "radar" pipeline, entirely in code
 * (no LLM/prompt step). Relevance classification runs over BOTH halves of the
 * account, not just the radar overflow — a 1000-resource account is usually
 * mostly AWS-managed scaffolding already sitting in the Stage-1 inventory
 * (default VPC, default SG, service-linked roles), not just in the radar-only
 * tail. Nothing is dropped — every item ends up in `items` with an explicit
 * fidelity + relevance reason:
 *
 *   1. Stage-1 resources (already fully collected) → classified directly from
 *      their real properties (isDefault, isMain, etc.) — fidelity ALREADY_FIDELITY.
 *   2. Broad discovery (Resource Explorer, falling back to Tagging API) → minus
 *      whatever Stage-1 already covers → AWS Config enrichment for the rest →
 *      classified from name/tags only (radar items carry no raw properties).
 */
export async function scanTotalInventory(
  region: string,
  knownInventory?: RegionInventory
): Promise<TotalInventoryReport> {
  validateRegion(region);
  const accountId = await resolveAccountId(region);
  const clients = getClients(region);

  const stage1Resources = knownInventory?.resources ?? [];
  const knownArns = new Set(stage1Resources.map((r) => r.arn).filter(Boolean));

  const stage1Items: ClassifiedResourceItem[] = stage1Resources.map((r) => {
    const relevance = classifyResourceRelevance(r);
    return {
      arn: r.arn,
      resourceType: r.type,
      region: r.region,
      tags: {},
      source: 'COLLECTOR',
      fidelity: 'ALREADY_FIDELITY',
      fidelityReason: 'Captured by a Stage-1 collector — full config already available.',
      relevance: relevance.bucket,
      relevanceReason: relevance.reason,
    };
  });

  const discovery = await collectTotalInventory(clients.resourceExplorer, clients.taggingApi, region);
  // Only what Stage-1 does NOT already have — avoids double-counting and
  // avoids spending a Config lookup on something we already fully captured.
  const toEnrich = discovery.items.filter((i) => !knownArns.has(i.arn));

  const enrichedNew = await enrichWithAwsConfig(toEnrich, clients.configService);
  const radarItems: ClassifiedResourceItem[] = enrichedNew.map((i) => {
    const relevance = classifyRadarItem(i);
    return { ...i, relevance: relevance.bucket, relevanceReason: relevance.reason };
  });

  const items = [...stage1Items, ...radarItems];

  return {
    region,
    accountId,
    scannedAt: new Date().toISOString(),
    discoverySource: discovery.source,
    alreadyFidelityCount: stage1Items.length,
    items,
    summary: {
      total: items.length,
      core: items.filter((i) => i.relevance === 'CORE').length,
      supporting: items.filter((i) => i.relevance === 'SUPPORTING').length,
      noise: items.filter((i) => i.relevance === 'NOISE').length,
      fidelityViaConfig: items.filter((i) => i.fidelity === 'FIDELITY_VIA_CONFIG').length,
      radarOnly: items.filter((i) => i.fidelity === 'RADAR_ONLY').length,
    },
    errors: discovery.errors,
  };
}
