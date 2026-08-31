import { readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../infrastructure/aws/logger.js';

/**
 * Credentials setup — the ONE place the console writes AWS credentials.
 *
 * The frontend collects temporary STS credentials (the user types them); this
 * module writes them into the AWS-touching MCP env blocks of the orchestrator
 * agent config, so the next `kiro-cli acp` spawn picks them up. The agent
 * value/values never originate in agent code — they arrive from the user via
 * HTTP and are persisted by this runtime process.
 *
 * Only the 4 MCP servers that talk to AWS carry credentials:
 *   aws-discovery-mcp, aws-pricing-mcp, aws-api-mcp, migration-planner-mcp
 * (infrastructure-graph-mcp and migration-analysis-mcp are local-store only.)
 */

const ORCHESTRATOR_CONFIG =
  process.env['ORCHESTRATOR_CONFIG'] ??
  join(homedir(), '.kiro', 'agents', 'aws-migration-orchestrator.json');

/** MCP servers that hold an AWS credential env block. */
const AWS_MCP_SERVERS = [
  'aws-discovery-mcp',
  'aws-pricing-mcp',
  'aws-api-mcp',
  'migration-planner-mcp',
];

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  region: string;
}

/** Setup payload: source is required; target is optional (cross-account). */
export interface CredsPayload {
  source: AwsCredentials;
  target?: AwsCredentials & { accountId?: string };
}

export interface CredsStatus {
  configPath: string;
  serversUpdated: string[];
  region: string;
  /** Masked identity hint, never the secret. */
  accessKeyIdTail: string;
  /** Set when target (cross-account) credentials were also written. */
  target?: { region: string; accessKeyIdTail: string; accountId?: string };
}

/** Basic shape validation for STS temporary credentials. */
export function validateCreds(c: Partial<AwsCredentials>): string | null {
  if (!c.accessKeyId || !/^A[SK]IA/.test(c.accessKeyId)) return 'accessKeyId inválido (esperado ASIA…/AKIA…)';
  if (!c.secretAccessKey || c.secretAccessKey.length < 20) return 'secretAccessKey inválido';
  // STS temp creds require a session token; long-term (AKIA) may omit it.
  if (c.accessKeyId.startsWith('ASIA') && !c.sessionToken) return 'sessionToken obrigatório para credenciais temporárias (ASIA…)';
  if (!c.region || !/^[a-z]{2}-[a-z]+-\d$/.test(c.region)) return 'region inválida (ex: us-east-1)';
  return null;
}

/**
 * Write the credentials into all AWS MCP env blocks (atomic temp+rename).
 *
 * Source credentials go into the standard AWS_* env vars (what the MCPs use by
 * default). When target (cross-account) credentials are supplied, they are ALSO
 * written into the same env blocks under *_TARGET keys, so the orchestrator can
 * switch to the destination account for the copy/deploy phase. The target
 * account id is written as MIGRATION_TARGET_ACCOUNT_ID.
 *
 * Returns a masked status; never echoes secret values.
 */
export async function applyCredentials(payload: CredsPayload): Promise<CredsStatus> {
  const { source, target } = payload;
  const raw = await readFile(ORCHESTRATOR_CONFIG, 'utf-8');
  const cfg = JSON.parse(raw) as { mcpServers?: Record<string, { env?: Record<string, string> }> };
  const servers = cfg.mcpServers ?? {};

  const updated: string[] = [];
  for (const name of AWS_MCP_SERVERS) {
    const server = servers[name];
    if (!server) continue;
    const env: Record<string, string> = {
      ...(server.env ?? {}),
      AWS_ACCESS_KEY_ID: source.accessKeyId,
      AWS_SECRET_ACCESS_KEY: source.secretAccessKey,
      AWS_SESSION_TOKEN: source.sessionToken,
      AWS_REGION: source.region,
    };
    if (target) {
      env['AWS_ACCESS_KEY_ID_TARGET'] = target.accessKeyId;
      env['AWS_SECRET_ACCESS_KEY_TARGET'] = target.secretAccessKey;
      env['AWS_SESSION_TOKEN_TARGET'] = target.sessionToken;
      env['AWS_REGION_TARGET'] = target.region;
      if (target.accountId) env['MIGRATION_TARGET_ACCOUNT_ID'] = target.accountId;
    } else {
      // Clear any stale target creds from a prior run so they can't leak.
      for (const k of ['AWS_ACCESS_KEY_ID_TARGET', 'AWS_SECRET_ACCESS_KEY_TARGET',
        'AWS_SESSION_TOKEN_TARGET', 'AWS_REGION_TARGET', 'MIGRATION_TARGET_ACCOUNT_ID']) {
        delete env[k];
      }
    }
    server.env = env;
    updated.push(name);
  }

  const tmp = `${ORCHESTRATOR_CONFIG}.tmp`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  await rename(tmp, ORCHESTRATOR_CONFIG);

  logger.info('orchestrator credentials updated', {
    servers: updated,
    region: source.region,
    accessKeyIdTail: source.accessKeyId.slice(-4),
    crossAccount: Boolean(target),
    targetRegion: target?.region,
    targetAccountId: target?.accountId,
  });

  const status: CredsStatus = {
    configPath: ORCHESTRATOR_CONFIG,
    serversUpdated: updated,
    region: source.region,
    accessKeyIdTail: source.accessKeyId.slice(-4),
  };
  if (target) {
    status.target = {
      region: target.region,
      accessKeyIdTail: target.accessKeyId.slice(-4),
      accountId: target.accountId,
    };
  }
  return status;
}
