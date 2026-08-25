import { analyzeMigration } from '../../domain/migration/analyzer.js';
import { InMemoryAssessmentRepository } from '../../repositories/migration/in-memory-assessment.repository.js';
import { scenarioMixed } from '../fixtures/migration-scenarios.js';

async function seeded() {
  const repo = new InMemoryAssessmentRepository();
  const assessment = analyzeMigration(scenarioMixed(), 'us-east-1', 'sa-east-1');
  await repo.saveAssessment(assessment);
  return { repo, assessment };
}

describe('InMemoryAssessmentRepository', () => {
  it('saves and retrieves an assessment by id', async () => {
    const { repo, assessment } = await seeded();
    const loaded = await repo.getAssessment(assessment.assessmentId);
    expect(loaded?.assessmentId).toBe(assessment.assessmentId);
  });

  it('returns undefined for an unknown assessment', async () => {
    const { repo } = await seeded();
    expect(await repo.getAssessment('nope')).toBeUndefined();
  });

  it('retrieves a single resource assessment', async () => {
    const { repo, assessment } = await seeded();
    const r = await repo.getResourceAssessment(assessment.assessmentId, 'rds-1');
    expect(r?.resourceType).toBe('AWS::RDS::DBInstance');
  });

  it('lists high-risk resources', async () => {
    const { repo, assessment } = await seeded();
    const high = await repo.getHighRiskResources(assessment.assessmentId);
    expect(high.some((r) => r.resourceId === 'rds-1')).toBe(true);
    expect(high.every((r) => r.risk === 'HIGH' || r.risk === 'CRITICAL')).toBe(true);
  });

  it('lists migration blockers', async () => {
    const { repo, assessment } = await seeded();
    const blockers = await repo.getMigrationBlockers(assessment.assessmentId);
    expect(blockers.length).toBeGreaterThan(0);
  });

  it('lists all assessments', async () => {
    const { repo } = await seeded();
    expect((await repo.listAssessments()).length).toBe(1);
  });
});
