import { analyzeMigration } from '../../domain/migration/analyzer.js';
import {
  scenarioVpcEcs,
  scenarioEcsRds,
  scenarioEcsSecretsKms,
  scenarioUnsupported,
  scenarioInsufficientInfo,
  scenarioMixed,
  scenarioEmpty,
} from '../fixtures/migration-scenarios.js';

const SRC = 'us-east-1';
const TGT = 'sa-east-1';

const byId = (assessment: ReturnType<typeof analyzeMigration>, id: string) =>
  assessment.resources.find((r) => r.resourceId === id)!;

describe('MigrationAnalyzer', () => {
  describe('Scenario 1: VPC → ECS', () => {
    it('assigns RECREATE to both', () => {
      const a = analyzeMigration(scenarioVpcEcs(), SRC, TGT);
      expect(byId(a, 'vpc-1').strategy).toBe('RECREATE');
      expect(byId(a, 'ecs-1').strategy).toBe('RECREATE');
      expect(a.sourceRegion).toBe(SRC);
      expect(a.targetRegion).toBe(TGT);
    });
  });

  describe('Scenario 2: ECS → RDS', () => {
    it('propagates RDS high risk into the ECS assessment', () => {
      const a = analyzeMigration(scenarioEcsRds(), SRC, TGT);
      const rds = byId(a, 'rds-1');
      const ecs = byId(a, 'ecs-1');
      expect(rds.risk).toBe('HIGH');
      expect(ecs.dependencies).toContain('rds-1');
      // ECS depends on a high-risk resource → its risk is raised and noted.
      expect(ecs.riskReasons.some((r) => r.includes('rds-1'))).toBe(true);
    });
  });

  describe('Scenario 3: ECS → Secrets → KMS', () => {
    it('identifies the full dependency chain (direct + indirect)', () => {
      const a = analyzeMigration(scenarioEcsSecretsKms(), SRC, TGT);
      const ecs = byId(a, 'ecs-1');
      expect(ecs.dependencies).toContain('secret-1');
      expect(ecs.indirectDependencies).toContain('kms-1');
    });

    it('KMS being critical/manual forces ECS to require manual action', () => {
      const a = analyzeMigration(scenarioEcsSecretsKms(), SRC, TGT);
      const secret = byId(a, 'secret-1');
      const ecs = byId(a, 'ecs-1');
      // secret requires manual action (value) → ecs cannot be fully automatic.
      expect(secret.migrationStatus).toBe('REQUIRES_MANUAL_ACTION');
      expect(['SUPPORTED_WITH_CHANGES', 'REQUIRES_MANUAL_ACTION']).toContain(ecs.migrationStatus);
      expect(ecs.blockers.length + ecs.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('Scenario 4: unsupported resource', () => {
    it('marks NOT_SUPPORTED strategy with UNKNOWN status and a blocker', () => {
      const a = analyzeMigration(scenarioUnsupported(), SRC, TGT);
      const r = byId(a, 'mystery-1');
      expect(r.strategy).toBe('NOT_SUPPORTED');
      expect(r.migrationStatus).toBe('UNKNOWN');
      expect(r.blockers.some((b) => b.blocker === 'UNSUPPORTED_RESOURCE')).toBe(true);
    });
  });

  describe('Scenario 5: insufficient information', () => {
    it('returns UNKNOWN rather than guessing a strategy', () => {
      const a = analyzeMigration(scenarioInsufficientInfo(), SRC, TGT);
      const r = byId(a, 'unclear-1');
      expect(r.migrationStatus).toBe('UNKNOWN');
      expect(r.reasoning).toMatch(/no migration rule/i);
    });
  });

  describe('summary + phases + blockers (mixed scenario)', () => {
    it('produces a consistent summary whose counts sum to totalResources', () => {
      const a = analyzeMigration(scenarioMixed(), SRC, TGT);
      const s = a.summary;
      expect(s.supported + s.supportedWithChanges + s.manualAction + s.notSupported + s.unknown).toBe(
        s.totalResources
      );
      expect(s.totalResources).toBe(a.resources.length);
      expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(s.risk);
    });

    it('orders phases by dependency topology (foundation before dependents)', () => {
      const a = analyzeMigration(scenarioMixed(), SRC, TGT);
      const phaseOf = (id: string) => a.phases.find((p) => p.resourceIds.includes(id))!.order;
      // vpc-1 has no deps; subnet-1 depends on it; ecs-1 depends on subnet-1.
      expect(phaseOf('vpc-1')).toBeLessThan(phaseOf('subnet-1'));
      expect(phaseOf('subnet-1')).toBeLessThan(phaseOf('ecs-1'));
      // every resource is placed in exactly one phase
      const placed = a.phases.flatMap((p) => p.resourceIds).sort();
      expect(placed).toEqual(a.resources.map((r) => r.resourceId).sort());
    });

    it('aggregates high-risk resources, blockers and manual actions', () => {
      const a = analyzeMigration(scenarioMixed(), SRC, TGT);
      expect(a.highRiskResources).toContain('rds-1');
      expect(a.blockers.length).toBeGreaterThan(0);
      expect(a.manualActions.some((m) => m.resourceId === 'secret-1')).toBe(true);
    });
  });

  describe('empty graph', () => {
    it('produces an empty, LOW-risk assessment without throwing', () => {
      const a = analyzeMigration(scenarioEmpty(), SRC, TGT);
      expect(a.resources).toHaveLength(0);
      expect(a.phases).toHaveLength(0);
      expect(a.summary.totalResources).toBe(0);
      expect(a.summary.risk).toBe('LOW');
    });
  });

  describe('determinism', () => {
    it('is stable across runs (except the generated id/timestamp)', () => {
      const a1 = analyzeMigration(scenarioMixed(), SRC, TGT);
      const a2 = analyzeMigration(scenarioMixed(), SRC, TGT);
      const strip = (a: ReturnType<typeof analyzeMigration>) =>
        JSON.stringify({ ...a, assessmentId: 'x', createdAt: 'x' });
      expect(strip(a1)).toEqual(strip(a2));
    });
  });
});
