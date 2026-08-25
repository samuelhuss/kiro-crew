import { logger } from '../../infrastructure/aws/logger.js';

/**
 * Migration analysis observability events.
 * NEVER logs secrets, credentials, or secret values — only ids/types/regions.
 */
export interface MigrationEventContext {
  assessmentId: string;
  sourceRegion: string;
  targetRegion: string;
  resourceId?: string;
  resourceType?: string;
}

function emit(event: string, ctx: MigrationEventContext, extra: Record<string, unknown> = {}): void {
  logger.info(event, { event, ...ctx, ...extra });
}

export function logAnalysisStarted(ctx: MigrationEventContext, totalResources: number): void {
  emit('MIGRATION_ANALYSIS_STARTED', ctx, { totalResources });
}

export function logResourceAnalysisStarted(ctx: MigrationEventContext): void {
  logger.debug('RESOURCE_ANALYSIS_STARTED', { event: 'RESOURCE_ANALYSIS_STARTED', ...ctx });
}

export function logResourceAnalysisCompleted(
  ctx: MigrationEventContext,
  strategy: string,
  status: string,
  risk: string
): void {
  logger.debug('RESOURCE_ANALYSIS_COMPLETED', {
    event: 'RESOURCE_ANALYSIS_COMPLETED',
    ...ctx,
    strategy,
    status,
    risk,
  });
}

export function logMigrationBlockerFound(ctx: MigrationEventContext, blocker: string, severity: string): void {
  emit('MIGRATION_BLOCKER_FOUND', ctx, { blocker, severity });
}

export function logHighRiskResourceFound(ctx: MigrationEventContext, risk: string): void {
  emit('HIGH_RISK_RESOURCE_FOUND', ctx, { risk });
}

export function logAnalysisCompleted(
  ctx: MigrationEventContext,
  summary: { totalResources: number; risk: string }
): void {
  emit('MIGRATION_ANALYSIS_COMPLETED', ctx, { ...summary });
}

export function logAnalysisFailed(ctx: MigrationEventContext, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  logger.error('MIGRATION_ANALYSIS_FAILED', { event: 'MIGRATION_ANALYSIS_FAILED', ...ctx, error: message });
}
