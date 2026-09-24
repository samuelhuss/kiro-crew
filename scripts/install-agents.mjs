#!/usr/bin/env node
/**
 * Render agents/<name>/agent.json into the Kiro agents folder, replacing the
 * {{PROJECT_ROOT}} placeholder with this repository's absolute path.
 *
 * Usage:
 *   npm run agents:install                 # installs into ~/.kiro/agents
 *   npm run agents:install -- --out <dir>  # installs somewhere else
 *   npm run agents:install -- --dry-run
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = join(projectRoot, 'agents');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const outIndex = args.indexOf('--out');
const outDir =
  outIndex >= 0 && args[outIndex + 1]
    ? resolve(args[outIndex + 1])
    : join(homedir(), '.kiro', 'agents');

if (!existsSync(join(projectRoot, 'dist', 'mcp', 'aws-discovery', 'src', 'index.js'))) {
  console.warn('warning: dist/ not found — run `npm run build` before starting the agents.\n');
}

// JSON.stringify escaping keeps Windows backslashes valid inside the rendered JSON
const rootForJson = projectRoot.replace(/\\/g, '/');

let installed = 0;
for (const name of readdirSync(agentsDir)) {
  const source = join(agentsDir, name, 'agent.json');
  if (!existsSync(source)) continue;

  const rendered = readFileSync(source, 'utf8').replaceAll('{{PROJECT_ROOT}}', rootForJson);
  JSON.parse(rendered); // fail fast on a malformed template

  const target = join(outDir, `${name}.json`);
  console.log(`${dryRun ? '[dry-run] ' : ''}${source} -> ${target}`);
  if (!dryRun) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(target, rendered, 'utf8');
  }
  installed += 1;
}

console.log(`\n${installed} agent(s) ${dryRun ? 'would be ' : ''}installed. PROJECT_ROOT = ${projectRoot}`);

const vscodeMcpPath = join(projectRoot, '.vscode', 'mcp.json');
const kiroSettingsDir = join(projectRoot, '.kiro', 'settings');
const kiroMcpPath = join(kiroSettingsDir, 'mcp.json');

if (existsSync(vscodeMcpPath)) {
  const vscodeMcpRaw = readFileSync(vscodeMcpPath, 'utf8');
  const mcpConfigRendered = vscodeMcpRaw.replaceAll('${workspaceFolder}', rootForJson);
  const parsed = JSON.parse(mcpConfigRendered);
  
  const kiroMcpConfig = {
    mcpServers: parsed.servers || {}
  };

  console.log(`${dryRun ? '[dry-run] ' : ''}Generating local Kiro MCP config -> ${kiroMcpPath}`);
  if (!dryRun) {
    mkdirSync(kiroSettingsDir, { recursive: true });
    writeFileSync(kiroMcpPath, JSON.stringify(kiroMcpConfig, null, 2), 'utf8');
    
    // Create the runs directory because aws-api-mcp-server crashes if AWS_API_MCP_WORKING_DIR doesn't exist
    const runsDir = join(projectRoot, 'runs');
    if (!existsSync(runsDir)) {
      mkdirSync(runsDir, { recursive: true });
    }
  }
}
