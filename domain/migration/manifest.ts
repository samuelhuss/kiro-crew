import type { MigrationAssessment, ResourceAssessment } from './assessment.js';
import type { GraphNode } from '../graph/node.js';
import type { DataMigrationStep } from './data-migration.js';
import { buildDataMigrationStep, dataMechanismFor, aggregateDataMigrationCost } from './data-migration.js';
import { isIacGeneratorSupported } from './iac-generator.js';
import type { ResourceType } from '../resources/resource.js';

/**
 * Migration Manifest — the clear, human-readable planning document.
 *
 * For EVERY resource in scope, it states plainly:
 *   - WHAT IT IS (current config summary)
 *   - WHAT WILL BE CREATED (in the target)
 *   - FIDELITY (can we reproduce it faithfully via IaC Generator?)
 *   - WHAT CHANGES (new IDs, new IPs, new endpoints)
 *   - DATA MIGRATION (snapshot/AMI steps needed, if stateful)
 *   - MANUAL ACTIONS (what a human must do — never hidden as PLACEHOLDER)
 *   - COST (one-time migration + temporary storage)
 *
 * This is produced and reviewed BEFORE any CloudFormation is generated.
 */

export interface ManifestEntry {
  resourceId: string;
  resourceType: ResourceType;
  name: string;
  /** Plain-language "what it is" */
  whatItIs: string;
  /** Plain-language "what will be created in the target" */
  whatWillBeCreated: string;
  /** Can we generate faithful CFN for this? */
  fidelity: 'FULL' | 'PARTIAL' | 'MANUAL_ONLY';
  fidelityReason: string;
  /** What changes on migration (new IDs, IPs, endpoints) */
  changes: string[];
  /** Data migration mechanism + steps */
  dataMigration: DataMigrationStep | null;
  /** Explicit manual actions (NEVER hidden placeholders) */
  manualActions: string[];
  /** Migration blockers for this resource */
  blockers: string[];
  /** Dependencies (must be migrated first) */
  dependsOn: string[];
}

export interface MigrationManifest {
  sourceRegion: string;
  targetRegion: string;
  targetAccountId: string;
  isCrossAccount: boolean;
  createdAt: string;
  entries: ManifestEntry[];
  /** Resources with no relationships — infra of support, migrated but not part of an app */
  orphanCount: number;
  /** Total migration cost estimate */
  migrationCost: {
    oneTimeTransferUsd: number;
    temporaryStorageUsdPerMonth: number;
    totalDataGB: number;
  };
  /** Summary counts */
  summary: {
    total: number;
    fullFidelity: number;
    partialFidelity: number;
    manualOnly: number;
    withDataMigration: number;
    withBlockers: number;
  };
}

/** Build the manifest from an assessment + graph nodes. */
export function buildMigrationManifest(
  assessment: MigrationAssessment,
  nodes: GraphNode[],
  opts: {
    targetAccountId: string;
    isCrossAccount: boolean;
    scopedResourceIds?: string[];
  }
): MigrationManifest {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const scoped = opts.scopedResourceIds && opts.scopedResourceIds.length > 0
    ? new Set(opts.scopedResourceIds)
    : null;

  const entries: ManifestEntry[] = [];
  const dataSteps: DataMigrationStep[] = [];
  let dataOrder = 1;

  for (const resource of assessment.resources) {
    // Skip NO_ACTION (global services) and out-of-scope
    if (resource.strategy === 'NO_ACTION') continue;
    if (scoped && !scoped.has(resource.resourceId)) continue;

    const node = nodeMap.get(resource.resourceId);
    const entry = buildEntry(
      resource, node, assessment.sourceRegion, assessment.targetRegion,
      opts.targetAccountId, opts.isCrossAccount, dataOrder
    );

    if (entry.dataMigration) {
      dataSteps.push(entry.dataMigration);
      dataOrder++;
    }
    entries.push(entry);
  }

  const migrationCost = aggregateDataMigrationCost(dataSteps);

  return {
    sourceRegion: assessment.sourceRegion,
    targetRegion: assessment.targetRegion,
    targetAccountId: opts.targetAccountId,
    isCrossAccount: opts.isCrossAccount,
    createdAt: new Date().toISOString(),
    entries,
    orphanCount: nodes.length - entries.length,
    migrationCost: {
      oneTimeTransferUsd: migrationCost.totalTransferUsd,
      temporaryStorageUsdPerMonth: migrationCost.totalTemporaryStorageUsdPerMonth,
      totalDataGB: migrationCost.totalDataGB,
    },
    summary: {
      total: entries.length,
      fullFidelity: entries.filter(e => e.fidelity === 'FULL').length,
      partialFidelity: entries.filter(e => e.fidelity === 'PARTIAL').length,
      manualOnly: entries.filter(e => e.fidelity === 'MANUAL_ONLY').length,
      withDataMigration: entries.filter(e => e.dataMigration !== null).length,
      withBlockers: entries.filter(e => e.blockers.length > 0).length,
    },
  };
}

function buildEntry(
  resource: ResourceAssessment,
  node: GraphNode | undefined,
  sourceRegion: string,
  targetRegion: string,
  targetAccountId: string,
  isCrossAccount: boolean,
  dataOrder: number
): ManifestEntry {
  const iacSupported = isIacGeneratorSupported(resource.resourceType);
  const mechanism = dataMechanismFor(resource.resourceType);
  const hasData = mechanism !== 'NONE';

  // Fidelity assessment
  let fidelity: ManifestEntry['fidelity'] = 'FULL';
  let fidelityReason = 'IaC Generator produces faithful CloudFormation from the real config';
  if (!iacSupported) {
    fidelity = 'MANUAL_ONLY';
    fidelityReason = 'Not supported by IaC Generator — requires manual template authoring';
  } else if (resource.strategy === 'MANUAL' || resource.migrationStatus === 'REQUIRES_MANUAL_ACTION') {
    fidelity = 'PARTIAL';
    fidelityReason = 'Config reproducible, but data/secrets/AMI need manual handling';
  }

  // Data migration step
  const dataMigration = (node && hasData)
    ? buildDataMigrationStep(node, sourceRegion, targetRegion, targetAccountId, dataOrder)
    : null;

  // Changes
  const changes = deriveChanges(resource, isCrossAccount, targetRegion);

  // Manual actions (explicit, from the assessment + data migration)
  const manualActions = [...resource.manualActions];
  if (dataMigration) {
    manualActions.push(`Run data migration (${dataMigration.mechanism}) before creating the target resource — see commands`);
  }
  if (isCrossAccount && resource.resourceType === 'AWS::IAM::Role') {
    manualActions.push('IAM role must be recreated in target account with updated trust policies');
  }

  return {
    resourceId: resource.resourceId,
    resourceType: resource.resourceType,
    name: resource.name,
    whatItIs: describeCurrentState(resource, node),
    whatWillBeCreated: describeTargetState(resource, targetRegion, isCrossAccount),
    fidelity,
    fidelityReason,
    changes,
    dataMigration,
    manualActions,
    blockers: resource.blockers.map(b => `[${b.severity}] ${b.blocker}: ${b.description}`),
    dependsOn: resource.dependencies,
  };
}

function describeCurrentState(resource: ResourceAssessment, node: GraphNode | undefined): string {
  const props = node?.properties ?? {};
  const shortType = resource.resourceType.split('::').slice(1).join(' ');
  const details: string[] = [];

  if (props['instanceType']) details.push(`type ${props['instanceType']}`);
  if (props['state']) details.push(String(props['state']));
  if (props['engine']) details.push(`engine ${props['engine']}`);
  if (props['size']) details.push(`${props['size']}GB`);
  if (props['runtime']) details.push(String(props['runtime']));

  return `${shortType} "${resource.name}"${details.length ? ' (' + details.join(', ') + ')' : ''} in ${resource.sourceRegion}`;
}

function describeTargetState(resource: ResourceAssessment, targetRegion: string, isCrossAccount: boolean): string {
  const shortType = resource.resourceType.split('::').slice(1).join(' ');
  const dest = isCrossAccount ? `target account, ${targetRegion}` : targetRegion;
  switch (resource.strategy) {
    case 'RECREATE':
      return `An identical ${shortType} recreated in ${dest} from its faithful CloudFormation`;
    case 'SNAPSHOT_RESTORE':
      return `A ${shortType} in ${dest} restored from a copied snapshot (data preserved)`;
    case 'REPLICATE':
      return `A ${shortType} in ${dest} with data replicated/synced from source`;
    case 'MANUAL':
      return `A ${shortType} in ${dest} — requires manual steps (see actions)`;
    default:
      return `A ${shortType} in ${dest}`;
  }
}

function deriveChanges(resource: ResourceAssessment, isCrossAccount: boolean, targetRegion: string): string[] {
  const changes: string[] = [];
  changes.push(`Resource ID changes (new ${resource.resourceType.split('::').pop()} created in ${targetRegion})`);

  switch (resource.resourceType) {
    case 'AWS::EC2::Instance':
      changes.push('New private IP (target subnet CIDR)', 'AMI must be copied cross-region');
      break;
    case 'AWS::RDS::DBInstance':
    case 'AWS::RDS::DBCluster':
      changes.push('Database endpoint changes — apps must be reconfigured');
      break;
    case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
      changes.push('New DNS name — clients/Route53 must be updated');
      break;
    case 'AWS::S3::Bucket':
      changes.push('Bucket name may need to change (globally unique)');
      break;
  }
  if (isCrossAccount) {
    changes.push('Resource policies/ARNs reference new account ID');
  }
  return changes;
}

/** Render the manifest as a readable markdown document. */
export function renderManifestMarkdown(manifest: MigrationManifest): string {
  const lines: string[] = [];
  lines.push(`# Migration Manifest`);
  lines.push(``);
  lines.push(`**Source:** ${manifest.sourceRegion}  |  **Target:** ${manifest.targetRegion}${manifest.isCrossAccount ? ` (account ${manifest.targetAccountId})` : ''}`);
  lines.push(`**Generated:** ${manifest.createdAt}`);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(``);
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Resources to migrate | ${manifest.summary.total} |`);
  lines.push(`| Full fidelity (IaC Generator) | ${manifest.summary.fullFidelity} |`);
  lines.push(`| Partial (config + manual data) | ${manifest.summary.partialFidelity} |`);
  lines.push(`| Manual only | ${manifest.summary.manualOnly} |`);
  lines.push(`| With data migration | ${manifest.summary.withDataMigration} |`);
  lines.push(`| With blockers | ${manifest.summary.withBlockers} |`);
  lines.push(`| Orphan resources (not migrated) | ${manifest.orphanCount} |`);
  lines.push(``);
  lines.push(`## Migration Cost (one-time + temporary)`);
  lines.push(``);
  lines.push(`- **Data to transfer:** ${manifest.migrationCost.totalDataGB} GB`);
  lines.push(`- **One-time transfer cost:** ~$${manifest.migrationCost.oneTimeTransferUsd}`);
  lines.push(`- **Temporary snapshot storage:** ~$${manifest.migrationCost.temporaryStorageUsdPerMonth}/month (until cutover)`);
  lines.push(``);
  lines.push(`## Resources`);
  lines.push(``);

  for (const e of manifest.entries) {
    lines.push(`### ${e.name} (\`${e.resourceId}\`)`);
    lines.push(``);
    lines.push(`- **What it is:** ${e.whatItIs}`);
    lines.push(`- **Will be created:** ${e.whatWillBeCreated}`);
    lines.push(`- **Fidelity:** ${fidelityIcon(e.fidelity)} ${e.fidelity} — ${e.fidelityReason}`);
    if (e.changes.length) lines.push(`- **Changes:** ${e.changes.join('; ')}`);
    if (e.dependsOn.length) lines.push(`- **Depends on:** ${e.dependsOn.join(', ')}`);
    if (e.dataMigration) {
      lines.push(`- **Data migration (${e.dataMigration.mechanism}):**`);
      for (const cmd of e.dataMigration.commands) {
        lines.push(`  - ${cmd.step}`);
        lines.push(`    \`\`\`\n    ${cmd.command}\n    \`\`\``);
      }
      lines.push(`  - **CFN reference:** ${e.dataMigration.cfnReference}`);
      lines.push(`  - **Cost:** ~$${e.dataMigration.cost.transferUsd} transfer + ~$${e.dataMigration.cost.temporaryStorageUsdPerMonth}/mo storage`);
    }
    if (e.manualActions.length) {
      lines.push(`- **⚠️ Manual actions:**`);
      for (const a of e.manualActions) lines.push(`  - ${a}`);
    }
    if (e.blockers.length) {
      lines.push(`- **🚫 Blockers:**`);
      for (const b of e.blockers) lines.push(`  - ${b}`);
    }
    lines.push(``);
  }

  return lines.join('\n');
}

function fidelityIcon(f: ManifestEntry['fidelity']): string {
  return f === 'FULL' ? '✅' : f === 'PARTIAL' ? '⚠️' : '🔧';
}
