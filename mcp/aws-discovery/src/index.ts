import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { scanRegion, getResourceById, getResourceDependencies } from '../../../infrastructure/aws/scanner.js';
import { InMemoryInfrastructureRepository } from '../../../repositories/infrastructure.repository.js';
import { KuzuInfrastructureRepository } from '../../../repositories/kuzu.repository.js';
import type { InfrastructureRepository } from '../../../repositories/infrastructure.repository.js';
import { groupByService } from '../../../domain/resources/inventory.js';
import { logger } from '../../../infrastructure/aws/logger.js';
import type { AwsResource } from '../../../domain/resources/resource.js';

/**
 * Repository selection:
 *   KUZU_DATA_DIR  — set to a path → uses KuzuInfrastructureRepository (file-backed graph DB)
 *   unset          → uses InMemoryInfrastructureRepository (no persistence, good for CI/tests)
 */
const repo: InfrastructureRepository = process.env['KUZU_DATA_DIR']
  ? new KuzuInfrastructureRepository(process.env['KUZU_DATA_DIR'])
  : new InMemoryInfrastructureRepository();

// ── Input schemas ─────────────────────────────────────────────────────────────

const ScanRegionInput = z.object({
  region: z.string().min(1).describe('AWS region to scan, e.g. us-east-1'),
});

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

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'aws-discovery-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'scan_region',
      description:
        'Scan an AWS region and return a structured inventory of all supported resources and their relationships. READ-ONLY.',
      inputSchema: {
        type: 'object',
        properties: {
          region: { type: 'string', description: 'AWS region, e.g. us-east-1' },
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'scan_region': {
        const { region } = ScanRegionInput.parse(args);
        const inventory = await scanRegion(region);
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

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const repoKind = process.env['KUZU_DATA_DIR'] ? `kuzu:${process.env['KUZU_DATA_DIR']}` : 'in-memory';
  logger.info('aws-discovery-mcp started', { transport: 'stdio', repository: repoKind });

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
