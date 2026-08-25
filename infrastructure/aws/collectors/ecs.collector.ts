import {
  ListClustersCommand,
  DescribeClustersCommand,
  ListServicesCommand,
  DescribeServicesCommand,
} from '@aws-sdk/client-ecs';
import type { ECSClient } from '@aws-sdk/client-ecs';
import type { AwsResource, ResourceScanError } from '../../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../../domain/relationships/relationship.js';
import { logResourceDiscovered, logDependencyDiscovered } from '../logger.js';

export async function collectEcsResources(
  ecs: ECSClient,
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

  // ── ECS Clusters ─────────────────────────────────────────────────────────────
  let clusterArns: string[] = [];
  try {
    const list = await ecs.send(new ListClustersCommand({}));
    clusterArns = list.clusterArns ?? [];
    if (clusterArns.length > 0) {
      const { clusters = [] } = await ecs.send(
        new DescribeClustersCommand({ clusters: clusterArns, include: ['SETTINGS', 'STATISTICS'] })
      );
      for (const cluster of clusters) {
        if (!cluster.clusterArn) continue;
        const r: AwsResource = {
          id: cluster.clusterArn,
          arn: cluster.clusterArn,
          type: 'AWS::ECS::Cluster',
          name: cluster.clusterName ?? '',
          region,
          accountId,
          properties: {
            status: cluster.status,
            runningTasksCount: cluster.runningTasksCount,
            pendingTasksCount: cluster.pendingTasksCount,
            activeServicesCount: cluster.activeServicesCount,
            registeredContainerInstancesCount: cluster.registeredContainerInstancesCount,
          },
          dependencies: [],
        };
        resources.push(r);
        logResourceDiscovered(region, r.type, r.id);
      }
    }
  } catch (err) {
    errors.push({ resourceType: 'AWS::ECS::Cluster', message: String(err), code: (err as { Code?: string }).Code });
  }

  // ── ECS Services ─────────────────────────────────────────────────────────────
  for (const clusterArn of clusterArns) {
    try {
      const { serviceArns = [] } = await ecs.send(
        new ListServicesCommand({ cluster: clusterArn })
      );
      if (serviceArns.length === 0) continue;

      // DescribeServices accepts max 10 per call
      for (let i = 0; i < serviceArns.length; i += 10) {
        const batch = serviceArns.slice(i, i + 10);
        const { services = [] } = await ecs.send(
          new DescribeServicesCommand({ cluster: clusterArn, services: batch })
        );
        for (const svc of services) {
          if (!svc.serviceArn) continue;

          const deps: string[] = [];
          const rels: ResourceRelationship[] = [];

          // IAM Task Role
          if (svc.taskDefinition) {
            // We store the task definition ARN as a property, not as a resource (out of scope for MVP)
          }

          // Load balancer targets
          for (const lb of svc.loadBalancers ?? []) {
            if (lb.targetGroupArn) {
              deps.push(lb.targetGroupArn);
              rels.push({ source: svc.serviceArn, target: lb.targetGroupArn, relationship: 'TARGETS' });
            }
          }

          // Network configuration — subnets and security groups
          const netConfig = svc.networkConfiguration?.awsvpcConfiguration;
          for (const subnetId of netConfig?.subnets ?? []) {
            deps.push(subnetId);
            rels.push({ source: svc.serviceArn, target: subnetId, relationship: 'RUNS_IN' });
          }
          for (const sgId of netConfig?.securityGroups ?? []) {
            deps.push(sgId);
            rels.push({ source: svc.serviceArn, target: sgId, relationship: 'USES' });
          }

          // Cluster relationship
          deps.push(clusterArn);
          rels.push({ source: svc.serviceArn, target: clusterArn, relationship: 'BELONGS_TO' });

          const r: AwsResource = {
            id: svc.serviceArn,
            arn: svc.serviceArn,
            type: 'AWS::ECS::Service',
            name: svc.serviceName ?? '',
            region,
            accountId,
            properties: {
              clusterArn,
              status: svc.status,
              desiredCount: svc.desiredCount,
              runningCount: svc.runningCount,
              pendingCount: svc.pendingCount,
              launchType: svc.launchType,
              taskDefinition: svc.taskDefinition,
              deploymentController: svc.deploymentController?.type,
              schedulingStrategy: svc.schedulingStrategy,
              createdAt: svc.createdAt?.toISOString(),
            },
            dependencies: [...new Set(deps)],
          };

          resources.push(r);
          for (const rel of rels) {
            relationships.push(rel);
            logDependencyDiscovered(rel.source, rel.target, rel.relationship);
          }
          logResourceDiscovered(region, r.type, r.id);
        }
      }
    } catch (err) {
      errors.push({
        resourceType: 'AWS::ECS::Service',
        message: `cluster ${clusterArn}: ${String(err)}`,
        code: (err as { Code?: string }).Code,
      });
    }
  }

  return { resources, relationships, errors };
}
