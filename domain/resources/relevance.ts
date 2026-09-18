import type { RadarResourceItem, RelevanceBucket } from './total-inventory.js';
import type { AwsResource } from './resource.js';

/**
 * Relevance Rules — the DETERMINISTIC noise filter.
 *
 * An AWS account can easily have 1000+ resources where most are AWS-managed
 * scaffolding (service-linked roles, default VPCs, auto-created log groups),
 * not the actual workload. Deciding what matters is NOT left to the LLM's
 * judgment call — each rule here is a pure function over data actually
 * returned by AWS (name/type/tag patterns), same philosophy as
 * domain/migration/rules.ts: no guessing, no silent hiding.
 *
 * Default bucket is always CORE — a resource is only demoted to SUPPORTING or
 * NOISE when a rule confidently recognizes it as AWS-managed scaffolding.
 * Anything that doesn't match a rule stays CORE and visible.
 */

export interface RelevanceInput {
  resourceType: string;
  /** Physical id or ARN — whichever is available. */
  id: string;
  name?: string;
  tags?: Record<string, string>;
  /** Raw properties, when available (e.g. from a Stage-1 collector). */
  properties?: Record<string, unknown>;
}

export interface RelevanceResult {
  bucket: RelevanceBucket;
  reason: string;
}

type RelevanceRule = (input: RelevanceInput) => RelevanceResult | null;

const SERVICE_LINKED_ROLE = /^AWSServiceRoleFor/i;
const SERVICE_LINKED_PATH = /:role\/aws-service-role\//i;
const AUTO_LOG_GROUP = /^\/aws\/(lambda|ecs|rds|apigateway|codebuild|eks)\//i;

// ── Rule catalog (first match wins) ─────────────────────────────────────────

const RULES: RelevanceRule[] = [
  // AWS service-linked IAM roles — created and owned by AWS services, never
  // something a user would migrate or recreate by hand.
  (i) => {
    if (i.resourceType !== 'AWS::IAM::Role') return null;
    if (SERVICE_LINKED_ROLE.test(i.name ?? '') || SERVICE_LINKED_PATH.test(i.id)) {
      return { bucket: 'NOISE', reason: 'AWS service-linked role (auto-managed, not user infrastructure).' };
    }
    return null;
  },

  // Default VPC — created automatically in every region, not app-specific.
  (i) => {
    if (i.resourceType !== 'AWS::EC2::VPC') return null;
    if (i.properties?.['isDefault'] === true) {
      return { bucket: 'NOISE', reason: 'Default VPC created automatically by AWS.' };
    }
    return null;
  },

  // Default security group — always exists per VPC, rarely modified.
  (i) => {
    if (i.resourceType !== 'AWS::EC2::SecurityGroup') return null;
    if ((i.name ?? '').toLowerCase() === 'default') {
      return { bucket: 'NOISE', reason: 'Default security group (unmodified baseline, not app-specific).' };
    }
    return null;
  },

  // Main route table — required plumbing, not something to reason about per app.
  (i) => {
    if (i.resourceType !== 'AWS::EC2::RouteTable') return null;
    if (i.properties?.['isMain'] === true) {
      return { bucket: 'SUPPORTING', reason: 'Main route table — required networking plumbing, not app identity.' };
    }
    return null;
  },

  // Auto-created log groups (one per Lambda/ECS task/etc.) without custom tags —
  // still relevant to migrate, but not what defines a "workload".
  (i) => {
    if (i.resourceType !== 'AWS::Logs::LogGroup') return null;
    const hasCustomTags = Object.keys(i.tags ?? {}).length > 0;
    if (AUTO_LOG_GROUP.test(i.name ?? i.id) && !hasCustomTags) {
      return { bucket: 'SUPPORTING', reason: 'Auto-created log group with default settings, no custom tags.' };
    }
    return null;
  },
];

/**
 * Classify a single resource. Never returns null — falls back to CORE with an
 * explicit reason when no rule confidently recognizes it as scaffolding.
 */
export function classifyRelevance(input: RelevanceInput): RelevanceResult {
  for (const rule of RULES) {
    const result = rule(input);
    if (result) return result;
  }
  return { bucket: 'CORE', reason: 'No AWS-managed-scaffolding pattern matched — treated as workload resource.' };
}

/** Convenience wrapper for radar items (broad-discovery shape → RelevanceInput). */
export function classifyRadarItem(item: RadarResourceItem): RelevanceResult {
  return classifyRelevance({
    resourceType: item.resourceType,
    id: item.arn,
    name: item.arn.split(/[/:]/).pop(),
    tags: item.tags,
  });
}

/**
 * Convenience wrapper for Stage-1 collector resources — these carry real
 * `properties` (isDefault, isMain, etc.), so the scaffolding rules that key
 * off them (default VPC/SG, main route table) only ever fire from this path.
 * Radar-only items never have that data, so they can only be caught by the
 * name/tag-based rules (service-linked roles, auto-created log groups).
 */
export function classifyResourceRelevance(resource: AwsResource): RelevanceResult {
  return classifyRelevance({
    resourceType: resource.type,
    id: resource.id,
    name: resource.name,
    properties: resource.properties,
  });
}
