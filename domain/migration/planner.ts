import { randomUUID } from 'node:crypto';
import type { MigrationAssessment, ResourceAssessment, MigrationPhase } from './assessment.js';
import type {
  MigrationPlan,
  MigrationRequirements,
  MigrationPlanPhase,
  MigrationAction,
  MigrationActionType,
  PreFlightCheck,
  CfnStack,
} from './plan.js';
import type { MigrationStrategy, RiskLevel } from './strategy.js';
import { maxRisk } from './strategy.js';

/**
 * MigrationPlanner — generates an executable plan from an assessment.
 *
 * Input:  MigrationAssessment + MigrationRequirements
 * Output: MigrationPlan (ordered phases, actions, CFN stack refs, validation)
 *
 * The planner does NOT execute anything. It produces the plan as data, which
 * can then be:
 *   1. Reviewed by a human
 *   2. Validated via dry-run (cfn-lint, changeset)
 *   3. Executed phase-by-phase (separate step, manual trigger)
 */

// Strategy → primary action type mapping
const STRATEGY_TO_ACTION: Record<MigrationStrategy, MigrationActionType> = {
  RECREATE: 'CREATE_RESOURCE',
  REPLICATE: 'REPLICATE_DATA',
  COPY: 'COPY_SNAPSHOT',
  SNAPSHOT_RESTORE: 'COPY_SNAPSHOT',
  TRANSFORM: 'CREATE_RESOURCE',
  MANUAL: 'CREATE_RESOURCE',
  NOT_SUPPORTED: 'VALIDATE',
  NO_ACTION: 'VALIDATE',
};

// Estimated duration per strategy (minutes)
const STRATEGY_DURATION: Record<MigrationStrategy, number> = {
  RECREATE: 5,
  REPLICATE: 30,
  COPY: 15,
  SNAPSHOT_RESTORE: 20,
  TRANSFORM: 10,
  MANUAL: 60,
  NOT_SUPPORTED: 0,
  NO_ACTION: 0,
};

export function generateMigrationPlan(
  assessment: MigrationAssessment,
  requirements: MigrationRequirements
): MigrationPlan {
  // 1. Scope resources
  const resources = scopeResources(assessment, requirements);

  // 2. Map assessment phases to plan phases with actions
  const planPhases = buildPlanPhases(assessment.phases, resources, requirements);

  // 3. Generate pre-flight checks
  const preFlightChecks = generatePreFlightChecks(requirements, resources);

  // 4. Calculate totals
  const totalActions = planPhases.reduce((sum, p) => sum + p.actions.length, 0);
  const totalEstimatedMinutes = planPhases.reduce((sum, p) => sum + p.estimatedDurationMinutes, 0);
  const overallRisk = planPhases.reduce<RiskLevel>(
    (worst, p) => maxRisk(worst, p.risk),
    'LOW'
  );

  return {
    planId: randomUUID(),
    createdAt: new Date().toISOString(),
    requirements,
    phases: planPhases,
    totalActions,
    totalEstimatedMinutes,
    overallRisk,
    blockers: assessment.blockers.filter(b =>
      resources.some(r => r.resourceId === b.resourceId)
    ),
    preFlightChecks,
    rollbackStrategy: generateRollbackStrategy(planPhases, requirements),
  };
}

function scopeResources(
  assessment: MigrationAssessment,
  requirements: MigrationRequirements
): ResourceAssessment[] {
  if (requirements.scopedResourceIds.length === 0) {
    // All resources except NO_ACTION (global services that need no migration)
    return assessment.resources.filter(r => r.strategy !== 'NO_ACTION');
  }
  // Scoped: only the selected resources + their transitive dependencies
  const selected = new Set(requirements.scopedResourceIds);
  for (const resource of assessment.resources) {
    if (selected.has(resource.resourceId)) {
      for (const dep of resource.dependencies) selected.add(dep);
      for (const dep of resource.indirectDependencies) selected.add(dep);
    }
  }
  return assessment.resources.filter(r =>
    selected.has(r.resourceId) && r.strategy !== 'NO_ACTION'
  );
}

function buildPlanPhases(
  assessmentPhases: MigrationPhase[],
  resources: ResourceAssessment[],
  requirements: MigrationRequirements
): MigrationPlanPhase[] {
  const resourceMap = new Map(resources.map(r => [r.resourceId, r]));
  const planPhases: MigrationPlanPhase[] = [];

  // Phase 0: Cross-account access setup (if cross-account)
  if (requirements.isCrossAccount) {
    planPhases.push({
      order: 0,
      name: 'Cross-Account Access Setup',
      description: 'Configure IAM roles and trust policies for cross-account resource sharing',
      actions: [{
        id: randomUUID(),
        resourceId: 'cross-account-role',
        resourceType: 'AWS::IAM::Role',
        resourceName: 'MigrationExecutionRole',
        strategy: 'RECREATE',
        actionType: 'CONFIGURE_ACCESS',
        description: `Create IAM role in target account ${requirements.targetAccountId} with trust policy for source account ${requirements.sourceAccountId}`,
        cfnStackName: 'migration-access-setup',
        estimatedDurationMinutes: 5,
        parallelizable: false,
        dependsOn: [],
        rollbackSteps: ['Delete the cross-account role in target account'],
        validationSteps: ['aws sts assume-role --role-arn <target-role-arn>'],
      }],
      cfnStacks: [{
        stackName: 'migration-access-setup',
        templatePath: 'cfn/00-access-setup.yaml',
        parameters: [
          { key: 'SourceAccountId', value: requirements.sourceAccountId, description: 'Account ID of the source' },
          { key: 'TargetAccountId', value: requirements.targetAccountId, description: 'Account ID of the target' },
        ],
        capabilities: ['CAPABILITY_NAMED_IAM'],
        description: 'Cross-account IAM trust policies for migration',
      }],
      estimatedDurationMinutes: 5,
      risk: 'LOW',
      rollbackable: true,
    });
  }

  // Map each assessment phase to a plan phase
  for (const phase of assessmentPhases) {
    const phaseResources = phase.resourceIds
      .map(id => resourceMap.get(id))
      .filter((r): r is ResourceAssessment => r !== undefined);

    if (phaseResources.length === 0) continue;

    const actions = phaseResources.map(r => resourceToAction(r, requirements));
    const phaseRisk = phaseResources.reduce<RiskLevel>(
      (worst, r) => maxRisk(worst, r.risk),
      'LOW'
    );

    const cfnStackName = `migration-phase-${phase.order}-${phase.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const cfnStack: CfnStack = {
      stackName: cfnStackName,
      templatePath: `cfn/${String(phase.order).padStart(2, '0')}-${phase.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.yaml`,
      parameters: [
        { key: 'Environment', value: 'migration', description: 'Deployment environment' },
        { key: 'SourceRegion', value: requirements.sourceRegion, description: 'Source AWS region' },
        { key: 'TargetRegion', value: requirements.targetRegion, description: 'Target AWS region' },
      ],
      capabilities: ['CAPABILITY_IAM'],
      description: `Phase ${phase.order}: ${phase.name} (${phaseResources.length} resources)`,
    };

    // Assign stack name to actions
    for (const action of actions) {
      action.cfnStackName = cfnStackName;
    }

    planPhases.push({
      order: planPhases.length + 1,
      name: phase.name,
      description: `Migrate ${phaseResources.length} ${phase.name.toLowerCase()} resources`,
      actions,
      cfnStacks: [cfnStack],
      estimatedDurationMinutes: actions.reduce((sum, a) => sum + a.estimatedDurationMinutes, 0),
      risk: phaseRisk,
      rollbackable: !phaseResources.some(r => r.strategy === 'SNAPSHOT_RESTORE'),
    });
  }

  // Final phase: DNS cutover + validation
  planPhases.push({
    order: planPhases.length + 1,
    name: 'Cutover & Validation',
    description: 'Switch DNS, validate connectivity, decommission source (manual)',
    actions: [
      {
        id: randomUUID(),
        resourceId: 'dns-cutover',
        resourceType: 'AWS::Route53::HostedZone',
        resourceName: 'DNS Cutover',
        strategy: 'MANUAL',
        actionType: 'CUTOVER_DNS',
        description: 'Update DNS records to point to target-region/account resources',
        estimatedDurationMinutes: 15,
        parallelizable: false,
        dependsOn: [],
        rollbackSteps: ['Revert DNS records to source endpoints'],
        validationSteps: ['dig +short <domain>', 'curl -I https://<domain>'],
      },
      {
        id: randomUUID(),
        resourceId: 'decommission',
        resourceType: 'AWS::EC2::Instance',
        resourceName: 'Source Decommission',
        strategy: 'MANUAL',
        actionType: 'DECOMMISSION_SOURCE',
        description: 'After validation period, terminate source resources (MANUAL - never automated)',
        estimatedDurationMinutes: 0,
        parallelizable: false,
        dependsOn: [],
        rollbackSteps: ['Re-enable source resources from snapshots'],
        validationSteps: ['Confirm no traffic hitting source for 7+ days'],
      },
    ],
    cfnStacks: [],
    estimatedDurationMinutes: 15,
    risk: 'HIGH',
    rollbackable: true,
  });

  return planPhases;
}

function resourceToAction(
  resource: ResourceAssessment,
  requirements: MigrationRequirements
): MigrationAction {
  const actionType = STRATEGY_TO_ACTION[resource.strategy];
  const duration = STRATEGY_DURATION[resource.strategy];

  // Build action-specific description
  let description = '';
  switch (resource.strategy) {
    case 'RECREATE':
      description = `Recreate ${resource.resourceType} "${resource.name}" in ${requirements.targetRegion} from configuration`;
      break;
    case 'SNAPSHOT_RESTORE':
      description = `Create snapshot of ${resource.name}, copy to ${requirements.targetRegion}, restore`;
      break;
    case 'REPLICATE':
      description = `Replicate ${resource.name} data to ${requirements.targetRegion}`;
      break;
    case 'MANUAL':
      description = `Manual action required for ${resource.name}: ${resource.manualActions[0] ?? 'see assessment'}`;
      break;
    default:
      description = `${resource.strategy} for ${resource.name}`;
  }

  return {
    id: randomUUID(),
    resourceId: resource.resourceId,
    resourceType: resource.resourceType,
    resourceName: resource.name,
    strategy: resource.strategy,
    actionType,
    description,
    estimatedDurationMinutes: duration,
    parallelizable: resource.strategy === 'RECREATE', // stateless can run in parallel
    dependsOn: resource.dependencies,
    rollbackSteps: generateRollbackStepsForResource(resource),
    validationSteps: generateValidationSteps(resource),
  };
}

function generateRollbackStepsForResource(resource: ResourceAssessment): string[] {
  switch (resource.strategy) {
    case 'RECREATE':
      return [`Delete the recreated ${resource.resourceType} in target region`];
    case 'SNAPSHOT_RESTORE':
      return [`Delete the restored resource in target`, `Original snapshot remains in source`];
    case 'REPLICATE':
      return [`Stop replication`, `Delete replicated data in target`];
    default:
      return [`Revert manually`];
  }
}

function generateValidationSteps(resource: ResourceAssessment): string[] {
  const steps: string[] = [];
  switch (resource.resourceType) {
    case 'AWS::EC2::Instance':
      steps.push('Verify instance is running: aws ec2 describe-instances --instance-ids <new-id>');
      steps.push('Verify connectivity: ping/curl the instance');
      break;
    case 'AWS::RDS::DBInstance':
      steps.push('Verify DB is available: aws rds describe-db-instances');
      steps.push('Test connection from application');
      break;
    case 'AWS::S3::Bucket':
      steps.push('Verify bucket exists: aws s3 ls s3://<bucket-name>');
      steps.push('Verify object count matches source');
      break;
    case 'AWS::ECS::Service':
      steps.push('Verify service is ACTIVE: aws ecs describe-services');
      steps.push('Verify desired/running task count matches');
      break;
    default:
      steps.push(`Verify ${resource.resourceType} exists in target region`);
  }
  return steps;
}

function generatePreFlightChecks(
  requirements: MigrationRequirements,
  resources: ResourceAssessment[]
): PreFlightCheck[] {
  const checks: PreFlightCheck[] = [
    {
      id: 'check-credentials',
      description: 'Verify AWS credentials are valid for both source and target',
      validationCommand: `aws sts get-caller-identity --region ${requirements.sourceRegion}`,
      expectedResult: `Account: ${requirements.sourceAccountId}`,
      blocking: true,
    },
    {
      id: 'check-target-access',
      description: 'Verify access to target account/region',
      validationCommand: requirements.isCrossAccount
        ? `aws sts assume-role --role-arn ${requirements.targetAccountAssumeRoleArn ?? '<configure>'}`
        : `aws sts get-caller-identity --region ${requirements.targetRegion}`,
      expectedResult: `Account: ${requirements.targetAccountId}`,
      blocking: true,
    },
  ];

  // Check ECR images if ECS services are in scope
  if (resources.some(r => r.resourceType === 'AWS::ECS::Service')) {
    checks.push({
      id: 'check-ecr-images',
      description: 'Verify container images exist in target region ECR',
      validationCommand: `aws ecr describe-images --region ${requirements.targetRegion} --repository-name <repo>`,
      expectedResult: 'imageDetails with matching tags',
      blocking: true,
    });
  }

  // Check service quotas
  checks.push({
    id: 'check-service-quotas',
    description: 'Verify target region has sufficient service quotas',
    validationCommand: `aws service-quotas list-service-quotas --region ${requirements.targetRegion} --service-code ec2`,
    expectedResult: 'Quotas sufficient for planned resources',
    blocking: false,
  });

  return checks;
}

function generateRollbackStrategy(
  phases: MigrationPlanPhase[],
  requirements: MigrationRequirements
): string {
  return [
    `Rollback is phase-by-phase in reverse order.`,
    `Phase reversal: ${phases.filter(p => p.rollbackable).length}/${phases.length} phases are auto-rollbackable via CloudFormation stack deletion.`,
    `Data resources (RDS, S3) maintain source copies throughout — rollback = repoint to source.`,
    `DNS cutover is reversible by restoring original records.`,
    requirements.isCrossAccount
      ? `Cross-account IAM roles can be deleted to revoke all target access immediately.`
      : `Same-account rollback: delete target resources, re-enable source.`,
  ].join('\n');
}
