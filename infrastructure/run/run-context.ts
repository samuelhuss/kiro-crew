import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Run context — every execution of the pipeline writes its artefacts into ONE
 * folder named after the project being migrated:
 *
 *   <runsRoot>/<project>/<runId>/
 *     run.json                     metadata (project, accounts, regions, timestamps)
 *     inventory/inventory.json     discovery output
 *     inventory/total-inventory.json
 *     graph/graph.json             dependency graph
 *     cfn/*.yaml                   generated CloudFormation
 *     docs/migration-manifest.md   human-readable plan
 *
 * The four MCP servers are SEPARATE processes, so the active run is shared
 * through a pointer file at `<runsRoot>/current-run.json`. Discovery creates
 * the run; graph / analysis / planner follow the pointer.
 *
 * Path resolution order for any artefact directory:
 *   1. explicit argument (a tool parameter)
 *   2. matching env var (INVENTORY_DIR / TOTAL_INVENTORY_DIR / GRAPH_DIR / CFN_DIR / DOCS_DIR)
 *   3. the active run folder
 *   4. legacy `<repoRoot>/data` fallback (only when no run has ever started)
 */

export type ArtifactKind = 'inventory' | 'graph' | 'cfn' | 'docs' | 'logs';

export interface RunMetadata {
  project: string;
  runId: string;
  runDir: string;
  sourceAccountId: string;
  sourceRegion: string;
  targetAccountId: string;
  targetRegion: string;
  createdAt: string;
  updatedAt: string;
}

export interface StartRunInput {
  project: string;
  sourceAccountId?: string;
  sourceRegion?: string;
  targetAccountId?: string;
  targetRegion?: string;
}

const POINTER_FILE = 'current-run.json';

const LEGACY_DIRS: Record<ArtifactKind, string> = {
  inventory: join('data', 'inventory'),
  graph: join('data', 'graph'),
  cfn: join('docs', 'cfn'),
  docs: 'docs',
  logs: join('data', 'logs'),
};

const ENV_KEYS: Record<ArtifactKind, readonly string[]> = {
  inventory: ['INVENTORY_DIR', 'KUZU_INVENTORY_DIR', 'KUZU_DATA_DIR'],
  graph: ['GRAPH_DIR', 'KUZU_GRAPH_DIR', 'KUZU_DATA_DIR'],
  cfn: ['CFN_DIR'],
  docs: ['DOCS_DIR'],
  logs: ['LOGS_DIR'],
};

/** Walk up from this module until a package.json is found (works from src/ and dist/). */
function findRepoRoot(): string {
  if (process.env['MIGRATION_PROJECT_ROOT']) {
    return resolve(process.env['MIGRATION_PROJECT_ROOT']);
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function getRepoRoot(): string {
  return findRepoRoot();
}

/** Root that holds every run folder. Override with MIGRATION_RUNS_DIR. */
export function getRunsRoot(): string {
  const configured = process.env['MIGRATION_RUNS_DIR'];
  if (configured) return isAbsolute(configured) ? configured : resolve(getRepoRoot(), configured);
  return join(getRepoRoot(), 'runs');
}

/** Filesystem-safe project/run identifier. */
export function slugify(value: string): string {
  const slug = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  return slug || 'unnamed';
}

/** `2026-09-22T14-30-05Z-123456789012-us-east-1` */
export function buildRunId(sourceAccountId: string, sourceRegion: string, now = new Date()): string {
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return [timestamp, slugify(sourceAccountId || 'unknown-account'), slugify(sourceRegion || 'unknown-region')].join('-');
}

function pointerPath(): string {
  return join(getRunsRoot(), POINTER_FILE);
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, filePath);
}

function readRunFile(runDir: string): RunMetadata | null {
  try {
    const parsed = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as RunMetadata;
    return { ...parsed, runDir };
  } catch {
    return null;
  }
}

/**
 * Create the folder for a new execution and make it the active run.
 * Re-running with the same project + runId is idempotent.
 */
export function startRun(input: StartRunInput): RunMetadata {
  const project = slugify(input.project);
  const sourceAccountId = input.sourceAccountId ?? '';
  const sourceRegion = input.sourceRegion ?? '';
  const runId = buildRunId(sourceAccountId, sourceRegion);
  const runDir = join(getRunsRoot(), project, runId);
  const now = new Date().toISOString();

  for (const kind of Object.keys(LEGACY_DIRS) as ArtifactKind[]) {
    mkdirSync(join(runDir, kind), { recursive: true });
  }

  const metadata: RunMetadata = {
    project,
    runId,
    runDir,
    sourceAccountId,
    sourceRegion,
    targetAccountId: input.targetAccountId ?? '',
    targetRegion: input.targetRegion ?? '',
    createdAt: now,
    updatedAt: now,
  };

  writeJsonAtomic(join(runDir, 'run.json'), metadata);
  writeJsonAtomic(pointerPath(), { project, runId, runDir, updatedAt: now });
  return metadata;
}

/** The run every MCP server in this pipeline is currently writing to. */
export function getCurrentRun(): RunMetadata | null {
  try {
    const pointer = JSON.parse(readFileSync(pointerPath(), 'utf8')) as { runDir?: string };
    if (!pointer.runDir || !existsSync(pointer.runDir)) return null;
    return readRunFile(pointer.runDir);
  } catch {
    return null;
  }
}

/** Merge extra facts (target account/region) into the active run's run.json. */
export function updateCurrentRun(patch: Partial<StartRunInput>): RunMetadata | null {
  const current = getCurrentRun();
  if (!current) return null;
  const updated: RunMetadata = {
    ...current,
    sourceAccountId: patch.sourceAccountId ?? current.sourceAccountId,
    sourceRegion: patch.sourceRegion ?? current.sourceRegion,
    targetAccountId: patch.targetAccountId ?? current.targetAccountId,
    targetRegion: patch.targetRegion ?? current.targetRegion,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(join(current.runDir, 'run.json'), updated);
  return updated;
}

/** All runs on disk, newest first. */
export function listRuns(): RunMetadata[] {
  const root = getRunsRoot();
  if (!existsSync(root)) return [];
  const runs: RunMetadata[] = [];
  for (const project of readdirSync(root)) {
    const projectDir = join(root, project);
    if (!statSync(projectDir).isDirectory()) continue;
    for (const runId of readdirSync(projectDir)) {
      const run = readRunFile(join(projectDir, runId));
      if (run) runs.push(run);
    }
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Point the pipeline at an existing run (resume / inspect a past execution). */
export function useRun(runId: string): RunMetadata {
  const match = listRuns().find((r) => r.runId === runId || r.runDir === runId);
  if (!match) throw new Error(`Run "${runId}" not found under ${getRunsRoot()}`);
  writeJsonAtomic(pointerPath(), {
    project: match.project,
    runId: match.runId,
    runDir: match.runDir,
    updatedAt: new Date().toISOString(),
  });
  return match;
}

/** Directory an artefact of the given kind must be written to. */
export function resolveArtifactDir(kind: ArtifactKind, explicit?: string): string {
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(getRepoRoot(), explicit);

  for (const key of ENV_KEYS[kind]) {
    const value = process.env[key];
    if (value) return isAbsolute(value) ? value : resolve(getRepoRoot(), value);
  }

  const run = getCurrentRun();
  if (run) return join(run.runDir, kind);

  return join(getRepoRoot(), LEGACY_DIRS[kind]);
}

/** Full path for a named artefact, with its directory created. */
export function artifactPath(kind: ArtifactKind, filename: string, explicitDir?: string): string {
  const dir = resolveArtifactDir(kind, explicitDir);
  mkdirSync(dir, { recursive: true });
  return join(dir, filename);
}
