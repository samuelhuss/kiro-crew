#!/usr/bin/env node
/**
 * Cross-platform team bootstrap for the migration agent workspace.
 *
 * Usage:
 *   npm run bootstrap
 *   npm run bootstrap -- --dry-run
 *   npm run bootstrap -- --check-only
 *   npm run bootstrap -- --skip-agents
 *   npm run bootstrap -- --out <agents-dir>
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

const hasFlag = (flag) => args.includes(flag);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const dryRun = hasFlag('--dry-run');
const checkOnly = hasFlag('--check-only');
const skipInstall = hasFlag('--skip-install') || checkOnly;
const skipBuild = hasFlag('--skip-build') || checkOnly;
const skipAgents = hasFlag('--skip-agents') || checkOnly;
const skipEnv = hasFlag('--skip-env');
const agentsOutDir = valueAfter('--out');

const requiredTools = [
  { name: 'node', command: 'node', args: ['--version'], minimum: '20.11.0' },
  { name: 'npm', command: 'npm', args: ['--version'], minimum: '10.0.0' },
  {
    name: 'python',
    minimum: '3.10.0',
    candidates: [
      { command: 'python', args: ['--version'] },
      { command: 'python3', args: ['--version'] },
      { command: 'py', args: ['-3', '--version'] }
    ]
  },
  { name: 'uv', command: 'uv', args: ['--version'], minimum: '0.8.12' },
  { name: 'aws', command: 'aws', args: ['--version'], minimum: '2.0.0' }
];

const optionalTools = [
  { name: 'cfn-lint', command: 'cfn-lint', args: ['--version'], note: 'optional, used by validate_templates' }
];

function run(command, commandArgs, options = {}) {
  const printable = [command, ...commandArgs].join(' ');
  if (dryRun && !options.allowInDryRun) {
    console.log(`[dry-run] ${printable}`);
    return;
  }

  console.log(`$ ${printable}`);
  const result = spawnSync(command, commandArgs, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32' && !command.includes('\\') && !command.includes('/'),
    ...options.spawnOptions
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function capture(command, commandArgs) {
  return spawnSync(command, commandArgs, {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32'
  });
}

function parseVersion(output) {
  const match = output.match(/\d+(?:\.\d+){1,3}/);
  return match ? match[0] : undefined;
}

function compareVersions(actual, minimum) {
  const actualParts = actual.split('.').map(Number);
  const minimumParts = minimum.split('.').map(Number);
  const length = Math.max(actualParts.length, minimumParts.length);
  for (let index = 0; index < length; index += 1) {
    const actualPart = actualParts[index] ?? 0;
    const minimumPart = minimumParts[index] ?? 0;
    if (actualPart > minimumPart) return 1;
    if (actualPart < minimumPart) return -1;
  }
  return 0;
}

function checkTool(tool, required) {
  const candidates = tool.candidates ?? [{ command: tool.command, args: tool.args }];
  let result;
  let candidate;
  for (const current of candidates) {
    const currentResult = capture(current.command, current.args);
    if (currentResult.status === 0) {
      result = currentResult;
      candidate = current;
      break;
    }
    result = currentResult;
    candidate = current;
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0) {
    const level = required ? 'missing' : 'not found';
    console.log(`- ${tool.name}: ${level}${tool.note ? ` (${tool.note})` : ''}`);
    return !required;
  }

  const version = parseVersion(output);
  if (tool.minimum && version && compareVersions(version, tool.minimum) < 0) {
    console.log(`- ${tool.name}: ${version} found, ${tool.minimum}+ required`);
    return false;
  }

  const commandLabel = candidate.command === tool.name ? '' : ` via ${candidate.command}`;
  console.log(`- ${tool.name}: ${version ?? output.split(/\s+/)[0]} ok${commandLabel}${tool.note ? ` (${tool.note})` : ''}`);
  return true;
}

console.log(`Project root: ${projectRoot}`);
console.log('\nChecking prerequisites...');

let ok = true;
for (const tool of requiredTools) {
  ok = checkTool(tool, true) && ok;
}
for (const tool of optionalTools) {
  checkTool(tool, false);
}

if (!ok) {
  console.error('\nInstall or upgrade the missing tools, then run this command again. See docs/TEAM_SETUP.md.');
  process.exit(1);
}

if (!existsSync(join(projectRoot, 'package-lock.json'))) {
  console.error('\npackage-lock.json not found; npm ci cannot produce a reproducible install.');
  process.exit(1);
}

if (!skipEnv) {
  const envArgs = [join(projectRoot, 'scripts', 'configure-env.mjs')];
  if (dryRun) envArgs.push('--dry-run');
  if (checkOnly) envArgs.push('--check');
  run(process.execPath, envArgs, { allowInDryRun: true });
}

if (!skipInstall) {
  run('npm', ['ci']);
}

if (!skipBuild) {
  run('npm', ['run', 'build']);
}

if (!skipAgents) {
  const installArgs = [join(projectRoot, 'scripts', 'install-agents.mjs')];
  if (dryRun) installArgs.push('--dry-run');
  if (agentsOutDir) installArgs.push('--out', agentsOutDir);
  run(process.execPath, installArgs, { allowInDryRun: true });
}

console.log('\nBootstrap complete. Open the workspace in VS Code/Cursor, start the MCP servers, and select aws-migration-orchestrator.');