import type { AwsResource, ResourceScanError } from './resource.js';
import type { ResourceRelationship } from '../relationships/relationship.js';

/** Full output of a scan_region operation */
export interface RegionInventory {
  region: string;
  accountId: string;
  scannedAt: string;            // ISO 8601
  resources: AwsResource[];
  relationships: ResourceRelationship[];
  errors: ResourceScanError[];  // partial failures — scan continues on errors
  stats: InventoryStats;
}

export interface InventoryStats {
  totalResources: number;
  byType: Record<string, number>;
  totalRelationships: number;
  totalErrors: number;
  durationMs: number;
}

/** Groups resources by CloudFormation service prefix (e.g. "EC2", "ECS") */
export function groupByService(
  resources: AwsResource[]
): Record<string, AwsResource[]> {
  const groups: Record<string, AwsResource[]> = {};
  for (const r of resources) {
    // 'AWS::ECS::Service' -> 'ECS'
    const service = r.type.split('::')[1] ?? 'Unknown';
    if (!groups[service]) groups[service] = [];
    groups[service]!.push(r);
  }
  return groups;
}

/** Compute stats from a completed inventory */
export function computeStats(
  resources: AwsResource[],
  relationships: ResourceRelationship[],
  errors: ResourceScanError[],
  durationMs: number
): InventoryStats {
  const byType: Record<string, number> = {};
  for (const r of resources) {
    byType[r.type] = (byType[r.type] ?? 0) + 1;
  }
  return {
    totalResources: resources.length,
    byType,
    totalRelationships: relationships.length,
    totalErrors: errors.length,
    durationMs,
  };
}
