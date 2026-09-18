import type { InfrastructureGraphRepository } from '../../repositories/graph/graph.repository.js';
import type { MigrationAssessmentRepository } from '../../repositories/migration/assessment.repository.js';
import { MigrationAnalyzer } from './analyzer.js';
import { mergeRadarItemsIntoGraph } from './radar-integration.js';
import { logAnalysisFailed } from './events.js';
import type { MigrationAssessment } from './assessment.js';
import type { ClassifiedResourceItem } from '../resources/total-inventory.js';
import { logger } from '../../infrastructure/aws/logger.js';

/**
 * MigrationAnalysisService — orchestrates a migration analysis run.
 *
 *   Infrastructure Graph (repo) → MigrationAnalyzer → MigrationAssessment (repo)
 *
 * Shared by the HTTP API and the MCP agent so the behavior is identical.
 * READ-ONLY: reads the graph, writes only the assessment record. No AWS changes.
 */
export class MigrationAnalysisService {
  private readonly analyzer = new MigrationAnalyzer();

  constructor(
    private readonly graphRepo: InfrastructureGraphRepository,
    private readonly assessmentRepo: MigrationAssessmentRepository
  ) {}

  /**
   * Analyze the currently loaded infrastructure graph for a source→target move.
   * Throws if the graph is empty (nothing to analyze) so the caller can respond
   * clearly rather than returning a meaningless empty assessment.
   *
   * When `radarItems` is provided (from a prior scan_total_inventory run),
   * eligible items — AWS Config already has their config, not NOISE, and a
   * migration rule exists for the type — are merged into the graph FIRST, as
   * isolated nodes, and the enriched graph is persisted back to the repo so
   * downstream steps (manifest, faithful CFN) see the same picture. Ineligible
   * items are never silently dropped; see radar-integration.ts's `skipped`.
   */
  async analyze(
    sourceRegion: string,
    targetRegion: string,
    radarItems: ClassifiedResourceItem[] = [],
    radarAccountId?: string
  ): Promise<MigrationAssessment> {
    let graph = await this.graphRepo.getGraph();
    try {
      if (radarItems.length > 0) {
        const accountId = radarAccountId ?? graph.metadata.accountIds[0] ?? 'unknown';
        const merge = mergeRadarItemsIntoGraph(graph, radarItems, accountId);
        if (merge.mergedNodeIds.length > 0) {
          graph = merge.graph;
          await this.graphRepo.saveGraph(graph);
        }
        logger.info('Radar items merged into graph', {
          merged: merge.mergedNodeIds.length,
          skipped: merge.skipped.length,
        });
      }

      if (graph.nodes.length === 0) {
        throw new Error(
          'Infrastructure graph is empty. Build the graph (scan a region) before running a migration analysis.'
        );
      }
      const assessment = this.analyzer.analyze(graph, sourceRegion, targetRegion);
      await this.assessmentRepo.saveAssessment(assessment);
      return assessment;
    } catch (err) {
      logAnalysisFailed(
        { assessmentId: 'n/a', sourceRegion, targetRegion },
        err
      );
      throw err;
    }
  }
}
