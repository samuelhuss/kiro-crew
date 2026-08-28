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

export interface CredsStatus {
  configPath: string;
  serversUpdated: string[];
  region: string;
  /** Masked identity hint, never the secret. */
  accessKeyIdTail: string;
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
 * Returns a masked status; never echoes secret values.
 */
export async function applyCredentials(creds: AwsCredentials): Promise<CredsStatus> {
  const raw = await readFile(ORCHESTRATOR_CONFIG, 'utf-8');
  const cfg = JSON.parse(raw) as { mcpServers?: Record<string, { env?: Record<string, string> }> };
  const servers = cfg.mcpServers ?? {};

  const updated: string[] = [];
  for (const name of AWS_MCP_SERVERS) {
    const server = servers[name];
    if (!server) continue;
    server.env = {
      ...(server.env ?? {}),
      AWS_ACCESS_KEY_ID: creds.accessKeyId,
      AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
      AWS_SESSION_TOKEN: creds.sessionToken,
      AWS_REGION: creds.region,
    };
    updated.push(name);
  }

  const tmp = `${ORCHESTRATOR_CONFIG}.tmp`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  await rename(tmp, ORCHESTRATOR_CONFIG);

  logger.info('orchestrator credentials updated', {
    servers: updated,
    region: creds.region,
    accessKeyIdTail: creds.accessKeyId.slice(-4),
  });

  return {
    configPath: ORCHESTRATOR_CONFIG,
    serversUpdated: updated,
    region: creds.region,
    accessKeyIdTail: creds.accessKeyId.slice(-4),
  };
}
