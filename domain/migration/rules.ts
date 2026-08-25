import type { ResourceType } from '../resources/resource.js';
import type { GraphNode } from '../graph/node.js';
import type { MigrationStrategy, MigrationStatus, RiskLevel } from './strategy.js';
import type { MigrationBlocker } from './assessment.js';

/**
 * Migration Rules — the DETERMINISTIC decision layer.
 *
 *   Infrastructure Graph → Migration Rules → Migration Analysis Agent → Assessment
 *
 * A rule is a pure function of (node, source/target region, dependency context).
 * It returns the base decision for a single resource. The analyzer then applies
 * cross-resource, dependency-aware adjustments on top. No LLM chooses strategies.
 */

/** Context handed to a rule. Dependencies are the DIRECT graph neighbors. */
export interface RuleContext {
  node: GraphNode;
  sourceRegion: string;
  targetRegion: string;
  /** direct dependency nodes (resources this node depends on) */
  dependencies: GraphNode[];
}

export interface RuleResult {
  strategy: MigrationStrategy;
  status: MigrationStatus;
  baseRisk: RiskLevel;
  riskReasons: string[];
  warnings: string[];
  manualActions: string[];
  /** blockers WITHOUT resourceId — the analyzer stamps the id */
  blockers: Array<Omit<MigrationBlocker, 'resourceId'>>;
  /** logical resources that must exist in the target region */
  requiredTargetResources: string[];
  reasoning: string;
}

export interface MigrationRule {
  resourceType: ResourceType;
  evaluate(ctx: RuleContext): RuleResult;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function result(partial: Partial<RuleResult> & Pick<RuleResult, 'strategy' | 'status' | 'baseRisk' | 'reasoning'>): RuleResult {
  return {
    riskReasons: [],
    warnings: [],
    manualActions: [],
    blockers: [],
    requiredTargetResources: [],
    ...partial,
  };
}

// ── Rule catalog ──────────────────────────────────────────────────────────────
// Only strategies that are SAFE to assert for this MVP are asserted. Anything
// uncertain becomes REQUIRES_MANUAL_ACTION or UNKNOWN — never a guess.

const RULES: Partial<Record<ResourceType, MigrationRule['evaluate']>> = {
  // Networking foundation — recreated from configuration, no persistent data.
  'AWS::EC2::VPC': () =>
    result({
      strategy: 'RECREATE',
      status: 'SUPPORTED',
      baseRisk: 'LOW',
      reasoning: 'VPC is region-scoped configuration; recreate an equivalent VPC in the target region.',
      warnings: ['CIDR ranges may need to differ if peering with existing networks.'],
    }),

  'AWS::EC2::Subnet': () =>
    result({
      strategy: 'RECREATE',
      status: 'SUPPORTED',
      baseRisk: 'LOW',
      reasoning: 'Subnets are recreated inside the target VPC. Availability Zones differ per region.',
      warnings: ['Target region may expose different Availability Zones.'],
      requiredTargetResources: ['target VPC'],
    }),

  'AWS::EC2::RouteTable': () =>
    result({
      strategy: 'RECREATE',
      status: 'SUPPORTED',
      baseRisk: 'LOW',
      reasoning: 'Route tables are recreated; route targets must reference target-region resources.',
    }),

  'AWS::EC2::InternetGateway': () =>
    result({
      strategy: 'RECREATE',
      status: 'SUPPORTED',
      baseRisk: 'LOW',
      reasoning: 'Internet Gateway is recreated and attached to the target VPC.',
    }),

  'AWS::EC2::NatGateway': (ctx) =>
    result({
      strategy: 'RECREATE',
      status: 'SUPPORTED_WITH_CHANGES',
      baseRisk: 'MEDIUM',
      reasoning: 'NAT Gateway is recreated; it requires a NEW Elastic IP in the target region.',
      riskReasons: ['New public IP in target region', 'Depends on target subnet'],
      manualActions: [`Allocate a new Elastic IP in ${ctx.targetRegion} for the NAT Gateway.`],
      blockers: [
        {
          blocker: 'REGIONAL_DEPENDENCY',
          severity: 'MEDIUM',
          description: 'Elastic IP is region-specific and cannot be moved; a new one must be allocated.',
        },
      ],
    }),

  'AWS::EC2::SecurityGroup': () =>
    result({
      strategy: 'RECREATE',
      status: 'SUPPORTED_WITH_CHANGES',
      baseRisk: 'LOW',
      reasoning: 'Security groups are recreated in the target VPC; rules referencing SG ids must be remapped.',
      warnings: ['Rules referencing other security group ids need remapping to the new ids.'],
    }),

  'AWS::EC2::Instance': (ctx) =>
    result({
      strategy: 'SNAPSHOT_RESTORE',
      status: 'REQUIRES_MANUAL_ACTION',
      baseRisk: 'HIGH',
      reasoning:
        'EC2 instances require an AMI copied to the target region, and instance-store/EBS data handling. Not fully automatable here.',
      riskReasons: ['Persistent data on volumes', 'AMI must be copied cross-region', 'Instance identity/IP changes'],
      manualActions: [`Copy the AMI to ${ctx.targetRegion} and validate volume/data handling.`],
      blockers: [
        {
          blocker: 'CROSS_REGION_DATA_TRANSFER_REQUIRED',
          severity: 'HIGH',
          description: 'AMI and EBS volume data must be transferred across regions.',
        },
      ],
    }),

  // IAM is global — usually nothing to do beyond ensuring it exists.
  'AWS::IAM::Role': () =>
    result({
      strategy: 'NO_ACTION',
      status: 'SUPPORTED',
      baseRisk: 'LOW',
      reasoning: 'IAM is a global service; roles are not region-bound. Policies referencing regional ARNs may need updates.',
      warnings: ['Inline/attached policies referencing source-region ARNs should be reviewed.'],
    }),

  'AWS::ECS::Cluster': () =>
    result({
      strategy: 'RECREATE',
      status: 'SUPPORTED',
      baseRisk: 'LOW',
      reasoning: 'ECS cluster is control-plane configuration; recreate in the target region.',
    }),

  'AWS::ECS::Service': (ctx) =>
    result({
      strategy: 'RECREATE',
      status: 'SUPPORTED_WITH_CHANGES',
      baseRisk: 'MEDIUM',
      reasoning:
        'ECS service is recreated from its task definition. The container image must be available in the target region (e.g. replicated to ECR there).',
      riskReasons: ['Container image must exist in target region', 'Depends on subnets/SG/target group'],
      warnings: ['Task definition environment/secret references must point to target-region resources.'],
      manualActions: [`Ensure the container image is available in ${ctx.targetRegion} (replicate ECR repository).`],
      blockers: [
        {
          blocker: 'ECR_IMAGE_NOT_AVAILABLE',
          severity: 'HIGH',
          description: 'Container image must be available in the target region before the service can start.',
        },
      ],
    }),

  'AWS::ElasticLoadBalancingV2::LoadBalancer': () =>
    result({
      strategy: 'RECREATE',
      status: 'SUPPORTED_WITH_CHANGES',
      baseRisk: 'MEDIUM',
      reasoning: 'Load balancer is recreated; it gets a NEW DNS name and ARN in the target region.',
      riskReasons: ['DNS name changes', 'ARN changes'],
      warnings: ['Clients/DNS records pointing at the old LB DNS name must be updated.'],
    }),

  'AWS::ElasticLoadBalancingV2::TargetGroup': () =>
    result({
      strategy: 'RECREATE',
      status: 'SUPPORTED_WITH_CHANGES',
      baseRisk: 'LOW',
      reasoning: 'Target group is recreated in the target VPC and re-associated with target-region targets.',
    }),

  'AWS::RDS::DBInstance': () =>
    result({
      strategy: 'SNAPSHOT_RESTORE',
      status: 'SUPPORTED',
      baseRisk: 'HIGH',
      reasoning:
        'RDS holds persistent data. Migrate by copying a snapshot to the target region and restoring, or via replication. The endpoint changes.',
      riskReasons: ['Persistent data', 'Requires snapshot/restore', 'Database endpoint changes'],
      warnings: ['Applications must be reconfigured to the new database endpoint.'],
      blockers: [
        {
          blocker: 'CROSS_REGION_DATA_TRANSFER_REQUIRED',
          severity: 'HIGH',
          description: 'Database snapshot must be copied across regions before restore.',
        },
      ],
    }),

  'AWS::RDS::DBCluster': () =>
    result({
      strategy: 'SNAPSHOT_RESTORE',
      status: 'SUPPORTED',
      baseRisk: 'HIGH',
      reasoning: 'RDS cluster holds persistent data; migrate via cross-region snapshot copy + restore or global database.',
      riskReasons: ['Persistent data', 'Requires snapshot/restore', 'Cluster endpoint changes'],
      blockers: [
        {
          blocker: 'CROSS_REGION_DATA_TRANSFER_REQUIRED',
          severity: 'HIGH',
          description: 'Cluster snapshot must be copied across regions before restore.',
        },
      ],
    }),

  'AWS::S3::Bucket': () =>
    result({
      strategy: 'REPLICATE',
      status: 'SUPPORTED_WITH_CHANGES',
      baseRisk: 'MEDIUM',
      reasoning:
        'S3 bucket names are globally unique; the target bucket needs a new name (or the same name once released). Data is moved via replication/copy.',
      riskReasons: ['Persistent data', 'Bucket name is global', 'Cross-region data transfer'],
      warnings: ['Bucket name conflict is possible; a new name may be required in the target region.'],
      blockers: [
        {
          blocker: 'S3_BUCKET_NAME_GLOBAL_CONFLICT',
          severity: 'MEDIUM',
          description: 'S3 bucket names are global; the same name cannot exist twice, requiring a rename or handover.',
        },
      ],
    }),

  'AWS::Lambda::Function': (ctx) =>
    result({
      strategy: 'RECREATE',
      status: 'SUPPORTED_WITH_CHANGES',
      baseRisk: 'MEDIUM',
      reasoning:
        'Lambda is recreated from its deployment artifact. The code package (S3/ECR) must be available in the target region.',
      riskReasons: ['Deployment artifact must exist in target region', 'ARN changes'],
      manualActions: [`Make the deployment package/image available in ${ctx.targetRegion}.`],
    }),

  'AWS::SecretsManager::Secret': () =>
    result({
      strategy: 'REPLICATE',
      status: 'REQUIRES_MANUAL_ACTION',
      baseRisk: 'HIGH',
      reasoning:
        'Secret metadata can be recreated, but the secret VALUE is never exposed by discovery and is not migrated automatically. It must be replicated/re-entered securely.',
      riskReasons: ['Secret value not available to tooling', 'Consumers depend on the secret'],
      manualActions: ['Replicate or re-enter the secret value securely in the target region (never logged).'],
      blockers: [
        {
          blocker: 'SECRET_VALUE_NOT_REPLICATED',
          severity: 'HIGH',
          description: 'The secret value is not available and must be handled manually/securely.',
        },
      ],
    }),
};

/**
 * Rules for resource types that are NOT yet in the Infrastructure Graph (the
 * Discovery layer does not collect them yet), but for which we already know the
 * correct treatment. Kept here so the rule engine is correct when discovery
 * evolves. They are looked up by the CloudFormation type STRING.
 */
const FORWARD_LOOKING_RULES: Record<string, MigrationRule['evaluate']> = {
  'AWS::KMS::Key': () =>
    result({
      strategy: 'RECREATE',
      status: 'REQUIRES_MANUAL_ACTION',
      baseRisk: 'CRITICAL',
      reasoning:
        'KMS keys are region-specific and their key material cannot be moved. A new key must be created in the target region and data re-encrypted.',
      riskReasons: ['Key material is region-bound', 'Re-encryption of dependent data required'],
      manualActions: ['Create a new KMS key in the target region and re-encrypt dependent resources.'],
      blockers: [
        { blocker: 'KMS_KEY_UNAVAILABLE', severity: 'CRITICAL', description: 'KMS key material cannot cross regions.' },
      ],
    }),

  'AWS::Logs::LogGroup': () =>
    result({
      strategy: 'RECREATE',
      status: 'SUPPORTED_WITH_CHANGES',
      baseRisk: 'LOW',
      reasoning: 'CloudWatch Log Group is recreated in the target region. Historical log data is not moved by default.',
      warnings: ['Existing log history is not migrated unless explicitly exported.'],
    }),

  'AWS::Route53::HostedZone': () =>
    result({
      strategy: 'NO_ACTION',
      status: 'REQUIRES_MANUAL_ACTION',
      baseRisk: 'MEDIUM',
      reasoning: 'Route53 is a global service. Records pointing at regional endpoints must be updated to target-region endpoints.',
      manualActions: ['Update DNS records to point at the target-region endpoints once resources are live.'],
      blockers: [
        {
          blocker: 'MANUAL_DNS_CHANGE_REQUIRED',
          severity: 'MEDIUM',
          description: 'DNS records must be manually repointed to target-region endpoints.',
        },
      ],
    }),

  'AWS::EC2::EIP': (ctx) =>
    result({
      strategy: 'MANUAL',
      status: 'REQUIRES_MANUAL_ACTION',
      baseRisk: 'MEDIUM',
      reasoning: 'Elastic IPs are region-specific and cannot be moved; a new address must be allocated in the target region.',
      riskReasons: ['Public IP address changes'],
      manualActions: [`Allocate a new Elastic IP in ${ctx.targetRegion} and update references.`],
      blockers: [
        { blocker: 'REGIONAL_DEPENDENCY', severity: 'MEDIUM', description: 'Elastic IP cannot be moved across regions.' },
      ],
    }),
};

/**
 * Look up the migration rule for a resource type. Returns undefined when no rule
 * exists — the analyzer will then mark the resource NOT_SUPPORTED/UNKNOWN
 * explicitly rather than guessing.
 */
export function getMigrationRule(resourceType: string): MigrationRule['evaluate'] | undefined {
  return RULES[resourceType as ResourceType] ?? FORWARD_LOOKING_RULES[resourceType];
}

/** Whether a deterministic rule exists for the given type. */
export function hasMigrationRule(resourceType: string): boolean {
  return getMigrationRule(resourceType) !== undefined;
}

/** Evaluate a rule, or return a NOT_SUPPORTED/UNKNOWN fallback (never a guess). */
export function evaluateRule(ctx: RuleContext): RuleResult {
  const rule = getMigrationRule(ctx.node.type);
  if (!rule) {
    return result({
      strategy: 'NOT_SUPPORTED',
      status: 'UNKNOWN',
      baseRisk: 'MEDIUM',
      reasoning: `No migration rule is defined for resource type "${ctx.node.type}". Marked UNKNOWN — a human must decide; no strategy is assumed.`,
      warnings: ['Resource type not covered by the deterministic rule set.'],
      blockers: [
        {
          blocker: 'UNSUPPORTED_RESOURCE',
          severity: 'MEDIUM',
          description: `Resource type "${ctx.node.type}" has no defined migration rule.`,
        },
      ],
    });
  }
  return rule(ctx);
}
