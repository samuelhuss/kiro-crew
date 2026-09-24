import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { scanRegion, getResourceById, getResourceDependencies } from '../../../infrastructure/aws/scanner.js';
import { scanTotalInventory } from '../../../infrastructure/aws/total-inventory-scanner.js';
import { createInventoryRepository } from '../../../repositories/inventory-repository.factory.js';
import { createTotalInventoryRepository } from '../../../repositories/total-inventory-repository.factory.js';
import type { InfrastructureRepository } from '../../../repositories/infrastructure.repository.js';
import { groupByService } from '../../../domain/resources/inventory.js';
import { logger } from '../../../infrastructure/aws/logger.js';
import {
  startRun,
  getCurrentRun,
  listRuns,
  useRun,
  getRunsRoot,
  type RunMetadata,
} from '../../../infrastructure/run/run-context.js';
import type { AwsResource } from '../../../domain/resources/resource.js';

/**
 * DISCOVERY — stage 1 of the pipeline. SINGLE RESPONSIBILITY: scan AWS
 * (read-only) and persist the raw INVENTORY. It does NOT build the graph and
 * does NOT analyze migration — those are the graph and migration agents' jobs.
 *
 * Artefact store: every execution gets its own folder named after the project
 * being migrated — `runs/<project>/<runId>/` (see infrastructure/run/run-context.ts).
 * This server creates the run; the graph, analysis and planner servers follow
 * the same pointer, so all four processes write into one place.
 */
const repo: InfrastructureRepository = createInventoryRepository();
const totalInventoryRepo = createTotalInventoryRepository();

/** Every scan must land inside a run folder; create one on the fly if needed. */
function ensureRun(project: string | undefined, accountId: string, region: string): RunMetadata {
  const current = getCurrentRun();
  if (current && (!project || current.project === project)) return current;
  return startRun({
    project: project ?? `aws-${accountId || 'unknown'}-${region}`,
    sourceAccountId: accountId,
    sourceRegion: region,
  });
}

// ── Input schemas ─────────────────────────────────────────────────────────────

const ScanRegionInput = z.object({
  region: z.string().min(1).describe('AWS region to scan, e.g. us-east-1'),
  project: z
    .string()
    .min(1)
    .optional()
    .describe('Name of the project being migrated — artefacts go to runs/<project>/<runId>/'),
});

const StartRunInputSchema = z.object({
  project: z.string().min(1),
  sourceAccountId: z.string().default(''),
  sourceRegion: z.string().default(''),
  targetAccountId: z.string().default(''),
  targetRegion: z.string().default(''),
});

const UseRunInput = z.object({ runId: z.string().min(1) });

const GetResourceInput = z.object({
  id: z.string().min(1).describe('Resource ID or ARN'),
  region: z.string().min(1).optional().describe('AWS region (optional, speeds up lookup)'),
});

const ListResourcesInput = z.object({
  region: z.string().min(1).describe('AWS region'),
  type: z.string().optional().describe('Filter by resource type, e.g. AWS::ECS::Service'),
});

const GetDependenciesInput = z.object({
  id: z.string().min(1).describe('Resource ID or ARN'),
  region: z.string().min(1).describe('AWS region'),
});

const ScanTotalInventoryInput = z.object({
  region: z.string().min(1).describe('AWS region to scan, e.g. us-east-1'),
});

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'aws-discovery-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'start_migration_run',
      description:
        'Start a new execution for a project. Creates runs/<project>/<timestamp>-<account>-<region>/ and makes it the active run: inventory, graph, CFN templates and the manifest of THIS execution are all written there. Call this before scan_region when you know the project name.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Name of the project/workload being migrated' },
          sourceAccountId: { type: 'string' },
          sourceRegion: { type: 'string' },
          targetAccountId: { type: 'string' },
          targetRegion: { type: 'string' },
        },
        required: ['project'],
      },
    },
    {
      name: 'get_current_run',
      description: 'Show the active run: project, runId and the folder where every artefact of this execution is saved.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_migration_runs',
      description: 'List past executions (newest first) with their project, runId and folder.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'use_migration_run',
      description: 'Make a previous run the active one, to resume it or inspect its artefacts.',
      inputSchema: {
        type: 'object',
        properties: { runId: { type: 'string', description: 'runId or absolute run folder' } },
        required: ['runId'],
      },
    },
    {
      name: 'scan_region',
      description:
        'Scan an AWS region and return a structured inventory of all supported resources and their relationships. Starts a run automatically if none is active. READ-ONLY.',
      inputSchema: {
        type: 'object',
        properties: {
          region: { type: 'string', description: 'AWS region, e.g. us-east-1' },
          project: { type: 'string', description: 'Project being migrated (names the artefact folder)' },
        },
        required: ['region'],
      },
    },
    {
      name: 'list_resources',
      description:
        'List resources from the most recent cached scan of a region. Call scan_region first if no data is cached.',
      inputSchema: {
        type: 'object',
        properties: {
          region: { type: 'string', description: 'AWS region' },
          type: { type: 'string', description: 'Optional resource type filter (e.g. AWS::ECS::Service)' },
        },
        required: ['region'],
      },
    },
    {
      name: 'get_resource',
      description: 'Get full details of a single resource by its ID or ARN.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Resource ID or ARN' },
          region: { type: 'string', description: 'AWS region (optional)' },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_resource_dependencies',
      description: 'Get the direct dependencies of a resource and the relationships it participates in.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Resource ID or ARN' },
          region: { type: 'string', description: 'AWS region' },
        },
        required: ['id', 'region'],
      },
    },
    {
      name: 'scan_total_inventory',
      description:
        'Broad account-wide discovery beyond the collector-supported types (AWS Resource Explorer, falling back to the Tagging API), enriched with AWS Config to flag which extra resources can still get a faithful CFN, and classified into CORE/SUPPORTING/NOISE so AWS-managed scaffolding (service-linked roles, default VPC, etc.) does not drown out real workload resources. Call scan_region first so already-collected resources are correctly deduped. READ-ONLY.',
      inputSchema: {
        type: 'object',
        properties: {
          region: { type: 'string', description: 'AWS region, e.g. us-east-1' },
        },
        required: ['region'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'start_migration_run': {
        const input = StartRunInputSchema.parse(args);
        const run = startRun(input);
        return { content: [{ type: 'text', text: JSON.stringify(run, null, 2) }] };
      }

      case 'get_current_run': {
        const run = getCurrentRun();
        return {
          content: [
            {
              type: 'text',
              text: run
                ? JSON.stringify(run, null, 2)
                : `No active run. Call start_migration_run first. Runs root: ${getRunsRoot()}`,
            },
          ],
        };
      }

      case 'list_migration_runs': {
        return {
          content: [{ type: 'text', text: JSON.stringify({ runsRoot: getRunsRoot(), runs: listRuns() }, null, 2) }],
        };
      }

      case 'use_migration_run': {
        const { runId } = UseRunInput.parse(args);
        return { content: [{ type: 'text', text: JSON.stringify(useRun(runId), null, 2) }] };
      }

      case 'scan_region': {
        const { region, project } = ScanRegionInput.parse(args);
        const inventory = await scanRegion(region);
        const run = ensureRun(project, inventory.accountId, region);
        await repo.saveInventory(inventory);

        const grouped = groupByService(inventory.resources);
        const groupSummary = Object.entries(grouped).map(([service, items]) => ({
          service,
          count: items.length,
          resources: items.map((r: AwsResource) => ({ id: r.id, name: r.name, type: r.type })),
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  run: { project: run.project, runId: run.runId, runDir: run.runDir },
                  region: inventory.region,
                  accountId: inventory.accountId,
                  scannedAt: inventory.scannedAt,
                  stats: inventory.stats,
                  byService: groupSummary,
                  errors: inventory.errors,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'list_resources': {
        const { region, type } = ListResourcesInput.parse(args);
        const inventory = await repo.getInventory(region);
        if (!inventory) {
          return {
            content: [
              {
                type: 'text',
                text: `No cached inventory for region "${region}". Run scan_region first.`,
              },
            ],
          };
        }
        const filtered = type
          ? inventory.resources.filter((r) => r.type === type)
          : inventory.resources;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  region,
                  scannedAt: inventory.scannedAt,
                  count: filtered.length,
                  resources: filtered.map((r: AwsResource) => ({
                    id: r.id,
                    arn: r.arn,
                    type: r.type,
                    name: r.name,
                    dependencyCount: r.dependencies.length,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'get_resource': {
        const { id, region } = GetResourceInput.parse(args);
        let resource;

        if (region) {
          const inventory = await repo.getInventory(region);
          resource = inventory ? getResourceById(inventory, id) : undefined;
        } else {
          resource = await repo.findResource(id);
        }

        if (!resource) {
          return {
            content: [{ type: 'text', text: `Resource "${id}" not found in cached inventories.` }],
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(resource, null, 2) }],
        };
      }

      case 'get_resource_dependencies': {
        const { id, region } = GetDependenciesInput.parse(args);
        const inventory = await repo.getInventory(region);
        if (!inventory) {
          return {
            content: [{ type: 'text', text: `No cached inventory for region "${region}". Run scan_region first.` }],
          };
        }

        const resource = getResourceById(inventory, id);
        if (!resource) {
          return {
            content: [{ type: 'text', text: `Resource "${id}" not found in region "${region}".` }],
          };
        }

        const deps = getResourceDependencies(inventory, id);
        const relationships = await repo.findRelationships(id);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  resource: { id: resource.id, type: resource.type, name: resource.name },
                  directDependencies: deps.map((d: AwsResource) => ({ id: d.id, type: d.type, name: d.name })),
                  relationships,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'scan_total_inventory': {
        const { region } = ScanTotalInventoryInput.parse(args);
        const knownInventory = await repo.getInventory(region);
        const report = await scanTotalInventory(region, knownInventory);
        ensureRun(undefined, report.accountId, region);
        await totalInventoryRepo.saveReport(report);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  region: report.region,
                  accountId: report.accountId,
                  discoverySource: report.discoverySource,
                  summary: report.summary,
                  errors: report.errors,
                  // Full per-resource list so the caller can present buckets/fidelity honestly.
                  items: report.items.map((i) => ({
                    arn: i.arn,
                    resourceType: i.resourceType,
                    source: i.source,
                    tags: i.tags,
                    fidelity: i.fidelity,
                    fidelityReason: i.fidelityReason,
                    relevance: i.relevance,
                    relevanceReason: i.relevanceReason,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('MCP tool error', { tool: name, error: message });
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Initialise repository (no-op for InMemory, opens Kuzu DB for KuzuRepository)
  if (repo.init) await repo.init();
  if (totalInventoryRepo.init) await totalInventoryRepo.init();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('aws-discovery-mcp started', {
    transport: 'stdio',
    runsRoot: getRunsRoot(),
    activeRun: getCurrentRun()?.runDir ?? 'none (created on first scan)',
  });

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    logger.info('aws-discovery-mcp shutting down');
    if (repo.close) await repo.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
