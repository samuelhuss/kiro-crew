import { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApiServer } from '../../api/server.js';
import { InMemoryGraphRepository } from '../../repositories/graph/in-memory-graph.repository.js';
import { InMemoryAssessmentRepository } from '../../repositories/migration/in-memory-assessment.repository.js';
import { MigrationAnalysisService } from '../../domain/migration/service.js';
import { scenarioMixed, scenarioEmpty } from '../fixtures/migration-scenarios.js';

/**
 * API integration test — spins up the real node:http server against in-memory
 * repositories seeded from a fixture graph. No AWS access.
 */
async function startServer(graph = scenarioMixed()) {
  const graphRepo = new InMemoryGraphRepository();
  await graphRepo.saveGraph(graph);
  const assessmentRepo = new InMemoryAssessmentRepository();
  const service = new MigrationAnalysisService(graphRepo, assessmentRepo);
  const server = createApiServer({ service, assessmentRepo });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return { server, base };
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('Migration API', () => {
  it('POST /migration/analyze returns a completed assessment', async () => {
    const { server, base } = await startServer();
    try {
      const res = await fetch(`${base}/migration/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceRegion: 'us-east-1', targetRegion: 'sa-east-1' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('COMPLETED');
      expect(body.assessmentId).toMatch(/^assessment-/);
      expect(body.summary.totalResources).toBeGreaterThan(0);
      expect(Array.isArray(body.phases)).toBe(true);
      expect(Array.isArray(body.blockers)).toBe(true);
    } finally {
      await stop(server);
    }
  });

  it('GET /migration/assessments/:id returns the stored assessment', async () => {
    const { server, base } = await startServer();
    try {
      const created = await (
        await fetch(`${base}/migration/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceRegion: 'us-east-1', targetRegion: 'sa-east-1' }),
        })
      ).json();

      const res = await fetch(`${base}/migration/assessments/${created.assessmentId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.assessmentId).toBe(created.assessmentId);
    } finally {
      await stop(server);
    }
  });

  it('GET /migration/assessments/:id/resources/:resourceId returns one resource', async () => {
    const { server, base } = await startServer();
    try {
      const created = await (
        await fetch(`${base}/migration/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceRegion: 'us-east-1', targetRegion: 'sa-east-1' }),
        })
      ).json();

      const res = await fetch(`${base}/migration/assessments/${created.assessmentId}/resources/rds-1`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.resourceId).toBe('rds-1');
      expect(body.strategy).toBe('SNAPSHOT_RESTORE');
    } finally {
      await stop(server);
    }
  });

  it('returns 404 for an unknown assessment', async () => {
    const { server, base } = await startServer();
    try {
      const res = await fetch(`${base}/migration/assessments/does-not-exist`);
      expect(res.status).toBe(404);
    } finally {
      await stop(server);
    }
  });

  it('returns 400 for an invalid analyze body', async () => {
    const { server, base } = await startServer();
    try {
      const res = await fetch(`${base}/migration/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceRegion: 'us-east-1' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await stop(server);
    }
  });

  it('returns 409 when analyzing an empty graph', async () => {
    const { server, base } = await startServer(scenarioEmpty());
    try {
      const res = await fetch(`${base}/migration/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceRegion: 'us-east-1', targetRegion: 'sa-east-1' }),
      });
      expect(res.status).toBe(409);
    } finally {
      await stop(server);
    }
  });
});
