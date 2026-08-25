import type { ResourceType } from '../resources/resource.js';

/**
 * Graph node model — a single infrastructure resource as a vertex in the graph.
 *
 * A node is derived directly from a normalized AwsResource produced by the
 * Discovery layer. The graph domain NEVER talks to AWS APIs; it only consumes
 * the inventory. This keeps the separation of responsibilities intact:
 *
 *   AWS → Discovery → Inventory → Graph Builder → Infrastructure Graph
 */
export interface GraphNode {
  /** provider-native unique identifier (also the graph key) */
  id: string;
  /** full ARN when available; empty string when the service exposes none */
  arn: string;
  /** CloudFormation-style resource type */
  type: ResourceType;
  /** human-readable name */
  name: string;
  /** AWS region ('global' for IAM) */
  region: string;
  /** 12-digit AWS account id */
  accountId: string;
  /** raw properties sourced from the AWS API response (never fabricated) */
  properties: Record<string, unknown>;
}

/** Stable key used for node deduplication. */
export function nodeKey(node: Pick<GraphNode, 'id'>): string {
  return node.id;
}
