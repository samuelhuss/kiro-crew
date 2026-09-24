import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};

  const env = {};
  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const equalsIndex = line.indexOf('=');
    if (equalsIndex <= 0) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function stringifyEnv(env) {
  return `${Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value ?? ''}`)
    .join('\n')}\n`;
}

export function writeEnvFile(filePath, env) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, stringifyEnv(env), 'utf8');
}