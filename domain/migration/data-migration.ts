import type { ResourceType } from '../resources/resource.js';
import type { GraphNode } from '../graph/node.js';

/**
 * Data Migration Sequencing.
 *
 * For STATEFUL resources, the CloudFormation template alone is not enough — the
 * data (disk, database contents, objects) must be moved BEFORE the target
 * resource is created, and the CFN must reference the copied artifact.
 *
 * This module produces the ordered data-migration steps and estimates their
 * (temporary) cost.
 *
 *   EC2      -> create AMI -> copy AMI cross-region/account -> CFN uses new AMI
 *   EBS      -> snapshot -> copy snapshot -> CFN references snapshot
 *   RDS      -> DB snapshot -> copy snapshot -> CFN restores from snapshot
 *   S3       -> replicate/sync objects -> CFN creates bucket, data synced
 *   DynamoDB -> backup/export -> restore in target
 */

export type DataMigrationMechanism =
  | 'AMI_COPY'          // EC2: create-image + copy-image
  | 'EBS_SNAPSHOT_COPY' // EBS: create-snapshot + copy-snapshot
  | 'RDS_SNAPSHOT_COPY' // RDS: create-db-snapshot + copy-db-snapshot
  | 'S3_REPLICATION'    // S3: object sync / replication
  | 'DYNAMODB_BACKUP'   // DynamoDB: on-demand backup + restore
  | 'NONE';             // Stateless — no data to move

export interface DataMigrationStep {
  order: number;
  resourceId: string;
  resourceType: ResourceType;
  mechanism: DataMigrationMechanism;
  /** The concrete AWS CLI/SDK commands, in order */
  commands: DataMigrationCommand[];
  /** Estimated data size in GB (from resource properties, 0 if unknown) */
  estimatedDataGB: number;
  /** What the CFN template must reference after this step (e.g. new AMI ID) */
  cfnReference: string;
  /** Cost estimate for this data migration */
  cost: DataMigrationCost;
}

export interface DataMigrationCommand {
  step: string;
  command: string;
  /** Where the output value feeds (e.g. "new AMI ID -> CFN ImageId parameter") */
  producesOutput?: string;
}

export interface DataMigrationCost {
  /** One-time cross-region/account transfer cost */
  transferUsd: number;
  /** Temporary snapshot/backup storage per month (until cutover) */
  temporaryStorageUsdPerMonth: number;
  notes: string[];
}

// Data-transfer pricing (approximate, us-east-1 baseline)
const CROSS_REGION_TRANSFER_PER_GB = 0.02;   // inter-region egress
const EBS_SNAPSHOT_STORAGE_PER_GB = 0.05;    // per GB-month
const S3_STORAGE_PER_GB = 0.023;             // standard per GB-month
const S3_TRANSFER_PER_GB = 0.02;
const DYNAMODB_BACKUP_PER_GB = 0.10;         // per GB-month
const DYNAMODB_RESTORE_PER_GB = 0.15;

/** Which mechanism a resource type needs for data migration. */
export function dataMechanismFor(resourceType: ResourceType): DataMigrationMechanism {
  switch (resourceType) {
    case 'AWS::EC2::Instance': return 'AMI_COPY';
    case 'AWS::EC2::Volume': return 'EBS_SNAPSHOT_COPY';
    case 'AWS::RDS::DBInstance':
    case 'AWS::RDS::DBCluster': return 'RDS_SNAPSHOT_COPY';
    case 'AWS::S3::Bucket': return 'S3_REPLICATION';
    case 'AWS::DynamoDB::Table': return 'DYNAMODB_BACKUP';
    default: return 'NONE';
  }
}

/**
 * Build the data-migration step for a single stateful resource.
 * Returns null for stateless resources (no data to move).
 */
export function buildDataMigrationStep(
  node: GraphNode,
  sourceRegion: string,
  targetRegion: string,
  _targetAccountId: string,
  order: number
): DataMigrationStep | null {
  const mechanism = dataMechanismFor(node.type);
  if (mechanism === 'NONE') return null;

  const props = node.properties ?? {};

  switch (mechanism) {
    case 'AMI_COPY':
      return buildAmiCopyStep(node, props, sourceRegion, targetRegion, order);
    case 'EBS_SNAPSHOT_COPY':
      return buildEbsSnapshotStep(node, props, sourceRegion, targetRegion, order);
    case 'RDS_SNAPSHOT_COPY':
      return buildRdsSnapshotStep(node, props, sourceRegion, targetRegion, order);
    case 'S3_REPLICATION':
      return buildS3ReplicationStep(node, props, targetRegion, order);
    case 'DYNAMODB_BACKUP':
      return buildDynamoBackupStep(node, props, targetRegion, order);
    default:
      return null;
  }
}

function buildAmiCopyStep(
  node: GraphNode, props: Record<string, unknown>,
  sourceRegion: string, targetRegion: string, order: number
): DataMigrationStep {
  // EC2 root volume size (default 8GB if unknown) + any extra volumes
  const sizeGB = estimateInstanceStorageGB(props);
  const amiName = `${node.name || node.id}-migration-${Date.now()}`;

  return {
    order,
    resourceId: node.id,
    resourceType: node.type,
    mechanism: 'AMI_COPY',
    estimatedDataGB: sizeGB,
    cfnReference: 'ImageId (use the copied AMI ID as the ImageId parameter in the CFN)',
    commands: [
      {
        step: 'Create AMI from the source instance (captures OS + root disk + config)',
        command: `aws ec2 create-image --region ${sourceRegion} --instance-id ${node.id} --name "${amiName}" --no-reboot`,
        producesOutput: 'source AMI ID',
      },
      {
        step: 'Wait for the AMI to be available',
        command: `aws ec2 wait image-available --region ${sourceRegion} --image-ids <source-ami-id>`,
      },
      {
        step: `Copy the AMI to ${targetRegion}`,
        command: `aws ec2 copy-image --source-region ${sourceRegion} --region ${targetRegion} --source-image-id <source-ami-id> --name "${amiName}"`,
        producesOutput: 'target AMI ID -> CFN ImageId',
      },
    ],
    cost: {
      transferUsd: round(sizeGB * CROSS_REGION_TRANSFER_PER_GB),
      temporaryStorageUsdPerMonth: round(sizeGB * EBS_SNAPSHOT_STORAGE_PER_GB * 2), // source + target snapshots
      notes: [
        `AMI creation snapshots the ${sizeGB}GB root volume`,
        `Cross-region copy transfers ~${sizeGB}GB`,
        `Snapshots persist (billed) until you delete them post-cutover`,
      ],
    },
  };
}

function buildEbsSnapshotStep(
  node: GraphNode, props: Record<string, unknown>,
  sourceRegion: string, targetRegion: string, order: number
): DataMigrationStep {
  const sizeGB = Number(props['size']) || 8;
  return {
    order,
    resourceId: node.id,
    resourceType: node.type,
    mechanism: 'EBS_SNAPSHOT_COPY',
    estimatedDataGB: sizeGB,
    cfnReference: 'SnapshotId (reference the copied snapshot in the Volume CFN)',
    commands: [
      {
        step: 'Create a snapshot of the source volume',
        command: `aws ec2 create-snapshot --region ${sourceRegion} --volume-id ${node.id} --description "migration ${node.id}"`,
        producesOutput: 'source snapshot ID',
      },
      {
        step: `Copy snapshot to ${targetRegion}`,
        command: `aws ec2 copy-snapshot --source-region ${sourceRegion} --region ${targetRegion} --source-snapshot-id <source-snap-id>`,
        producesOutput: 'target snapshot ID -> CFN SnapshotId',
      },
    ],
    cost: {
      transferUsd: round(sizeGB * CROSS_REGION_TRANSFER_PER_GB),
      temporaryStorageUsdPerMonth: round(sizeGB * EBS_SNAPSHOT_STORAGE_PER_GB * 2),
      notes: [`${sizeGB}GB volume snapshot + cross-region copy`],
    },
  };
}

function buildRdsSnapshotStep(
  node: GraphNode, props: Record<string, unknown>,
  sourceRegion: string, targetRegion: string, order: number
): DataMigrationStep {
  const sizeGB = Number(props['allocatedStorage']) || 20;
  return {
    order,
    resourceId: node.id,
    resourceType: node.type,
    mechanism: 'RDS_SNAPSHOT_COPY',
    estimatedDataGB: sizeGB,
    cfnReference: 'DBSnapshotIdentifier (restore the DB from the copied snapshot)',
    commands: [
      {
        step: 'Create a DB snapshot',
        command: `aws rds create-db-snapshot --region ${sourceRegion} --db-instance-identifier ${node.id} --db-snapshot-identifier ${node.id}-migration`,
        producesOutput: 'source snapshot ARN',
      },
      {
        step: `Copy DB snapshot to ${targetRegion}`,
        command: `aws rds copy-db-snapshot --source-region ${sourceRegion} --region ${targetRegion} --source-db-snapshot-identifier <source-arn> --target-db-snapshot-identifier ${node.id}-migration`,
        producesOutput: 'target snapshot ARN -> CFN DBSnapshotIdentifier',
      },
    ],
    cost: {
      transferUsd: round(sizeGB * CROSS_REGION_TRANSFER_PER_GB),
      temporaryStorageUsdPerMonth: round(sizeGB * EBS_SNAPSHOT_STORAGE_PER_GB),
      notes: [`${sizeGB}GB DB snapshot; manual snapshots are free up to DB size, cross-region copy transfers data`],
    },
  };
}

function buildS3ReplicationStep(
  node: GraphNode, props: Record<string, unknown>,
  targetRegion: string, order: number
): DataMigrationStep {
  const sizeGB = Number(props['sizeGB']) || 0; // often unknown from discovery
  return {
    order,
    resourceId: node.id,
    resourceType: node.type,
    mechanism: 'S3_REPLICATION',
    estimatedDataGB: sizeGB,
    cfnReference: 'BucketName (CFN creates the target bucket; data synced separately)',
    commands: [
      {
        step: 'Create the target bucket (via CFN) with a new globally-unique name',
        command: `# CFN creates the bucket; then sync:`,
      },
      {
        step: `Sync objects to the target bucket in ${targetRegion}`,
        command: `aws s3 sync s3://${node.name || node.id} s3://<target-bucket-name> --source-region <src> --region ${targetRegion}`,
        producesOutput: 'objects copied',
      },
    ],
    cost: {
      transferUsd: sizeGB > 0 ? round(sizeGB * S3_TRANSFER_PER_GB) : 0,
      temporaryStorageUsdPerMonth: sizeGB > 0 ? round(sizeGB * S3_STORAGE_PER_GB) : 0,
      notes: [
        sizeGB > 0 ? `~${sizeGB}GB to transfer` : 'Bucket size unknown — run aws s3 ls --summarize to measure',
        'S3 bucket names are GLOBAL — target needs a new name or the source must be released first',
        'PUT/GET request costs apply for the sync',
      ],
    },
  };
}

function buildDynamoBackupStep(
  node: GraphNode, props: Record<string, unknown>,
  targetRegion: string, order: number
): DataMigrationStep {
  const sizeGB = Number(props['tableSizeBytes'] ? Number(props['tableSizeBytes']) / 1e9 : 0);
  return {
    order,
    resourceId: node.id,
    resourceType: node.type,
    mechanism: 'DYNAMODB_BACKUP',
    estimatedDataGB: round(sizeGB),
    cfnReference: 'TableName (CFN creates schema; data restored from backup/export)',
    commands: [
      {
        step: 'Export the table to S3 (point-in-time) OR use Global Tables for live replication',
        command: `aws dynamodb export-table-to-point-in-time --region ${targetRegion} --table-arn <source-table-arn> --s3-bucket <staging-bucket>`,
        producesOutput: 'S3 export',
      },
      {
        step: 'Import into the target table (or enable Global Tables for zero-downtime)',
        command: `aws dynamodb import-table --region ${targetRegion} ...`,
      },
    ],
    cost: {
      transferUsd: round(sizeGB * DYNAMODB_RESTORE_PER_GB),
      temporaryStorageUsdPerMonth: round(sizeGB * DYNAMODB_BACKUP_PER_GB),
      notes: [
        sizeGB > 0 ? `~${round(sizeGB)}GB table` : 'Table size small/unknown',
        'Global Tables option gives zero-downtime but adds continuous replication cost',
      ],
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function estimateInstanceStorageGB(props: Record<string, unknown>): number {
  // Try blockDeviceMappings, fall back to 8GB default root
  const bdm = props['blockDeviceMappings'];
  if (Array.isArray(bdm) && bdm.length > 0) {
    let total = 0;
    for (const dev of bdm) {
      const size = (dev as { ebs?: { volumeSize?: number } })?.ebs?.volumeSize;
      total += Number(size) || 8;
    }
    return total || 8;
  }
  return 8; // default root volume
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Aggregate the total data-migration cost across all steps. */
export function aggregateDataMigrationCost(steps: DataMigrationStep[]): {
  totalTransferUsd: number;
  totalTemporaryStorageUsdPerMonth: number;
  totalDataGB: number;
} {
  return {
    totalTransferUsd: round(steps.reduce((s, x) => s + x.cost.transferUsd, 0)),
    totalTemporaryStorageUsdPerMonth: round(steps.reduce((s, x) => s + x.cost.temporaryStorageUsdPerMonth, 0)),
    totalDataGB: round(steps.reduce((s, x) => s + x.estimatedDataGB, 0)),
  };
}
