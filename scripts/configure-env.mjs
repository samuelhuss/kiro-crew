#!/usr/bin/env node
/** Create/check the local .env used by MCP startup wrappers. */
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile, writeEnvFile } from './env-file.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(projectRoot, '.env');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const checkOnly = args.includes('--check');

const env = parseEnvFile(envPath);

function hasSource(envValues) {
  return Boolean(
    (envValues['AWS_PROFILE'] || envValues['MIGRATION_SOURCE_PROFILE']) && envValues['AWS_REGION']
  ) || Boolean(envValues['AWS_ACCESS_KEY_ID'] && envValues['AWS_SECRET_ACCESS_KEY'] && envValues['AWS_REGION']);
}

function hasTarget(envValues) {
  return Boolean(
    (envValues['AWS_PROFILE_TARGET'] || envValues['MIGRATION_TARGET_PROFILE']) && envValues['AWS_REGION_TARGET']
  ) || Boolean(envValues['AWS_ACCESS_KEY_ID_TARGET'] && envValues['AWS_SECRET_ACCESS_KEY_TARGET'] && envValues['AWS_REGION_TARGET']);
}

if (checkOnly || dryRun) {
  console.log(`.env: ${existsSync(envPath) ? envPath : 'not found'}`);
  console.log(`- source: ${hasSource(env) ? 'configured' : 'missing AWS_PROFILE/AWS_REGION or raw source credentials'}`);
  console.log(`- target: ${hasTarget(env) ? 'configured' : 'not configured yet (required for cross-account)'}`);
  console.log(`- outposts target: ${env['TARGET_OUTPOST_ARN'] ? 'target Outpost ARN configured' : 'not configured (optional; useful for Outposts targets)'}`);
  if (checkOnly && !hasSource(env)) process.exit(1);
  process.exit(0);
}

if (!process.stdin.isTTY) {
  if (!hasSource(env)) {
    console.error('.env is missing source configuration. Run `npm run env:configure` in an interactive terminal.');
    process.exit(1);
  }
  process.exit(0);
}

const rl = createInterface({ input, output });

async function ask(key, question, fallback = '') {
  const current = env[key] ?? fallback;
  const suffix = current ? ` [${current}]` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  env[key] = answer || current;
}

console.log('Configuring local .env for the migration agent. Use profile names here; do not paste secrets in this prompt.');
await ask('AWS_PROFILE', 'Source AWS profile', 'migration-source');
await ask('AWS_REGION', 'Source AWS region', 'us-east-1');

const configureTargetDefault = hasTarget(env) ? 'y' : 'n';
const configureTarget = (await rl.question(`Configure target account now? [${configureTargetDefault}]: `)).trim().toLowerCase() || configureTargetDefault;
if (configureTarget.startsWith('y')) {
  await ask('AWS_PROFILE_TARGET', 'Target AWS profile', 'migration-target');
  await ask('AWS_REGION_TARGET', 'Target AWS region', env['AWS_REGION'] ?? 'us-east-1');
  await ask('MIGRATION_TARGET_ACCOUNT_ID', 'Target AWS account id (optional)', env['MIGRATION_TARGET_ACCOUNT_ID'] ?? '');
}

const configureOutpostsDefault = env['TARGET_OUTPOST_ARN'] || env['OUTPOSTS_CORE_ACCOUNT_ID'] ? 'y' : 'n';
const configureOutposts = (await rl.question(`Configure target Outposts metadata now? [${configureOutpostsDefault}]: `)).trim().toLowerCase() || configureOutpostsDefault;
if (configureOutposts.startsWith('y')) {
  await ask('OUTPOSTS_CORE_ACCOUNT_ID', 'Outposts owner/core account id (metadata only, optional)', env['OUTPOSTS_CORE_ACCOUNT_ID'] ?? '');
  await ask('TARGET_OUTPOST_ARN', 'Target Outpost ARN (optional)', env['TARGET_OUTPOST_ARN'] ?? '');
}

rl.close();

writeEnvFile(envPath, env);
console.log(`Wrote ${envPath}`);