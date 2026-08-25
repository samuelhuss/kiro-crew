import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { scanRegion } from '../../../infrastructure/aws/scanner.js';
import { buildGraph } from '../../../domain/graph/builder.js';
import { InMemoryGraphRepository } from '../../../repositories/graph/in-memory-graph.repository.js';
import type { InfrastructureGraphRepository } from '../../../repositories/graph/graph.repository.js';
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
 * infrastructure-graph-agent MCP server.
 *
 * Consumes the normalized inventory produced by the Discovery layer, builds an
 * InfrastructureGraph, stores it in a storage-independent repository, and exposes
 * graph queries as tools. It NEVER calls AWS write APIs and performs NO migration.
 *
 * build_graph runs scan_region internally (read-only) and then builds the graph,
 * satisfying:  scan_region → inventory → build_graph → InfrastructureGraph.
 */
const repo: InfrastructureGraphRepository = new InMemoryGraphRepository();

// ── Input schemas ─────────────────────────────────────────────────────────────

const BuildGraphInput = z.object({
  region: z.string().min(1).describe('AWS region to scan and graph, e.g. us-east-1'),
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
        'Scan a region (READ-ONLY) and build the infrastructure graph from the inventory. Run this first. Returns a summary of nodes, edges and consistency issues.',
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
        const inventory = await scanRegion(region);
        const graph = buildGraph(inventory);
        await repo.saveGraph(graph);
        return text({
          region: inventory.region,
          accountId: inventory.accountId,
          scannedAt: inventory.scannedAt,
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('infrastructure-graph-agent started', { transport: 'stdio', repository: 'in-memory' });

  const shutdown = async (): Promise<void> => {
    logger.info('infrastructure-graph-agent shutting down');
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
