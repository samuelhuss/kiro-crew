import type { ResourceType } from '../resources/resource.js';
import type { MigrationStrategy, MigrationStatus, RiskLevel } from './strategy.js';

/**
 * Structured, auditable output of the Migration Analysis stage.
 *
 * Every value here is derived from the Infrastructure Graph + Migration Rules.
 * Nothing is guessed. When the system lacks information, status is UNKNOWN and
 * the reasoning explains why.
 */

/** Known migration blocker codes — only emitted when derivable from rules/data. */
export type MigrationBlockerCode =
  | 'UNSUPPORTED_RESOURCE'
  | 'ECR_IMAGE_NOT_AVAILABLE'
  | 'KMS_KEY_UNAVAILABLE'
  | 'SECRET_VALUE_NOT_REPLICATED'
  | 'S3_BUCKET_NAME_GLOBAL_CONFLICT'
  | 'REGIONAL_DEPENDENCY'
  | 'MISSING_TARGET_REGION_EQUIVALENT'
  | 'MANUAL_DNS_CHANGE_REQUIRED'
  | 'CROSS_REGION_DATA_TRANSFER_REQUIRED'
  | 'DEPENDENCY_NOT_MIGRATABLE';

export interface MigrationBlocker {
  resourceId: string;
  blocker: MigrationBlockerCode;
  severity: RiskLevel;
  description: string;
}

export interface ManualAction {
  resourceId: string;
  action: string;
}

/** Per-resource assessment. */
export interface ResourceAssessment {
  resourceId: string;
  resourceType: ResourceType;
  name: string;
  sourceRegion: string;
  targetRegion: string;
  strategy: MigrationStrategy;
  migrationStatus: MigrationStatus;
  risk: RiskLevel;
  riskReasons: string[];
  /** direct dependency ids (from the graph) */
  dependencies: string[];
  /** indirect (transitive) dependency ids */
  indirectDependencies: string[];
  /** resources that must exist in the target region for this to work */
  requiredResources: string[];
  manualActions: string[];
  warnings: string[];
  blockers: MigrationBlocker[];
  reasoning: string;
}

export interface MigrationSummary {
  sourceRegion: string;
  targetRegion: string;
  totalResources: number;
  supported: number;
  supportedWithChanges: number;
  manualAction: number;
  notSupported: number;
  unknown: number;
  /** aggregate/overall risk across all resources */
  risk: RiskLevel;
}

export interface MigrationPhase {
  /** 1-based order derived from graph dependencies */
  order: number;
  name: string;
  resourceIds: string[];
}

export interface MigrationAssessment {
  assessmentId: string;
  sourceRegion: string;
  targetRegion: string;
  createdAt: string; // ISO 8601
  summary: MigrationSummary;
  resources: ResourceAssessment[];
  phases: MigrationPhase[];
  blockers: MigrationBlocker[];
  warnings: string[];
  highRiskResources: string[];
  manualActions: ManualAction[];
}
