import type { EdgeType } from './edge.js';

/**
 * Graph consistency issues.
 *
 * The builder NEVER makes silent assumptions. Whenever a relationship cannot be
 * determined safely, or the data is inconsistent, it is recorded here so callers
 * can decide how to react. None of these are fatal to graph construction.
 */
export type GraphIssueSeverity = 'error' | 'warning' | 'info';

export type GraphIssueKind =
  | 'DANGLING_EDGE' // edge references a node that does not exist
  | 'DUPLICATE_NODE' // same node id appeared more than once
  | 'DUPLICATE_EDGE' // same source|type|target appeared more than once
  | 'INVALID_RELATIONSHIP' // edge type is not part of the known vocabulary
  | 'INVALID_ARN' // node arn does not look like a valid ARN
  | 'CROSS_REGION' // edge connects resources in different regions
  | 'CROSS_ACCOUNT' // edge connects resources in different accounts
  | 'UNEXPECTED_CYCLE' // a cycle in a relationship that should be acyclic
  | 'ORPHAN_NODE' // node participates in no edge
  | 'UNKNOWN_RELATIONSHIP'; // relationship could not be determined from data

export interface GraphIssue {
  kind: GraphIssueKind;
  severity: GraphIssueSeverity;
  message: string;
  /** node ids or edge endpoints involved, for traceability */
  subjects: string[];
  relationship?: EdgeType | string;
}

export function issue(
  kind: GraphIssueKind,
  severity: GraphIssueSeverity,
  message: string,
  subjects: string[],
  relationship?: EdgeType | string
): GraphIssue {
  return { kind, severity, message, subjects, ...(relationship ? { relationship } : {}) };
}
