import {
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeRouteTablesCommand,
  DescribeInternetGatewaysCommand,
  DescribeNatGatewaysCommand,
  DescribeSecurityGroupsCommand,
} from '@aws-sdk/client-ec2';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { AwsResource, ResourceScanError } from '../../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../../domain/relationships/relationship.js';
import { logResourceDiscovered, logDependencyDiscovered } from '../logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nameFromTags(tags?: any[]): string {
  return (tags ?? []).find((t: { Key?: string; Value?: string }) => t.Key === 'Name')?.Value ?? '';
}

export async function collectNetworkResources(
  ec2: EC2Client,
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

  // ── VPCs ────────────────────────────────────────────────────────────────────
  try {
    const { Vpcs = [] } = await ec2.send(new DescribeVpcsCommand({}));
    for (const vpc of Vpcs) {
      if (!vpc.VpcId) continue;
      const r: AwsResource = {
        id: vpc.VpcId,
        arn: `arn:aws:ec2:${region}:${accountId}:vpc/${vpc.VpcId}`,
        type: 'AWS::EC2::VPC',
        name: nameFromTags(vpc.Tags),
        region,
        accountId,
        properties: {
          cidrBlock: vpc.CidrBlock,
          isDefault: vpc.IsDefault,
          state: vpc.State,
          dhcpOptionsId: vpc.DhcpOptionsId,
          instanceTenancy: vpc.InstanceTenancy,
        },
        dependencies: [],
      };
      resources.push(r);
      logResourceDiscovered(region, r.type, r.id);
    }
  } catch (err) {
    errors.push({ resourceType: 'AWS::EC2::VPC', message: String(err), code: (err as { Code?: string }).Code });
  }

  // ── Subnets ──────────────────────────────────────────────────────────────────
  try {
    const { Subnets = [] } = await ec2.send(new DescribeSubnetsCommand({}));
    for (const subnet of Subnets) {
      if (!subnet.SubnetId) continue;
      const r: AwsResource = {
        id: subnet.SubnetId,
        arn: subnet.SubnetArn ?? `arn:aws:ec2:${region}:${accountId}:subnet/${subnet.SubnetId}`,
        type: 'AWS::EC2::Subnet',
        name: nameFromTags(subnet.Tags),
        region,
        accountId,
        properties: {
          cidrBlock: subnet.CidrBlock,
          availabilityZone: subnet.AvailabilityZone,
          availableIpAddressCount: subnet.AvailableIpAddressCount,
          mapPublicIpOnLaunch: subnet.MapPublicIpOnLaunch,
          defaultForAz: subnet.DefaultForAz,
          state: subnet.State,
        },
        dependencies: subnet.VpcId ? [subnet.VpcId] : [],
      };
      resources.push(r);
      logResourceDiscovered(region, r.type, r.id);
      if (subnet.VpcId) {
        const rel: ResourceRelationship = { source: subnet.SubnetId, target: subnet.VpcId, relationship: 'BELONGS_TO' };
        relationships.push(rel);
        logDependencyDiscovered(rel.source, rel.target, rel.relationship);
      }
    }
  } catch (err) {
    errors.push({ resourceType: 'AWS::EC2::Subnet', message: String(err), code: (err as { Code?: string }).Code });
  }

  // ── Route Tables ─────────────────────────────────────────────────────────────
  try {
    const { RouteTables = [] } = await ec2.send(new DescribeRouteTablesCommand({}));
    for (const rt of RouteTables) {
      if (!rt.RouteTableId) continue;
      const associatedSubnets = (rt.Associations ?? [])
        .map((a) => a.SubnetId)
        .filter((id): id is string => !!id);
      const r: AwsResource = {
        id: rt.RouteTableId,
        arn: `arn:aws:ec2:${region}:${accountId}:route-table/${rt.RouteTableId}`,
        type: 'AWS::EC2::RouteTable',
        name: nameFromTags(rt.Tags),
        region,
        accountId,
        properties: {
          associatedSubnets,
          routeCount: (rt.Routes ?? []).length,
          isMain: (rt.Associations ?? []).some((a) => a.Main),
        },
        dependencies: rt.VpcId ? [rt.VpcId] : [],
      };
      resources.push(r);
      logResourceDiscovered(region, r.type, r.id);
      for (const subnetId of associatedSubnets) {
        const rel: ResourceRelationship = { source: subnetId, target: rt.RouteTableId, relationship: 'ROUTES_THROUGH' };
        relationships.push(rel);
        logDependencyDiscovered(rel.source, rel.target, rel.relationship);
      }
    }
  } catch (err) {
    errors.push({ resourceType: 'AWS::EC2::RouteTable', message: String(err), code: (err as { Code?: string }).Code });
  }

  // ── Internet Gateways ────────────────────────────────────────────────────────
  try {
    const { InternetGateways = [] } = await ec2.send(new DescribeInternetGatewaysCommand({}));
    for (const igw of InternetGateways) {
      if (!igw.InternetGatewayId) continue;
      const attachedVpcs = (igw.Attachments ?? [])
        .map((a) => a.VpcId)
        .filter((id): id is string => !!id);
      const r: AwsResource = {
        id: igw.InternetGatewayId,
        arn: `arn:aws:ec2:${region}:${accountId}:internet-gateway/${igw.InternetGatewayId}`,
        type: 'AWS::EC2::InternetGateway',
        name: nameFromTags(igw.Tags),
        region,
        accountId,
        properties: { attachedVpcs },
        dependencies: attachedVpcs,
      };
      resources.push(r);
      logResourceDiscovered(region, r.type, r.id);
      for (const vpcId of attachedVpcs) {
        const rel: ResourceRelationship = { source: igw.InternetGatewayId, target: vpcId, relationship: 'ATTACHES_TO' };
        relationships.push(rel);
        logDependencyDiscovered(rel.source, rel.target, rel.relationship);
      }
    }
  } catch (err) {
    errors.push({ resourceType: 'AWS::EC2::InternetGateway', message: String(err), code: (err as { Code?: string }).Code });
  }

  // ── NAT Gateways ─────────────────────────────────────────────────────────────
  try {
    const { NatGateways = [] } = await ec2.send(
      new DescribeNatGatewaysCommand({ Filter: [{ Name: 'state', Values: ['available', 'pending'] }] })
    );
    for (const nat of NatGateways) {
      if (!nat.NatGatewayId) continue;
      const r: AwsResource = {
        id: nat.NatGatewayId,
        arn: `arn:aws:ec2:${region}:${accountId}:natgateway/${nat.NatGatewayId}`,
        type: 'AWS::EC2::NatGateway',
        name: nameFromTags(nat.Tags),
        region,
        accountId,
        properties: {
          state: nat.State,
          subnetId: nat.SubnetId,
          vpcId: nat.VpcId,
          connectivityType: nat.ConnectivityType,
          createTime: nat.CreateTime?.toISOString(),
        },
        dependencies: [nat.SubnetId, nat.VpcId].filter((id): id is string => !!id),
      };
      resources.push(r);
      logResourceDiscovered(region, r.type, r.id);
      if (nat.SubnetId) {
        const rel: ResourceRelationship = { source: nat.NatGatewayId, target: nat.SubnetId, relationship: 'RUNS_IN' };
        relationships.push(rel);
        logDependencyDiscovered(rel.source, rel.target, rel.relationship);
      }
    }
  } catch (err) {
    errors.push({ resourceType: 'AWS::EC2::NatGateway', message: String(err), code: (err as { Code?: string }).Code });
  }

  // ── Security Groups ──────────────────────────────────────────────────────────
  try {
    const { SecurityGroups = [] } = await ec2.send(new DescribeSecurityGroupsCommand({}));
    for (const sg of SecurityGroups) {
      if (!sg.GroupId) continue;
      const r: AwsResource = {
        id: sg.GroupId,
        arn: `arn:aws:ec2:${region}:${accountId}:security-group/${sg.GroupId}`,
        type: 'AWS::EC2::SecurityGroup',
        name: sg.GroupName ?? nameFromTags(sg.Tags),
        region,
        accountId,
        properties: {
          description: sg.Description,
          vpcId: sg.VpcId,
          ingressRuleCount: (sg.IpPermissions ?? []).length,
          egressRuleCount: (sg.IpPermissionsEgress ?? []).length,
        },
        dependencies: sg.VpcId ? [sg.VpcId] : [],
      };
      resources.push(r);
      logResourceDiscovered(region, r.type, r.id);
    }
  } catch (err) {
    errors.push({ resourceType: 'AWS::EC2::SecurityGroup', message: String(err), code: (err as { Code?: string }).Code });
  }

  return { resources, relationships, errors };
}
