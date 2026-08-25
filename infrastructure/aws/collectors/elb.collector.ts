import {
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import type { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import type { AwsResource, ResourceScanError } from '../../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../../domain/relationships/relationship.js';
import { logResourceDiscovered, logDependencyDiscovered } from '../logger.js';

export async function collectElbResources(
  elbv2: ElasticLoadBalancingV2Client,
  region: string,
  accountId: string
): Promise<{
  resources: AwsResource[];
  relationships: ResourceRelationship[];
  errors: ResourceScanError[];
}> {
  const resources: AwsResource[] = [];
  const relationships: ResourceRelationship[] = [];
  const errors: ResourceScanError[] = [];

  // ── Load Balancers ────────────────────────────────────────────────────────────
  try {
    const { LoadBalancers = [] } = await elbv2.send(new DescribeLoadBalancersCommand({}));
    for (const lb of LoadBalancers) {
      if (!lb.LoadBalancerArn) continue;
      const subnetIds = (lb.AvailabilityZones ?? [])
        .map((az) => az.SubnetId)
        .filter((id): id is string => !!id);
      const sgIds = lb.SecurityGroups ?? [];
      const deps = [...subnetIds, ...sgIds];

      const r: AwsResource = {
        id: lb.LoadBalancerArn,
        arn: lb.LoadBalancerArn,
        type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        name: lb.LoadBalancerName ?? '',
        region,
        accountId,
        properties: {
          type: lb.Type,
          scheme: lb.Scheme,
          state: lb.State?.Code,
          vpcId: lb.VpcId,
          dnsName: lb.DNSName,
          createdTime: lb.CreatedTime?.toISOString(),
          ipAddressType: lb.IpAddressType,
        },
        dependencies: [...new Set(deps)],
      };
      resources.push(r);
      logResourceDiscovered(region, r.type, r.id);

      for (const subnetId of subnetIds) {
        const rel: ResourceRelationship = { source: lb.LoadBalancerArn, target: subnetId, relationship: 'RUNS_IN' };
        relationships.push(rel);
        logDependencyDiscovered(rel.source, rel.target, rel.relationship);
      }
      for (const sgId of sgIds) {
        const rel: ResourceRelationship = { source: lb.LoadBalancerArn, target: sgId, relationship: 'USES' };
        relationships.push(rel);
        logDependencyDiscovered(rel.source, rel.target, rel.relationship);
      }
    }
  } catch (err) {
    errors.push({ resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', message: String(err), code: (err as { Code?: string }).Code });
  }

  // ── Target Groups ─────────────────────────────────────────────────────────────
  try {
    const { TargetGroups = [] } = await elbv2.send(new DescribeTargetGroupsCommand({}));
    for (const tg of TargetGroups) {
      if (!tg.TargetGroupArn) continue;
      const lbArns = tg.LoadBalancerArns ?? [];
      const r: AwsResource = {
        id: tg.TargetGroupArn,
        arn: tg.TargetGroupArn,
        type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        name: tg.TargetGroupName ?? '',
        region,
        accountId,
        properties: {
          protocol: tg.Protocol,
          port: tg.Port,
          targetType: tg.TargetType,
          vpcId: tg.VpcId,
          healthCheckProtocol: tg.HealthCheckProtocol,
          healthCheckPath: tg.HealthCheckPath,
          healthCheckPort: tg.HealthCheckPort,
        },
        dependencies: lbArns,
      };
      resources.push(r);
      logResourceDiscovered(region, r.type, r.id);

      for (const lbArn of lbArns) {
        const rel: ResourceRelationship = { source: lbArn, target: tg.TargetGroupArn, relationship: 'TARGETS' };
        relationships.push(rel);
        logDependencyDiscovered(rel.source, rel.target, rel.relationship);
      }
    }
  } catch (err) {
    errors.push({ resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup', message: String(err), code: (err as { Code?: string }).Code });
  }

  return { resources, relationships, errors };
}
