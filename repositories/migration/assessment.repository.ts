import type {
  MigrationAssessment,
  ResourceAssessment,
  MigrationBlocker,
} from '../../domain/migration/assessment.js';

/**
 * Storage-independent contract for persisting migration assessments.
 *
 * The assessment must be retrievable later — the Migration Planner and IaC
 * Generator (future phases) consume it:
 *
 *   Migration Assessment → Migration Planner → IaC Generator
 *
 * MVP ships an in-memory implementation; a DB adapter can replace it without
 * touching the analyzer, agent, or API.
 */
export interface MigrationAssessmentRepository {
  init?(): Promise<void>;
  close?(): Promise<void>;

  saveAssessment(assessment: MigrationAssessment): Promise<void>;
  getAssessment(assessmentId: string): Promise<MigrationAssessment | undefined>;
  listAssessments(): Promise<MigrationAssessment[]>;
  getResourceAssessment(
    assessmentId: string,
    resourceId: string
  ): Promise<ResourceAssessment | undefined>;
  getHighRiskResources(assessmentId: string): Promise<ResourceAssessment[]>;
  getMigrationBlockers(assessmentId: string): Promise<MigrationBlocker[]>;
}
