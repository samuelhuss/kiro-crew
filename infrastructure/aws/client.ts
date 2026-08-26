import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { EC2Client } from '@aws-sdk/client-ec2';
import { ECSClient } from '@aws-sdk/client-ecs';
import {
  ElasticLoadBalancingV2Client,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { RDSClient } from '@aws-sdk/client-rds';
import { S3Client } from '@aws-sdk/client-s3';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { IAMClient } from '@aws-sdk/client-iam';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { Route53Client } from '@aws-sdk/client-route-53';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ECRClient } from '@aws-sdk/client-ecr';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SNSClient } from '@aws-sdk/client-sns';
import { ElastiCacheClient } from '@aws-sdk/client-elasticache';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { logger } from './logger.js';

/**
 * All AWS clients are initialized with the standard SDK credential chain:
 *   1. Environment variables (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)
 *   2. ~/.aws/credentials profile (AWS_PROFILE)
 *   3. IAM instance profile / ECS task role / Lambda execution role
 *   4. AWS SSO / Web Identity Token
 *
 * NO credentials are hardcoded. NO write permissions are requested.
 */

export interface AwsClientSet {
  ec2: EC2Client;
  ecs: ECSClient;
  elbv2: ElasticLoadBalancingV2Client;
  rds: RDSClient;
  s3: S3Client;
  lambda: LambdaClient;
  iam: IAMClient;
  secretsManager: SecretsManagerClient;
  cloudwatchLogs: CloudWatchLogsClient;
  route53: Route53Client;
  dynamodb: DynamoDBClient;
  ecr: ECRClient;
  sqs: SQSClient;
  sns: SNSClient;
  elasticache: ElastiCacheClient;
  cloudfront: CloudFrontClient;
  sts: STSClient;
}

/** Cache clients per region to avoid re-initialising on every tool call */
const clientCache = new Map<string, AwsClientSet>();

export function getClients(region: string): AwsClientSet {
  const cached = clientCache.get(region);
  if (cached) return cached;

  const config = { region };

  const clients: AwsClientSet = {
    ec2: new EC2Client(config),
    ecs: new ECSClient(config),
    elbv2: new ElasticLoadBalancingV2Client(config),
    rds: new RDSClient(config),
    // S3 is global but bucket operations are region-specific
    s3: new S3Client({ region }),
    lambda: new LambdaClient(config),
    // IAM is a global service — region is ignored but required by SDK
    iam: new IAMClient({ region: 'us-east-1' }),
    secretsManager: new SecretsManagerClient(config),
    cloudwatchLogs: new CloudWatchLogsClient(config),
    // Route53 is global — region is required by SDK but unused
    route53: new Route53Client({ region: 'us-east-1' }),
    dynamodb: new DynamoDBClient(config),
    ecr: new ECRClient(config),
    sqs: new SQSClient(config),
    sns: new SNSClient(config),
    elasticache: new ElastiCacheClient(config),
    // CloudFront is global
    cloudfront: new CloudFrontClient({ region: 'us-east-1' }),
    sts: new STSClient(config),
  };

  clientCache.set(region, clients);
  return clients;
}

/**
 * Resolve the AWS account ID for the current caller.
 * Throws if no valid credentials are configured.
 */
export async function resolveAccountId(region: string): Promise<string> {
  const { sts } = getClients(region);
  const command = new GetCallerIdentityCommand({});
  const response = await sts.send(command);
  const accountId = response.Account;
  if (!accountId) {
    throw new Error('Could not resolve AWS account ID from STS GetCallerIdentity');
  }
  logger.debug('Resolved AWS account', { accountId: accountId.replace(/\d{4}$/, '****') });
  return accountId;
}

/** Validate that a region string looks plausible before calling AWS */
export function validateRegion(region: string): void {
  const VALID_REGION = /^[a-z]{2,3}-[a-z]+-\d$/;
  if (!VALID_REGION.test(region)) {
    throw new Error(
      `Invalid region format: "${region}". Expected format: us-east-1, eu-west-2, ap-southeast-1, etc.`
    );
  }
}
