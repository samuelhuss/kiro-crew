import winston from 'winston';

/**
 * Structured logger for the AWS Discovery MCP.
 * NEVER logs secrets, credentials, or sensitive values.
 */
export const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'aws-discovery-mcp' },
  transports: [
    new winston.transports.Console({
      stderrLevels: ['error', 'warn'],
    }),
  ],
});

// ── Typed log events ─────────────────────────────────────────────────────────

export function logScanStarted(region: string): void {
  logger.info('SCAN_STARTED', { event: 'SCAN_STARTED', region });
}

export function logResourceDiscovered(
  region: string,
  resourceType: string,
  resourceId: string
): void {
  logger.debug('RESOURCE_DISCOVERED', {
    event: 'RESOURCE_DISCOVERED',
    region,
    resourceType,
    resourceId,
  });
}

export function logDependencyDiscovered(
  source: string,
  target: string,
  relationship: string
): void {
  logger.debug('DEPENDENCY_DISCOVERED', {
    event: 'DEPENDENCY_DISCOVERED',
    source,
    target,
    relationship,
  });
}

export function logScanCompleted(
  region: string,
  totalResources: number,
  totalRelationships: number,
  durationMs: number
): void {
  logger.info('SCAN_COMPLETED', {
    event: 'SCAN_COMPLETED',
    region,
    totalResources,
    totalRelationships,
    durationMs,
  });
}

export function logScanFailed(region: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  // Only log the message — never the full error object which may contain credentials
  logger.error('SCAN_FAILED', {
    event: 'SCAN_FAILED',
    region,
    error: message,
  });
}
