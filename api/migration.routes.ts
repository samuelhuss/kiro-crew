import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { MigrationAnalysisService } from '../domain/migration/service.js';
import type { MigrationAssessmentRepository } from '../repositories/migration/assessment.repository.js';
import type { MigrationAssessment } from '../domain/migration/assessment.js';

/**
 * Migration API routes (native http, no framework dependency).
 *
 *   POST /migration/analyze
 *   GET  /migration/assessments/:id
 *   GET  /migration/assessments/:id/resources/:resourceId
 *
 * READ-ONLY with respect to AWS. The only write is persisting the assessment
 * record in the repository.
 */

const AnalyzeBody = z.object({
  sourceRegion: z.string().min(1),
  targetRegion: z.string().min(1),
});

function summarizeResponse(assessment: MigrationAssessment) {
  return {
    assessmentId: assessment.assessmentId,
    status: 'COMPLETED' as const,
    sourceRegion: assessment.sourceRegion,
    targetRegion: assessment.targetRegion,
    summary: assessment.summary,
    resources: assessment.resources,
    phases: assessment.phases,
    blockers: assessment.blockers,
    warnings: assessment.warnings,
    highRiskResources: assessment.highRiskResources,
    manualActions: assessment.manualActions,
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

export interface MigrationRouterDeps {
  service: MigrationAnalysisService;
  assessmentRepo: MigrationAssessmentRepository;
}

/**
 * Returns a request handler. Resolves true if the request matched a migration
 * route (handled), false otherwise so a parent server can 404.
 */
export function createMigrationRouter(deps: MigrationRouterDeps) {
  const { service, assessmentRepo } = deps;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    // POST /migration/analyze
    if (method === 'POST' && path === '/migration/analyze') {
      try {
        const parsed = AnalyzeBody.safeParse(await readJsonBody(req));
        if (!parsed.success) {
          send(res, 400, { status: 'FAILED', error: 'Invalid body. Expected { sourceRegion, targetRegion }.' });
          return true;
        }
        const assessment = await service.analyze(parsed.data.sourceRegion, parsed.data.targetRegion);
        send(res, 200, summarizeResponse(assessment));
      } catch (err) {
        send(res, 409, { status: 'FAILED', error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    // GET /migration/assessments/:id/resources/:resourceId
    const resourceMatch = path.match(/^\/migration\/assessments\/([^/]+)\/resources\/(.+)$/);
    if (method === 'GET' && resourceMatch) {
      const [, id, resourceId] = resourceMatch;
      const resource = await assessmentRepo.getResourceAssessment(
        decodeURIComponent(id!),
        decodeURIComponent(resourceId!)
      );
      if (!resource) {
        send(res, 404, { error: `Resource "${resourceId}" not found in assessment "${id}".` });
        return true;
      }
      send(res, 200, resource);
      return true;
    }

    // GET /migration/assessments/:id
    const assessmentMatch = path.match(/^\/migration\/assessments\/([^/]+)$/);
    if (method === 'GET' && assessmentMatch) {
      const [, id] = assessmentMatch;
      const assessment = await assessmentRepo.getAssessment(decodeURIComponent(id!));
      if (!assessment) {
        send(res, 404, { error: `Assessment "${id}" not found.` });
        return true;
      }
      send(res, 200, summarizeResponse(assessment));
      return true;
    }

    return false;
  };
}
