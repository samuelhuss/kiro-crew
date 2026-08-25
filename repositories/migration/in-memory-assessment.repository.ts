import type {
  MigrationAssessment,
  ResourceAssessment,
  MigrationBlocker,
} from '../../domain/migration/assessment.js';
import type { MigrationAssessmentRepository } from './assessment.repository.js';

/**
 * In-memory implementation of MigrationAssessmentRepository for the MVP.
 * Zero dependencies, zero persistence across process restarts.
 */
export class InMemoryAssessmentRepository implements MigrationAssessmentRepository {
  private readonly assessments = new Map<string, MigrationAssessment>();

  async saveAssessment(assessment: MigrationAssessment): Promise<void> {
    this.assessments.set(assessment.assessmentId, assessment);
  }

  async getAssessment(assessmentId: string): Promise<MigrationAssessment | undefined> {
    return this.assessments.get(assessmentId);
  }

  async listAssessments(): Promise<MigrationAssessment[]> {
    return [...this.assessments.values()];
  }

  async getResourceAssessment(
    assessmentId: string,
    resourceId: string
  ): Promise<ResourceAssessment | undefined> {
    const assessment = this.assessments.get(assessmentId);
    return assessment?.resources.find((r) => r.resourceId === resourceId);
  }

  async getHighRiskResources(assessmentId: string): Promise<ResourceAssessment[]> {
    const assessment = this.assessments.get(assessmentId);
    if (!assessment) return [];
    return assessment.resources.filter((r) => r.risk === 'HIGH' || r.risk === 'CRITICAL');
  }

  async getMigrationBlockers(assessmentId: string): Promise<MigrationBlocker[]> {
    const assessment = this.assessments.get(assessmentId);
    return assessment ? [...assessment.blockers] : [];
  }
}
