import type { InfrastructureGraphRepository } from '../../repositories/graph/graph.repository.js';
import type { MigrationAssessmentRepository } from '../../repositories/migration/assessment.repository.js';
import { MigrationAnalyzer } from './analyzer.js';
import { logAnalysisFailed } from './events.js';
import type { MigrationAssessment } from './assessment.js';

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
   */
  async analyze(sourceRegion: string, targetRegion: string): Promise<MigrationAssessment> {
    const graph = await this.graphRepo.getGraph();
    try {
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
