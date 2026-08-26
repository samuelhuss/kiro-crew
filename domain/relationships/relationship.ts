/**
 * Relationship model between AWS resources.
 * Designed to be stored as edges in a graph database (Neo4j, Neptune) in future phases.
 */
export type RelationshipType =
  | 'DEPENDS_ON'       // generic dependency
  | 'BELONGS_TO'       // subnet -> VPC, etc.
  | 'RUNS_IN'          // service/instance -> subnet
  | 'USES'             // service -> IAM role, security group, secret
  | 'TARGETS'          // ALB -> target group, ECS service -> target group
  | 'CONNECTS_TO'      // ECS service -> RDS
  | 'ATTACHES_TO'      // IGW -> VPC
  | 'ROUTES_THROUGH'   // subnet -> route table
  | 'ATTACHED_TO'      // EBS volume -> EC2 instance
  | 'ASSOCIATED_WITH'  // EIP -> instance/ENI
  | 'LOGS_FOR'         // CloudWatch log group -> Lambda function
  | 'EXPOSES';         // lambda -> function URL (future)

export interface ResourceRelationship {
  /** ID of the source resource */
  source: string;
  /** ID of the target resource */
  target: string;
  /** Semantic label for the edge */
  relationship: RelationshipType;
  /** Optional metadata (e.g. port, protocol) */
  metadata?: Record<string, unknown>;
}

/** Groups relationships by source resource */
export type RelationshipMap = Map<string, ResourceRelationship[]>;

/** Build or extend a RelationshipMap from a flat array */
export function buildRelationshipMap(
  relationships: ResourceRelationship[]
): RelationshipMap {
  const map: RelationshipMap = new Map();
  for (const rel of relationships) {
    const existing = map.get(rel.source) ?? [];
    existing.push(rel);
    map.set(rel.source, existing);
  }
  return map;
}
