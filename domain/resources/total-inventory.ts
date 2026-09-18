/**
 * Total Inventory ("radar") — broad account-wide discovery that goes beyond the
 * 27 collector-supported types. Two stages, both deterministic (no LLM):
 *
 *   1. BROAD DISCOVERY — every ARN in the account/region, via AWS Resource
 *      Explorer (preferred) or the Tagging API (fallback). Cheap, but no config.
 *   2. CONFIG ENRICHMENT — for ARNs not already covered by a collector, ask
 *      AWS Config whether it tracks that resource type/id. If it does, the
 *      resource can still get a faithful CFN via the IaC Generator even
 *      without a dedicated collector. If not, it stays RADAR_ONLY.
 *
 * Nothing found here is ever dropped silently — everything is classified and
 * reported, even if the classification is "we can't recreate this yet".
 */

/** Where an inventory item came from. COLLECTOR = Stage-1 (full config); the other two are Stage-2 broad discovery. */
export type RadarSource = 'COLLECTOR' | 'RESOURCE_EXPLORER' | 'TAGGING_API';

/** A resource seen by broad discovery, before config enrichment. */
export interface RadarResourceItem {
  arn: string;
  /** CloudFormation-style type string when derivable, else the raw service:resource string. */
  resourceType: string;
  region: string;
  tags: Record<string, string>;
  source: RadarSource;
}

/** Fidelity outcome after attempting AWS Config enrichment. */
export type RadarFidelity = 'ALREADY_FIDELITY' | 'FIDELITY_VIA_CONFIG' | 'RADAR_ONLY';

export interface EnrichedRadarResourceItem extends RadarResourceItem {
  fidelity: RadarFidelity;
  /** Why this fidelity was assigned — always stated, never a silent guess. */
  fidelityReason: string;
}

/** Deterministic relevance classification — never hides a resource, only deprioritizes it. */
export type RelevanceBucket = 'CORE' | 'SUPPORTING' | 'NOISE';

export interface ClassifiedResourceItem extends EnrichedRadarResourceItem {
  relevance: RelevanceBucket;
  relevanceReason: string;
}

export interface TotalInventoryReport {
  region: string;
  accountId: string;
  scannedAt: string;
  /** How broad discovery was performed. */
  discoverySource: RadarSource;
  /** Items already covered by a Stage-1 collector (deduped out of the radar list). */
  alreadyFidelityCount: number;
  items: ClassifiedResourceItem[];
  summary: {
    total: number;
    core: number;
    supporting: number;
    noise: number;
    fidelityViaConfig: number;
    radarOnly: number;
  };
  errors: string[];
}
