#!/usr/bin/env node
/** Load .env, prepare repo-local AWS profiles when raw credentials are present, then exec a command. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { parseEnvFile } from './env-file.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = parseEnvFile(join(projectRoot, '.env'));
const childEnv = { ...process.env, ...envFile };

if (childEnv['MIGRATION_SOURCE_PROFILE'] && !childEnv['AWS_PROFILE']) {
  childEnv['AWS_PROFILE'] = childEnv['MIGRATION_SOURCE_PROFILE'];
}
if (childEnv['MIGRATION_TARGET_PROFILE'] && !childEnv['AWS_PROFILE_TARGET']) {
  childEnv['AWS_PROFILE_TARGET'] = childEnv['MIGRATION_TARGET_PROFILE'];
}

const sourceHasRawCredentials = childEnv['AWS_ACCESS_KEY_ID'] && childEnv['AWS_SECRET_ACCESS_KEY'];
const targetHasRawCredentials = childEnv['AWS_ACCESS_KEY_ID_TARGET'] && childEnv['AWS_SECRET_ACCESS_KEY_TARGET'];

function readIfExists(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

function stripProfiles(content, profileNames) {
  const names = new Set(profileNames);
  const kept = [];
  let skipping = false;

  for (const line of content.split(/\r?\n/)) {
    const section = line.trim().match(/^\[(?:profile\s+)?([^\]]+)\]$/);
    if (section) {
      skipping = names.has(section[1]);
    }
    if (!skipping) kept.push(line);
  }

  return kept.join('\n').trim();
}

if (sourceHasRawCredentials || targetHasRawCredentials) {
  const awsDir = join(projectRoot, '.aws');
  const credentialsPath = join(awsDir, 'credentials');
  const configPath = join(awsDir, 'config');
  mkdirSync(awsDir, { recursive: true });

  const credentialProfiles = [];
  const configProfiles = [];

  if (sourceHasRawCredentials) {
    credentialProfiles.push(
      '[migration-source]',
      `aws_access_key_id=${childEnv['AWS_ACCESS_KEY_ID']}`,
      `aws_secret_access_key=${childEnv['AWS_SECRET_ACCESS_KEY']}`,
      childEnv['AWS_SESSION_TOKEN'] ? `aws_session_token=${childEnv['AWS_SESSION_TOKEN']}` : '',
      ''
    );
    configProfiles.push('[profile migration-source]', `region=${childEnv['AWS_REGION'] ?? 'us-east-1'}`, '');
    childEnv['AWS_PROFILE'] = childEnv['AWS_PROFILE'] || 'migration-source';
  }

  if (targetHasRawCredentials) {
    credentialProfiles.push(
      '[migration-target]',
      `aws_access_key_id=${childEnv['AWS_ACCESS_KEY_ID_TARGET']}`,
      `aws_secret_access_key=${childEnv['AWS_SECRET_ACCESS_KEY_TARGET']}`,
      childEnv['AWS_SESSION_TOKEN_TARGET'] ? `aws_session_token=${childEnv['AWS_SESSION_TOKEN_TARGET']}` : '',
      ''
    );
    configProfiles.push('[profile migration-target]', `region=${childEnv['AWS_REGION_TARGET'] ?? childEnv['AWS_REGION'] ?? 'us-east-1'}`, '');
    childEnv['AWS_PROFILE_TARGET'] = childEnv['AWS_PROFILE_TARGET'] || 'migration-target';
  }

  const existingCredentials = stripProfiles(
    readIfExists(childEnv['AWS_SHARED_CREDENTIALS_FILE'] ?? join(homedir(), '.aws', 'credentials')),
    ['migration-source', 'migration-target']
  );
  const existingConfig = stripProfiles(
    readIfExists(childEnv['AWS_CONFIG_FILE'] ?? join(homedir(), '.aws', 'config')),
    ['migration-source', 'migration-target']
  );

  const credentialsContent = [credentialProfiles.filter(Boolean).join('\n'), existingCredentials]
    .filter(Boolean)
    .join('\n\n');
  const configContent = [configProfiles.filter(Boolean).join('\n'), existingConfig]
    .filter(Boolean)
    .join('\n\n');

  writeFileSync(credentialsPath, credentialsContent, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(configPath, configContent, { encoding: 'utf8', mode: 0o600 });
  childEnv['AWS_SHARED_CREDENTIALS_FILE'] = credentialsPath;
  childEnv['AWS_CONFIG_FILE'] = configPath;
}

const [command, ...commandArgs] = process.argv.slice(2);
if (!command) {
  console.error('Usage: node scripts/run-with-env.mjs <command> [...args]');
  process.exit(2);
}

const result = spawnSync(command, commandArgs, {
  cwd: projectRoot,
  env: childEnv,
  stdio: 'inherit',
  shell: process.platform === 'win32' && !command.includes('\\') && !command.includes('/') && command !== 'node' && command !== 'uvx'
});

process.exit(result.status ?? 1);