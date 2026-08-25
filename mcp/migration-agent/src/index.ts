import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { scanRegion } from '../../../infrastructure/aws/scanner.js';
import { buildGraph } from '../../../domain/graph/builder.js';
import { exportGraph } from '../../../domain/graph/graph.js';
import { InMemoryGraphRepository } from '../../../repositories/graph/in-memory-graph.repository.js';
import { InMemoryAssessmentRepository } from '../../../repositories/migration/in-memory-assessment.repository.js';
import { MigrationAnalysisService } from '../../../domain/migration/service.js';
import { evaluateRule } from '../../../domain/migration/rules.js';
import { logger } from '../../../infrastructure/aws/logger.js';

/**
 * migration-analysis-agent MCP server.
 *
 * Exposes tools so the agent queries SPECIFIC parts of the graph and the
 * deterministic rules, instead of receiving the whole graph in the prompt.
 *
 *   Infrastructure Graph → Migration Rules → Migration Analysis → Assessment
 *
 * READ-ONLY: never creates/changes/deletes AWS resources; no CloudFormation,
 * Terraform, snapshots, replication, or DNS changes.
 */
const graphRepo = new InMemoryGraphRepository();
const assessmentRepo = new InMemoryAssessmentRepository();
const service = new MigrationAnalysisService(graphRepo, assessmentRepo);

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const notFound = (id: string) => ({
  content: [{ type: 'text' as const, text: `Resource "${id}" not found. Run build_graph first, or check the id.` }],
});

const RegionInput = z.object({ region: z.string().min(1) });
const AnalyzeInput = z.object({ sourceRegion: z.string().min(1), targetRegion: z.string().min(1) });
const IdInput = z.object({ id: z.string().min(1) });
const RuleInput = z.object({
  resourceType: z.string().min(1),
  sourceRegion: z.string().min(1).optional(),
  targetRegion: z.string().min(1).optional(),
});

const server = new Server(
  { name: 'migration-analysis-agent', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'build_graph',
      description: 'Scan a region (READ-ONLY) and build the infrastructure graph. Run this before analysis if no graph is loaded.',
      inputSchema: { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] },
    },
    {
      name: 'get_infrastructure_graph',
      description: 'Return the graph metadata + a serialized { nodes, edges } view. Prefer the scoped tools for large graphs.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_resource',
      description: 'Get one resource (node) by id or ARN.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'get_dependencies',
      description: 'List what a resource depends on (outgoing edges), with relationship types.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'get_dependents',
      description: 'List what depends on a resource (incoming edges).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'get_impact',
      description: 'Transitive set of resources affected if a resource changes/is removed.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'get_migration_rule',
      description: 'Return the DETERMINISTIC migration rule decision for a resource type (strategy, status, base risk, blockers). Use this instead of guessing a strategy.',
      inputSchema: {
        type: 'object',
        properties: {
          resourceType: { type: 'string', description: 'e.g. AWS::RDS::DBInstance' },
          sourceRegion: { type: 'string' },
          targetRegion: { type: 'string' },
        },
        required: ['resourceType'],
      },
    },
    {
      name: 'analyze_resource_migration',
      description: 'Run the full migration analysis (source→target) over the loaded graph and return the structured assessment: summary, resources, phases, blockers, risks, manual actions.',
      inputSchema: {
        type: 'object',
        properties: {
          sourceRegion: { type: 'string' },
          targetRegion: { type: 'string' },
        },
        required: ['sourceRegion', 'targetRegion'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case 'build_graph': {
        const { region } = RegionInput.parse(args);
        const inventory = await scanRegion(region);
        const graph = buildGraph(inventory);
        await graphRepo.saveGraph(graph);
        return text({ region: inventory.region, accountId: inventory.accountId, metadata: graph.metadata, issues: graph.issues });
      }

      case 'get_infrastructure_graph': {
        const graph = await graphRepo.getGraph();
        return text({ metadata: graph.metadata, graph: exportGraph(graph) });
      }

      case 'get_resource': {
        const { id } = IdInput.parse(args);
        const node = await graphRepo.getNode(id);
        return node ? text(node) : notFound(id);
      }

      case 'get_dependencies': {
        const { id } = IdInput.parse(args);
        if (!(await graphRepo.getNode(id))) return notFound(id);
        const deps = await graphRepo.getDependencies(id);
        return text({ resource: id, dependencies: deps.map((d) => ({ id: d.node.id, type: d.node.type, relationship: d.relationship })) });
      }

      case 'get_dependents': {
        const { id } = IdInput.parse(args);
        if (!(await graphRepo.getNode(id))) return notFound(id);
        const dependents = await graphRepo.getDependents(id);
        return text({ resource: id, dependents: dependents.map((d) => ({ id: d.node.id, type: d.node.type, relationship: d.relationship })) });
      }

      case 'get_impact': {
        const { id } = IdInput.parse(args);
        if (!(await graphRepo.getNode(id))) return notFound(id);
        return text(await graphRepo.getImpact(id));
      }

      case 'get_migration_rule': {
        const { resourceType, sourceRegion, targetRegion } = RuleInput.parse(args);
        // Evaluate the rule against a synthetic node — no graph lookup needed.
        const decision = evaluateRule({
          node: {
            id: `sample:${resourceType}`,
            arn: '',
            type: resourceType as never,
            name: 'sample',
            region: sourceRegion ?? 'us-east-1',
            accountId: '000000000000',
            properties: {},
          },
          sourceRegion: sourceRegion ?? 'us-east-1',
          targetRegion: targetRegion ?? 'sa-east-1',
          dependencies: [],
        });
        return text({ resourceType, decision });
      }

      case 'analyze_resource_migration': {
        const { sourceRegion, targetRegion } = AnalyzeInput.parse(args);
        const assessment = await service.analyze(sourceRegion, targetRegion);
        return text(assessment);
      }

      default:
        return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('migration-agent tool error', { tool: name, error: message });
    return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('migration-analysis-agent started', { transport: 'stdio' });

  const shutdown = (): void => {
    logger.info('migration-analysis-agent shutting down');
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
