import type { ResourceType } from '../resources/resource.js';
import type { MigrationStrategy, RiskLevel } from './strategy.js';
import type { MigrationBlocker } from './assessment.js';

/**
 * Migration Plan — the executable output of the planner.
 *
 * Takes a MigrationAssessment (what to do per resource) and produces an
 * ordered, actionable plan with CloudFormation stacks, prerequisites,
 * rollback strategy, and validation steps.
 */

/** What the user wants to achieve — input to the planner. */
export interface MigrationRequirements {
  /** Source account/region */
  sourceAccountId: string;
  sourceRegion: string;
  /** Target account/region */
  targetAccountId: string;
  targetRegion: string;
  /** Specific resource IDs to migrate (empty = all from assessment) */
  scopedResourceIds: string[];
  /** Architecture changes (e.g. "RDS→Aurora", "EC2→Fargate") */
  architectureOverrides: ArchitectureOverride[];
  /** Constraints */
  maxDowntimeMinutes: number;
  requiresZeroDowntime: boolean;
  maintenanceWindow?: string; // cron expression or description
  /** Cross-account specifics */
  isCrossAccount: boolean;
  targetAccountAssumeRoleArn?: string; // role in target to assume for deploys
}

export interface ArchitectureOverride {
  /** Resource ID or type to override */
  sourceResourceId?: string;
  sourceResourceType?: ResourceType;
  /** What it becomes in the target */
  targetResourceType: ResourceType;
  /** Additional config (e.g. engine version, instance class) */
  targetConfig: Record<string, unknown>;
  reasoning: string;
}

/** A single actionable step in a migration phase. */
export interface MigrationAction {
  id: string;
  /** Resource this action operates on */
  resourceId: string;
  resourceType: ResourceType;
  resourceName: string;
  /** What to do */
  strategy: MigrationStrategy;
  actionType: MigrationActionType;
  /** Human-readable description */
  description: string;
  /** CloudFormation stack this belongs to (if applicable) */
  cfnStackName?: string;
  /** Estimated duration */
  estimatedDurationMinutes: number;
  /** Can this run in parallel with other actions in the same phase? */
  parallelizable: boolean;
  /** Actions that must complete before this one */
  dependsOn: string[];
  /** Rollback instructions */
  rollbackSteps: string[];
  /** Validation after completion */
  validationSteps: string[];
}

export type MigrationActionType =
  | 'CREATE_RESOURCE'       // Create in target from scratch (RECREATE strategy)
  | 'COPY_SNAPSHOT'         // Create + copy snapshot cross-region/account
  | 'RESTORE_SNAPSHOT'      // Restore from copied snapshot
  | 'REPLICATE_DATA'        // S3 sync, DDB Global Tables, etc.
  | 'SHARE_RESOURCE'        // Share snapshot/image cross-account
  | 'UPDATE_REFERENCES'     // Update DNS, connection strings, ARN refs
  | 'CONFIGURE_ACCESS'      // IAM roles, resource policies for cross-account
  | 'VALIDATE'              // Health check, smoke test
  | 'CUTOVER_DNS'           // Switch DNS to target
  | 'DECOMMISSION_SOURCE';  // Cleanup old resources (last phase, manual)

/** A phase groups related actions that can be deployed together. */
export interface MigrationPlanPhase {
  order: number;
  name: string;
  description: string;
  actions: MigrationAction[];
  /** CloudFormation stack(s) for this phase */
  cfnStacks: CfnStack[];
  estimatedDurationMinutes: number;
  risk: RiskLevel;
  /** Can this phase be rolled back independently? */
  rollbackable: boolean;
}

export interface CfnStack {
  stackName: string;
  templatePath: string; // relative path to the generated template
  parameters: CfnParameter[];
  capabilities: string[]; // e.g. CAPABILITY_IAM, CAPABILITY_NAMED_IAM
  description: string;
}

export interface CfnParameter {
  key: string;
  value: string;
  description: string;
}

/** The complete migration plan. */
export interface MigrationPlan {
  planId: string;
  createdAt: string;
  requirements: MigrationRequirements;
  /** Ordered phases */
  phases: MigrationPlanPhase[];
  /** Summary */
  totalActions: number;
  totalEstimatedMinutes: number;
  overallRisk: RiskLevel;
  /** All blockers that must be resolved before execution */
  blockers: MigrationBlocker[];
  /** Pre-flight checks (run before execution) */
  preFlightChecks: PreFlightCheck[];
  /** Rollback strategy */
  rollbackStrategy: string;
}

export interface PreFlightCheck {
  id: string;
  description: string;
  /** How to validate (CLI command, API call, etc.) */
  validationCommand: string;
  /** What a passing result looks like */
  expectedResult: string;
  /** Is this blocking (fail = abort) or warning? */
  blocking: boolean;
}
