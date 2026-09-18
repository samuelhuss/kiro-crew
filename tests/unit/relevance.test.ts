import { classifyRelevance, classifyRadarItem, classifyResourceRelevance } from '../../domain/resources/relevance.js';
import type { AwsResource } from '../../domain/resources/resource.js';

describe('classifyRelevance', () => {
  it('flags AWS service-linked roles as NOISE', () => {
    const r = classifyRelevance({
      resourceType: 'AWS::IAM::Role',
      id: 'arn:aws:iam::123456789012:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS',
      name: 'AWSServiceRoleForECS',
    });
    expect(r.bucket).toBe('NOISE');
  });

  it('flags a regular user-created IAM role as CORE', () => {
    const r = classifyRelevance({
      resourceType: 'AWS::IAM::Role',
      id: 'arn:aws:iam::123456789012:role/app-execution-role',
      name: 'app-execution-role',
    });
    expect(r.bucket).toBe('CORE');
  });

  it('flags the default VPC as NOISE', () => {
    const r = classifyRelevance({
      resourceType: 'AWS::EC2::VPC',
      id: 'vpc-123',
      properties: { isDefault: true },
    });
    expect(r.bucket).toBe('NOISE');
  });

  it('flags a custom VPC as CORE', () => {
    const r = classifyRelevance({
      resourceType: 'AWS::EC2::VPC',
      id: 'vpc-456',
      properties: { isDefault: false },
    });
    expect(r.bucket).toBe('CORE');
  });

  it('flags the default security group as NOISE', () => {
    const r = classifyRelevance({
      resourceType: 'AWS::EC2::SecurityGroup',
      id: 'sg-123',
      name: 'default',
    });
    expect(r.bucket).toBe('NOISE');
  });

  it('flags a named custom security group as CORE', () => {
    const r = classifyRelevance({
      resourceType: 'AWS::EC2::SecurityGroup',
      id: 'sg-456',
      name: 'web-tier-sg',
    });
    expect(r.bucket).toBe('CORE');
  });

  it('flags the main route table as SUPPORTING', () => {
    const r = classifyRelevance({
      resourceType: 'AWS::EC2::RouteTable',
      id: 'rtb-123',
      properties: { isMain: true },
    });
    expect(r.bucket).toBe('SUPPORTING');
  });

  it('flags an auto-created untagged Lambda log group as SUPPORTING', () => {
    const r = classifyRelevance({
      resourceType: 'AWS::Logs::LogGroup',
      id: '/aws/lambda/my-function',
      name: '/aws/lambda/my-function',
    });
    expect(r.bucket).toBe('SUPPORTING');
  });

  it('keeps a tagged Lambda log group as CORE (custom tags override the auto-created rule)', () => {
    const r = classifyRelevance({
      resourceType: 'AWS::Logs::LogGroup',
      id: '/aws/lambda/my-function',
      name: '/aws/lambda/my-function',
      tags: { Application: 'checkout' },
    });
    expect(r.bucket).toBe('CORE');
  });

  it('defaults unmatched resource types to CORE, never hides silently', () => {
    const r = classifyRelevance({
      resourceType: 'AWS::DynamoDB::Table',
      id: 'orders-table',
    });
    expect(r.bucket).toBe('CORE');
    expect(r.reason).toBeTruthy();
  });
});

describe('classifyRadarItem', () => {
  it('recognizes a service-linked role from its ARN alone (no separate properties)', () => {
    const r = classifyRadarItem({
      arn: 'arn:aws:iam::123456789012:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS',
      resourceType: 'AWS::IAM::Role',
      region: 'us-east-1',
      tags: {},
      source: 'TAGGING_API',
    });
    expect(r.bucket).toBe('NOISE');
  });
});

describe('classifyResourceRelevance', () => {
  it('flags a Stage-1 collected default VPC as NOISE using its real properties', () => {
    const vpc: AwsResource = {
      id: 'vpc-123',
      arn: 'arn:aws:ec2:us-east-1:123456789012:vpc/vpc-123',
      type: 'AWS::EC2::VPC',
      name: '',
      region: 'us-east-1',
      accountId: '123456789012',
      properties: { isDefault: true },
      dependencies: [],
    };
    expect(classifyResourceRelevance(vpc).bucket).toBe('NOISE');
  });

  it('keeps a Stage-1 collected custom VPC as CORE', () => {
    const vpc: AwsResource = {
      id: 'vpc-456',
      arn: 'arn:aws:ec2:us-east-1:123456789012:vpc/vpc-456',
      type: 'AWS::EC2::VPC',
      name: 'app-vpc',
      region: 'us-east-1',
      accountId: '123456789012',
      properties: { isDefault: false },
      dependencies: [],
    };
    expect(classifyResourceRelevance(vpc).bucket).toBe('CORE');
  });
});
