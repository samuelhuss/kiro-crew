import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { buildGraph } from '../../../domain/graph/builder.js';
import { createGraphRepository } from '../../../repositories/graph/graph-repository.factory.js';
import type { InfrastructureGraphRepository } from '../../../repositories/graph/graph.repository.js';
import { createInventoryRepository } from '../../../repositories/inventory-repository.factory.js';
import type { InfrastructureRepository } from '../../../repositories/infrastructure.repository.js';
import { logger } from '../../../infrastructure/aws/logger.js';
import type { GraphNode } from '../../../domain/graph/node.js';

/** Group graph nodes by their CloudFormation service prefix (e.g. 'ECS'). */
function groupNodesByService(nodes: GraphNode[]): Array<{ service: string; count: number }> {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const service = n.type.split('::')[1] ?? 'Unknown';
    counts.set(service, (counts.get(service) ?? 0) + 1);
  }
  return [...counts.entries()].map(([service, count]) => ({ service, count }));
}

/**
 * infrastructure-graph-agent MCP server — stage 2 of the pipeline.
 *
 * SINGLE RESPONSIBILITY: read the INVENTORY that the discovery agent persisted,
 * build the InfrastructureGraph from it, store the graph, and expose graph
 * queries. It NEVER scans AWS — that is the discovery agent's job. If no
 * inventory exists for the region, it tells the caller to run discovery first.
 *
 * Pipeline:  discovery.scan_region → Inventory → graph.build_graph → Graph
 */
const repo: InfrastructureGraphRepository = createGraphRepository();

/** Inventory store — SHARED with the discovery agent (read-only here). */
const inventoryDir =
  process.env['INVENTORY_DIR'] ?? process.env['KUZU_INVENTORY_DIR'] ?? process.env['KUZU_DATA_DIR'];
const inventoryRepo: InfrastructureRepository = createInventoryRepository();

// ── Input schemas ─────────────────────────────────────────────────────────────

const BuildGraphInput = z.object({
  region: z.string().min(1).describe('AWS region whose inventory to build the graph from, e.g. us-east-1'),
});
const NodeIdInput = z.object({ id: z.string().min(1).describe('Resource id or ARN') });
const TypeInput = z.object({ type: z.string().min(1).describe('Resource type, e.g. AWS::ECS::Service') });
const PathInput = z.object({
  source: z.string().min(1).describe('Source resource id'),
  target: z.string().min(1).describe('Target resource id'),
});

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const notFound = (id: string) => ({
  content: [{ type: 'text' as const, text: `Resource "${id}" not found. Run build_graph first, or check the id.` }],
});

// ── Server ────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'infrastructure-graph-agent', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'build_graph',
      description:
        'Build the infrastructure graph FROM the inventory the discovery agent persisted for a region — does NOT scan AWS. Requires that discovery.scan_region(region) ran first. Returns a summary of nodes, edges and consistency issues.',
      inputSchema: {
        type: 'object',
        properties: { region: { type: 'string', description: 'AWS region, e.g. us-east-1' } },
        required: ['region'],
      },
    },
    {
      name: 'get_resource',
      description: 'Get a single resource (node) by id or ARN.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Resource id or ARN' } },
        required: ['id'],
      },
    },
    {
      name: 'get_resources_by_type',
      description: 'List all resources of a given type, e.g. AWS::ECS::Service.',
      inputSchema: {
        type: 'object',
        properties: { type: { type: 'string', description: 'Resource type' } },
        required: ['type'],
      },
    },
    {
      name: 'get_dependencies',
      description: 'List resources that the given resource depends on (outgoing edges), with the relationship type.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Resource id or ARN' } },
        required: ['id'],
      },
    },
    {
      name: 'get_dependents',
      description: 'List resources that depend on the given resource (incoming edges). Useful for "what uses X".',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Resource id or ARN' } },
        required: ['id'],
      },
    },
    {
      name: 'get_impact',
      description: 'Analyze the potential impact of removing/changing a resource — the transitive set of affected resources.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Resource id or ARN' } },
        required: ['id'],
      },
    },
    {
      name: 'find_path',
      description: 'Find a directed dependency path between two resources, following the real relationships in the graph.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source resource id' },
          target: { type: 'string', description: 'Target resource id' },
        },
        required: ['source', 'target'],
      },
    },
    {
      name: 'get_architecture',
      description: 'Return the full graph serialized for visualization ({ nodes, edges }), plus a service breakdown and known limitations.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case 'build_graph': {
        const { region } = BuildGraphInput.parse(args);
        // Read the inventory the discovery agent persisted — NO AWS scan here.
        const inventory = await inventoryRepo.getInventory(region);
        if (!inventory) {
          return {
            content: [{
              type: 'text' as const,
              text: `No inventory found for region "${region}". Run the discovery agent's scan_region("${region}") first — the graph agent builds the graph FROM the inventory and never scans AWS itself.`,
            }],
            isError: true,
          };
        }
        const graph = buildGraph(inventory);
        await repo.saveGraph(graph);
        return text({
          region: inventory.region,
          accountId: inventory.accountId,
          scannedAt: inventory.scannedAt,
          source: 'inventory (no re-scan)',
          metadata: graph.metadata,
          issues: graph.issues,
        });
      }

      case 'get_resource': {
        const { id } = NodeIdInput.parse(args);
        const node = await repo.getNode(id);
        return node ? text(node) : notFound(id);
      }

      case 'get_resources_by_type': {
        const { type } = TypeInput.parse(args);
        const nodes = await repo.getNodesByType(type);
        return text({ type, count: nodes.length, resources: nodes });
      }

      case 'get_dependencies': {
        const { id } = NodeIdInput.parse(args);
        if (!(await repo.getNode(id))) return notFound(id);
        const deps = await repo.getDependencies(id);
        return text({
          resource: id,
          dependencies: deps.map((d) => ({ id: d.node.id, type: d.node.type, name: d.node.name, relationship: d.relationship })),
        });
      }

      case 'get_dependents': {
        const { id } = NodeIdInput.parse(args);
        if (!(await repo.getNode(id))) return notFound(id);
        const dependents = await repo.getDependents(id);
        return text({
          resource: id,
          dependents: dependents.map((d) => ({ id: d.node.id, type: d.node.type, name: d.node.name, relationship: d.relationship })),
        });
      }

      case 'get_impact': {
        const { id } = NodeIdInput.parse(args);
        if (!(await repo.getNode(id))) return notFound(id);
        return text(await repo.getImpact(id));
      }

      case 'find_path': {
        const { source, target } = PathInput.parse(args);
        const path = await repo.findPath(source, target);
        return path
          ? text(path)
          : { content: [{ type: 'text' as const, text: `No directed path found from "${source}" to "${target}".` }] };
      }

      case 'get_architecture': {
        const graph = await repo.getGraph();
        const exported = await repo.exportGraph();
        const byService = groupNodesByService(graph.nodes);
        return text({
          metadata: graph.metadata,
          byService,
          limitations: graph.issues.filter((i) => i.kind === 'UNKNOWN_RELATIONSHIP'),
          graph: exported,
        });
      }

      default:
        return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('graph-agent tool error', { tool: name, error: message });
    return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
  }
});

async function main(): Promise<void> {
  if (repo.init) await repo.init();
  if (inventoryRepo.init) await inventoryRepo.init();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('infrastructure-graph-agent started', {
    transport: 'stdio',
    graphStore: (process.env['GRAPH_DIR'] ?? process.env['KUZU_GRAPH_DIR'] ?? process.env['KUZU_DATA_DIR']) ? 'file(shared)' : 'in-memory',
    inventoryStore: inventoryDir ? 'file(shared)' : 'in-memory',
  });

  const shutdown = async (): Promise<void> => {
    logger.info('infrastructure-graph-agent shutting down');
    if (repo.close) await repo.close();
    if (inventoryRepo.close) await inventoryRepo.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
