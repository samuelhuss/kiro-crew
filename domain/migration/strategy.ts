/**
 * Migration decision vocabularies.
 *
 * These values are produced DETERMINISTICALLY by the Migration Rules — never
 * invented by an LLM. The agent may explain them, but not choose them.
 */

/** How a resource would be moved from the source to the target region. */
export type MigrationStrategy =
  | 'RECREATE' // rebuild from configuration (stateless / config-only resources)
  | 'REPLICATE' // set up ongoing/one-off replication of content
  | 'COPY' // one-time copy of content
  | 'SNAPSHOT_RESTORE' // snapshot in source, restore in target (stateful data stores)
  | 'TRANSFORM' // requires transformation of config/artifacts before recreation
  | 'MANUAL' // must be handled by a human operator
  | 'NOT_SUPPORTED' // cannot be migrated with current knowledge
  | 'NO_ACTION'; // global / region-agnostic — nothing to do

export const MIGRATION_STRATEGIES: readonly MigrationStrategy[] = [
  'RECREATE',
  'REPLICATE',
  'COPY',
  'SNAPSHOT_RESTORE',
  'TRANSFORM',
  'MANUAL',
  'NOT_SUPPORTED',
  'NO_ACTION',
] as const;

/** Migratability status of a resource. */
export type MigrationStatus =
  | 'SUPPORTED'
  | 'SUPPORTED_WITH_CHANGES'
  | 'REQUIRES_MANUAL_ACTION'
  | 'NOT_SUPPORTED'
  | 'UNKNOWN';

export const MIGRATION_STATUSES: readonly MigrationStatus[] = [
  'SUPPORTED',
  'SUPPORTED_WITH_CHANGES',
  'REQUIRES_MANUAL_ACTION',
  'NOT_SUPPORTED',
  'UNKNOWN',
] as const;

/** Risk level of migrating a resource. */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const RISK_LEVELS: readonly RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

/** Numeric ordering so risk can be compared/aggregated. */
export const RISK_ORDER: Record<RiskLevel, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

/** Return the higher of two risk levels. */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/** Status severity ordering for propagation (worse = higher). */
export const STATUS_ORDER: Record<MigrationStatus, number> = {
  SUPPORTED: 1,
  SUPPORTED_WITH_CHANGES: 2,
  REQUIRES_MANUAL_ACTION: 3,
  UNKNOWN: 4,
  NOT_SUPPORTED: 5,
};

export function worseStatus(a: MigrationStatus, b: MigrationStatus): MigrationStatus {
  return STATUS_ORDER[a] >= STATUS_ORDER[b] ? a : b;
}
