import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startRun,
  getCurrentRun,
  updateCurrentRun,
  listRuns,
  useRun,
  resolveArtifactDir,
  artifactPath,
  buildRunId,
  slugify,
} from '../../infrastructure/run/run-context.js';

describe('run-context', () => {
  let runsRoot: string;
  const TOUCHED = ['MIGRATION_RUNS_DIR', 'INVENTORY_DIR', 'GRAPH_DIR', 'KUZU_DATA_DIR'] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of TOUCHED) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    runsRoot = mkdtempSync(join(tmpdir(), 'runs-'));
    process.env['MIGRATION_RUNS_DIR'] = runsRoot;
  });

  afterEach(() => {
    for (const key of TOUCHED) {
      const previous = saved.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    rmSync(runsRoot, { recursive: true, force: true });
  });

  it('slugifies project names into safe folder names', () => {
    expect(slugify('Migração Portal Cliente')).toBe('migracao-portal-cliente');
    expect(slugify('!!!')).toBe('unnamed');
  });

  it('builds a runId from timestamp, account and region', () => {
    const runId = buildRunId('123456789012', 'us-east-1', new Date('2026-09-22T14:30:05.123Z'));
    expect(runId).toBe('2026-09-22T14-30-05Z-123456789012-us-east-1');
  });

  it('creates one folder per execution with all artifact subdirectories', () => {
    const run = startRun({ project: 'Portal Cliente', sourceAccountId: '111122223333', sourceRegion: 'us-east-1' });

    expect(run.runDir).toBe(join(runsRoot, 'portal-cliente', run.runId));
    for (const kind of ['inventory', 'graph', 'cfn', 'docs', 'logs']) {
      expect(existsSync(join(run.runDir, kind))).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(run.runDir, 'run.json'), 'utf8')).project).toBe('portal-cliente');
  });

  it('shares the active run across processes through the pointer file', () => {
    const run = startRun({ project: 'app', sourceAccountId: '1', sourceRegion: 'sa-east-1' });
    expect(getCurrentRun()?.runDir).toBe(run.runDir);
  });

  it('resolves artifact paths inside the active run', () => {
    const run = startRun({ project: 'app', sourceAccountId: '1', sourceRegion: 'sa-east-1' });

    expect(resolveArtifactDir('inventory')).toBe(join(run.runDir, 'inventory'));
    expect(resolveArtifactDir('graph')).toBe(join(run.runDir, 'graph'));
    expect(artifactPath('docs', 'migration-manifest.md')).toBe(join(run.runDir, 'docs', 'migration-manifest.md'));
  });

  it('lets an explicit directory and then an env var override the run folder', () => {
    startRun({ project: 'app', sourceAccountId: '1', sourceRegion: 'sa-east-1' });

    process.env['GRAPH_DIR'] = join(runsRoot, 'pinned-graph');
    expect(resolveArtifactDir('graph')).toBe(join(runsRoot, 'pinned-graph'));
    expect(resolveArtifactDir('graph', join(runsRoot, 'explicit'))).toBe(join(runsRoot, 'explicit'));
  });

  it('merges target account/region into the active run', () => {
    startRun({ project: 'app', sourceAccountId: '1', sourceRegion: 'sa-east-1' });
    updateCurrentRun({ targetAccountId: '999', targetRegion: 'us-east-2' });

    expect(getCurrentRun()).toMatchObject({ targetAccountId: '999', targetRegion: 'us-east-2' });
  });

  it('lists past runs and can switch back to one', () => {
    const first = startRun({ project: 'app-a', sourceAccountId: '1', sourceRegion: 'us-east-1' });
    const second = startRun({ project: 'app-b', sourceAccountId: '2', sourceRegion: 'us-east-2' });

    expect(listRuns().map((r) => r.project).sort()).toEqual(['app-a', 'app-b']);
    expect(getCurrentRun()?.runDir).toBe(second.runDir);

    useRun(first.runId);
    expect(getCurrentRun()?.runDir).toBe(first.runDir);
  });
});
