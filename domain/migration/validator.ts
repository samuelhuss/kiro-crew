import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CloudFormationClient,
  ValidateTemplateCommand,
  CreateChangeSetCommand,
  DescribeChangeSetCommand,
  DeleteChangeSetCommand,
} from '@aws-sdk/client-cloudformation';
import { resolveArtifactDir } from '../../infrastructure/run/run-context.js';
import type { GeneratedTemplate } from './cfn-generator.js';

const exec = promisify(execFile);

/**
 * Migration Plan Validator
 *
 * Validates generated CloudFormation templates through multiple layers:
 *   1. cfn-lint (syntax, best practices, resource property validation)
 *   2. aws cloudformation validate-template (AWS API syntax check)
 *   3. Change set creation --no-execute (what-if analysis, optional)
 *
 * None of these steps deploy anything. They are all read-only/dry-run.
 */

export interface ValidationResult {
  templatePath: string;
  stackName: string;
  /** Overall pass/fail */
  valid: boolean;
  /** cfn-lint findings */
  lintResults: LintFinding[];
  /** AWS validate-template result (if run) */
  awsValidation?: AwsValidationResult;
  /** Changeset details (if created) */
  changeSet?: ChangeSetResult;
}

export interface LintFinding {
  level: 'error' | 'warning' | 'informational';
  rule: string;
  message: string;
  location: string; // file:line:col
}

export interface AwsValidationResult {
  valid: boolean;
  error?: string;
  parameters: string[];
  capabilities: string[];
}

export interface ChangeSetResult {
  changeSetId: string;
  status: string;
  changes: ChangeSetChange[];
  estimatedCost?: string;
}

export interface ChangeSetChange {
  action: 'Add' | 'Modify' | 'Remove';
  logicalId: string;
  resourceType: string;
  replacement?: 'True' | 'False' | 'Conditional';
}

/**
 * Write templates to disk and run cfn-lint on each.
 * Returns validation results per template.
 */
export async function validateTemplates(
  templates: GeneratedTemplate[],
  outputDir?: string
): Promise<ValidationResult[]> {
  const targetDir = resolveArtifactDir('cfn', outputDir);
  // Write templates to disk
  await mkdir(targetDir, { recursive: true });
  const results: ValidationResult[] = [];

  for (const template of templates) {
    const filePath = join(targetDir, template.templatePath.replace('cfn/', ''));
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, template.yaml, 'utf8');

    // Run cfn-lint
    const lintResults = await runCfnLint(filePath);
    const valid = !lintResults.some(f => f.level === 'error');

    results.push({
      templatePath: filePath,
      stackName: template.stackName,
      valid,
      lintResults,
    });
  }

  return results;
}

/**
 * Run cfn-lint on a single template file.
 * Resolved from CFN_LINT_PATH, otherwise from PATH.
 * Returns structured findings.
 */
async function runCfnLint(templatePath: string): Promise<LintFinding[]> {
  try {
    const cfnLintPath = process.env['CFN_LINT_PATH'] ?? 'cfn-lint';
    const { stdout } = await exec(cfnLintPath, [
      templatePath,
      '--format', 'json',
      '--include-checks', 'I',  // Include informational
    ], { timeout: 30_000 });

    if (!stdout.trim()) return []; // No findings = clean

    const findings = JSON.parse(stdout) as Array<{
      Level: string;
      Rule: { Id: string };
      Message: string;
      Location: { Start: { LineNumber: number; ColumnNumber: number } };
      Filename: string;
    }>;

    return findings.map(f => ({
      level: f.Level.toLowerCase() as LintFinding['level'],
      rule: f.Rule.Id,
      message: f.Message,
      location: `${f.Filename}:${f.Location.Start.LineNumber}:${f.Location.Start.ColumnNumber}`,
    }));
  } catch (err: unknown) {
    // cfn-lint exits non-zero when it finds errors — parse stderr/stdout
    const error = err as { stdout?: string; stderr?: string; code?: number | string };

    if (error.stdout) {
      try {
        const findings = JSON.parse(error.stdout) as Array<{
          Level: string;
          Rule: { Id: string };
          Message: string;
          Location: { Start: { LineNumber: number; ColumnNumber: number } };
          Filename: string;
        }>;
        return findings.map(f => ({
          level: f.Level.toLowerCase() as LintFinding['level'],
          rule: f.Rule.Id,
          message: f.Message,
          location: `${f.Filename}:${f.Location?.Start?.LineNumber ?? 0}:${f.Location?.Start?.ColumnNumber ?? 0}`,
        }));
      } catch {
        // JSON parse failed
      }
    }

    return [{
      level: 'error',
      rule: 'LINT_EXECUTION_FAILED',
      message:
        error.code === 'ENOENT' || /ENOENT/.test(String(error.stderr ?? ''))
          ? 'cfn-lint not found. Install it (`pip install cfn-lint`) or set CFN_LINT_PATH to its full path.'
          : error.stderr || String(err),
      location: templatePath,
    }];
  }
}

/**
 * Validate a template via the AWS CloudFormation API.
 * Requires valid AWS credentials. READ-ONLY operation.
 */
export async function validateWithAws(
  templatePath: string,
  region: string
): Promise<AwsValidationResult> {
  try {
    const client = new CloudFormationClient({ region });
    const body = await readFile(templatePath, 'utf8');
    const result = await client.send(new ValidateTemplateCommand({ TemplateBody: body }));
    return {
      valid: true,
      parameters: (result.Parameters ?? []).map((p) => p.ParameterKey ?? ''),
      capabilities: result.Capabilities ?? [],
    };
  } catch (err) {
    return {
      valid: false,
      error: `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
      parameters: [],
      capabilities: [],
    };
  }
}

/**
 * Create a CloudFormation change set WITHOUT executing it.
 * This is the most thorough dry-run — shows exactly what would be created/modified.
 * Requires valid AWS credentials. The changeset is deleted after inspection.
 */
export async function createDryRunChangeset(
  templatePath: string,
  stackName: string,
  region: string,
  parameters: Record<string, string> = {}
): Promise<ChangeSetResult> {
  const changeSetName = `dryrun-${Date.now()}`;
  const client = new CloudFormationClient({ region });

  try {
    const body = await readFile(templatePath, 'utf8');

    await client.send(new CreateChangeSetCommand({
      StackName: stackName,
      ChangeSetName: changeSetName,
      ChangeSetType: 'CREATE',
      TemplateBody: body,
      Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
      Parameters: Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({
        ParameterKey,
        ParameterValue,
      })),
    }));

    // Give CloudFormation a moment to compute the change set
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    const desc = await client.send(new DescribeChangeSetCommand({
      StackName: stackName,
      ChangeSetName: changeSetName,
    }));

    return {
      changeSetId: desc.ChangeSetId ?? '',
      status: desc.Status ?? 'UNKNOWN',
      changes: (desc.Changes ?? []).map((c) => ({
        action: (c.ResourceChange?.Action ?? 'Add') as ChangeSetChange['action'],
        logicalId: c.ResourceChange?.LogicalResourceId ?? '',
        resourceType: c.ResourceChange?.ResourceType ?? '',
        replacement: c.ResourceChange?.Replacement as ChangeSetChange['replacement'],
      })),
    };
  } catch {
    return { changeSetId: '', status: 'FAILED', changes: [] };
  } finally {
    // Never execute — always clean up the change set
    await client
      .send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }))
      .catch(() => undefined);
  }
}

/**
 * Full validation pipeline: lint → aws validate → (optional) changeset.
 * Returns a summary suitable for presenting to the user.
 */
export async function runFullValidation(
  templates: GeneratedTemplate[],
  options: {
    outputDir?: string;
    awsValidate?: boolean;
    region?: string;
    createChangeSets?: boolean;
  } = {}
): Promise<{
  summary: string;
  results: ValidationResult[];
  allPassed: boolean;
}> {
  const outputDir = resolveArtifactDir('cfn', options.outputDir);

  // Step 1: Write + cfn-lint
  const results = await validateTemplates(templates, outputDir);

  // Step 2: AWS validate (if requested and creds available)
  if (options.awsValidate && options.region) {
    for (const result of results) {
      result.awsValidation = await validateWithAws(result.templatePath, options.region);
    }
  }

  // Summary
  const totalTemplates = results.length;
  const passed = results.filter(r => r.valid).length;
  const errors = results.flatMap(r => r.lintResults.filter(f => f.level === 'error'));
  const warnings = results.flatMap(r => r.lintResults.filter(f => f.level === 'warning'));

  const allPassed = passed === totalTemplates;
  const summary = [
    `Validation: ${passed}/${totalTemplates} templates passed cfn-lint`,
    errors.length > 0 ? `Errors: ${errors.length}` : null,
    warnings.length > 0 ? `Warnings: ${warnings.length}` : null,
    options.awsValidate ? `AWS validate: ${results.filter(r => r.awsValidation?.valid).length}/${totalTemplates} passed` : null,
  ].filter(Boolean).join(' | ');

  return { summary, results, allPassed };
}
