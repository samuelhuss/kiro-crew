import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { generateMigrationPlan } from '../../../domain/migration/planner.js';
import { generateCfnTemplates } from '../../../domain/migration/cfn-generator.js';
import { runFullValidation } from '../../../domain/migration/validator.js';
import { createGraphRepository } from '../../../repositories/graph/graph-repository.factory.js';
import { MigrationAnalysisService } from '../../../domain/migration/service.js';
import { InMemoryAssessmentRepository } from '../../../repositories/migration/in-memory-assessment.repository.js';
import { logger } from '../../../infrastructure/aws/logger.js';
import type { MigrationRequirements } from '../../../domain/migration/plan.js';
import type { MigrationPlan } from '../../../domain/migration/plan.js';

/**
 * migration-planner-mcp — Stage 4 of the pipeline.
 *
 * Takes the migration assessment and user requirements, produces:
 *   - An ordered migration plan with phases and actions
 *   - CloudFormation templates per phase
 *   - Validation results (cfn-lint + optional AWS validate)
 *
 * READ-ONLY: generates files but never deploys to AWS.
 */

const graphRepo = createGraphRepository();
const assessmentRepo = new InMemoryAssessmentRepository();
const migrationService = new MigrationAnalysisService(graphRepo, assessmentRepo);

// Keep the last generated plan in memory for multi-step interactions
let lastPlan: MigrationPlan | null = null;

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

// ── Input schemas ─────────────────────────────────────────────────────────────

const GeneratePlanInput = z.object({
  sourceRegion: z.string().min(1),
  targetRegion: z.string().min(1),
  sourceAccountId: z.string().default(''),
  targetAccountId: z.string().default(''),
  scopedResourceIds: z.array(z.string()).default([]),
  isCrossAccount: z.boolean().default(false),
  maxDowntimeMinutes: z.number().default(60),
  requiresZeroDowntime: z.boolean().default(false),
});

const ValidateInput = z.object({
  outputDir: z.string().default('cfn'),
  awsValidate: z.boolean().default(false),
  region: z.string().optional(),
});

// ── Server ────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'migration-planner-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'generate_migration_plan',
      description:
        'Generate an ordered migration plan from the assessment. Produces phases, actions, pre-flight checks, rollback strategy. Requires that scan_region + build_graph + analyze ran first.',
      inputSchema: {
        type: 'object',
        properties: {
          sourceRegion: { type: 'string', description: 'Source AWS region' },
          targetRegion: { type: 'string', description: 'Target AWS region' },
          sourceAccountId: { type: 'string', description: 'Source AWS account ID (for cross-account)' },
          targetAccountId: { type: 'string', description: 'Target AWS account ID (for cross-account)' },
          scopedResourceIds: {
            type: 'array', items: { type: 'string' },
            description: 'Specific resource IDs to migrate (empty = all). Dependencies are auto-included.',
          },
          isCrossAccount: { type: 'boolean', description: 'Is this a cross-account migration?' },
          maxDowntimeMinutes: { type: 'number', description: 'Maximum acceptable downtime in minutes' },
          requiresZeroDowntime: { type: 'boolean', description: 'Must the migration be zero-downtime?' },
        },
        required: ['sourceRegion', 'targetRegion'],
      },
    },
    {
      name: 'generate_cfn_templates',
      description:
        'Generate CloudFormation YAML templates from the last migration plan. One template per phase/stack. Returns file paths and template summaries.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'validate_templates',
      description:
        'Run cfn-lint validation on the generated templates. Returns findings (errors, warnings). Optionally also runs AWS CloudFormation validate-template API.',
      inputSchema: {
        type: 'object',
        properties: {
          outputDir: { type: 'string', description: 'Directory where templates are written (default: cfn/)' },
          awsValidate: { type: 'boolean', description: 'Also run AWS validate-template API? (needs creds)' },
          region: { type: 'string', description: 'Region for AWS validation' },
        },
      },
    },
    {
      name: 'get_plan_summary',
      description: 'Get a human-readable summary of the current migration plan (phases, actions, risk, estimated time).',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case 'generate_migration_plan': {
        const input = GeneratePlanInput.parse(args);

        // Run assessment first (reads graph from shared store)
        const assessment = await migrationService.analyze(input.sourceRegion, input.targetRegion);

        const requirements: MigrationRequirements = {
          sourceAccountId: input.sourceAccountId || assessment.sourceRegion,
          sourceRegion: input.sourceRegion,
          targetAccountId: input.targetAccountId || '',
          targetRegion: input.targetRegion,
          scopedResourceIds: input.scopedResourceIds,
          architectureOverrides: [],
          maxDowntimeMinutes: input.maxDowntimeMinutes,
          requiresZeroDowntime: input.requiresZeroDowntime,
          isCrossAccount: input.isCrossAccount,
        };

        lastPlan = generateMigrationPlan(assessment, requirements);

        return text({
          planId: lastPlan.planId,
          totalPhases: lastPlan.phases.length,
          totalActions: lastPlan.totalActions,
          estimatedMinutes: lastPlan.totalEstimatedMinutes,
          overallRisk: lastPlan.overallRisk,
          blockers: lastPlan.blockers.length,
          preFlightChecks: lastPlan.preFlightChecks.length,
          phases: lastPlan.phases.map(p => ({
            order: p.order,
            name: p.name,
            actions: p.actions.length,
            estimatedMinutes: p.estimatedDurationMinutes,
            risk: p.risk,
            rollbackable: p.rollbackable,
          })),
        });
      }

      case 'generate_cfn_templates': {
        if (!lastPlan) {
          return {
            content: [{ type: 'text' as const, text: 'No plan generated yet. Run generate_migration_plan first.' }],
            isError: true,
          };
        }

        const templates = generateCfnTemplates(lastPlan);
        return text({
          templatesGenerated: templates.length,
          templates: templates.map(t => ({
            stackName: t.stackName,
            path: t.templatePath,
            sizeBytes: t.yaml.length,
          })),
        });
      }

      case 'validate_templates': {
        if (!lastPlan) {
          return {
            content: [{ type: 'text' as const, text: 'No plan generated yet. Run generate_migration_plan first.' }],
            isError: true,
          };
        }

        const input = ValidateInput.parse(args);
        const templates = generateCfnTemplates(lastPlan);
        const { summary, results, allPassed } = await runFullValidation(templates, {
          outputDir: input.outputDir,
          awsValidate: input.awsValidate,
          region: input.region,
        });

        return text({
          summary,
          allPassed,
          results: results.map(r => ({
            stackName: r.stackName,
            templatePath: r.templatePath,
            valid: r.valid,
            errors: r.lintResults.filter(f => f.level === 'error').length,
            warnings: r.lintResults.filter(f => f.level === 'warning').length,
            findings: r.lintResults.slice(0, 10), // Cap to avoid huge output
          })),
        });
      }

      case 'get_plan_summary': {
        if (!lastPlan) {
          return {
            content: [{ type: 'text' as const, text: 'No plan generated yet. Run generate_migration_plan first.' }],
            isError: true,
          };
        }

        const summary = [
          `Migration Plan: ${lastPlan.planId}`,
          `Created: ${lastPlan.createdAt}`,
          `Source: ${lastPlan.requirements.sourceRegion} (${lastPlan.requirements.sourceAccountId})`,
          `Target: ${lastPlan.requirements.targetRegion} (${lastPlan.requirements.targetAccountId})`,
          `Cross-account: ${lastPlan.requirements.isCrossAccount}`,
          ``,
          `Phases: ${lastPlan.phases.length}`,
          `Total actions: ${lastPlan.totalActions}`,
          `Estimated time: ${lastPlan.totalEstimatedMinutes} minutes`,
          `Overall risk: ${lastPlan.overallRisk}`,
          `Blockers: ${lastPlan.blockers.length}`,
          ``,
          `--- Phases ---`,
          ...lastPlan.phases.map(p =>
            `  ${p.order}. ${p.name} (${p.actions.length} actions, ~${p.estimatedDurationMinutes}min, risk=${p.risk}, rollback=${p.rollbackable ? 'yes' : 'no'})`
          ),
          ``,
          `--- Pre-flight Checks ---`,
          ...lastPlan.preFlightChecks.map(c =>
            `  [${c.blocking ? 'BLOCKING' : 'WARNING'}] ${c.description}`
          ),
          ``,
          `Rollback Strategy:`,
          lastPlan.rollbackStrategy,
        ].join('\n');

        return { content: [{ type: 'text' as const, text: summary }] };
      }

      default:
        return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('planner-mcp tool error', { tool: name, error: message });
    return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
  }
});

async function main(): Promise<void> {
  if (graphRepo.init) await graphRepo.init();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('migration-planner-mcp started', { transport: 'stdio' });

  const shutdown = async (): Promise<void> => {
    logger.info('migration-planner-mcp shutting down');
    if (graphRepo.close) await graphRepo.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
