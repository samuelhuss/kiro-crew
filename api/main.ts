import { createApiServer } from './server.js';
import { scanRegion } from '../infrastructure/aws/scanner.js';
import { buildGraph } from '../domain/graph/builder.js';
import { InMemoryGraphRepository } from '../repositories/graph/in-memory-graph.repository.js';
import { InMemoryAssessmentRepository } from '../repositories/migration/in-memory-assessment.repository.js';
import { MigrationAnalysisService } from '../domain/migration/service.js';
import { logger } from '../infrastructure/aws/logger.js';

/**
 * API bootstrap.
 *
 * Wires the in-memory repositories and the migration service, optionally
 * pre-builds the graph for a region (SCAN_REGION env), and starts the HTTP API.
 *
 *   POST /migration/analyze
 *   GET  /migration/assessments/:id
 *   GET  /migration/assessments/:id/resources/:resourceId
 *
 * READ-ONLY with respect to AWS.
 */
async function main(): Promise<void> {
  const graphRepo = new InMemoryGraphRepository();
  const assessmentRepo = new InMemoryAssessmentRepository();
  const service = new MigrationAnalysisService(graphRepo, assessmentRepo);

  // Optional: pre-build the graph so POST /migration/analyze works immediately.
  const preScanRegion = process.env['SCAN_REGION'];
  if (preScanRegion) {
    logger.info('Pre-building infrastructure graph', { region: preScanRegion });
    const inventory = await scanRegion(preScanRegion);
    await graphRepo.saveGraph(buildGraph(inventory));
  }

  const server = createApiServer({ service, assessmentRepo });
  const port = Number(process.env['PORT'] ?? 3000);
  const host = process.env['HOST'] ?? '127.0.0.1';
  server.listen(port, host, () => {
    logger.info('migration API listening', { host, port, preScanRegion: preScanRegion ?? null });
  });

  const shutdown = (): void => {
    logger.info('migration API shutting down');
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error('Fatal API startup error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
