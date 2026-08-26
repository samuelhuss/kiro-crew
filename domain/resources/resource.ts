/**
 * Normalized AWS resource model.
 * Properties come exclusively from AWS API responses — never fabricated.
 */
export type ResourceType =
  | 'AWS::EC2::VPC'
  | 'AWS::EC2::Subnet'
  | 'AWS::EC2::RouteTable'
  | 'AWS::EC2::InternetGateway'
  | 'AWS::EC2::NatGateway'
  | 'AWS::EC2::SecurityGroup'
  | 'AWS::EC2::Instance'
  | 'AWS::EC2::Volume'
  | 'AWS::EC2::EIP'
  | 'AWS::ECS::Cluster'
  | 'AWS::ECS::Service'
  | 'AWS::ElasticLoadBalancingV2::LoadBalancer'
  | 'AWS::ElasticLoadBalancingV2::TargetGroup'
  | 'AWS::RDS::DBInstance'
  | 'AWS::RDS::DBCluster'
  | 'AWS::S3::Bucket'
  | 'AWS::Lambda::Function'
  | 'AWS::IAM::Role'
  | 'AWS::SecretsManager::Secret'
  | 'AWS::Logs::LogGroup'
  | 'AWS::Route53::HostedZone'
  | 'AWS::DynamoDB::Table'
  | 'AWS::ECR::Repository'
  | 'AWS::SQS::Queue'
  | 'AWS::SNS::Topic'
  | 'AWS::ElastiCache::CacheCluster'
  | 'AWS::CloudFront::Distribution';

export interface AwsResource {
  /** Provider-native unique identifier (e.g. VPC ID, ARN, bucket name) */
  id: string;
  /** Full ARN when available; empty string if the service does not expose one */
  arn: string;
  /** CloudFormation-style type string */
  type: ResourceType;
  /** Human-readable name (from Name tag or display field) */
  name: string;
  /** AWS region where the resource lives */
  region: string;
  /** 12-digit AWS account ID */
  accountId: string;
  /**
   * Raw properties sourced directly from the AWS API response.
   * Keys / values are not invented — they reflect exactly what the SDK returns.
   */
  properties: Record<string, unknown>;
  /** IDs of resources this resource directly depends on */
  dependencies: string[];
}

/** Lightweight summary returned as part of a scan inventory */
export interface ResourceSummary {
  id: string;
  type: ResourceType;
  name: string;
  arn: string;
  dependencyCount: number;
}

/** A scan error for a specific resource type — never fatal to the overall scan */
export interface ResourceScanError {
  resourceType: ResourceType;
  message: string;
  code?: string;
}
