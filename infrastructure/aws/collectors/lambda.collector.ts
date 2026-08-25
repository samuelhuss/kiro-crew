import { ListFunctionsCommand } from '@aws-sdk/client-lambda';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import type { AwsResource, ResourceScanError } from '../../../domain/resources/resource.js';
import type { ResourceRelationship } from '../../../domain/relationships/relationship.js';
import { logResourceDiscovered, logDependencyDiscovered } from '../logger.js';

export async function collectLambdaResources(
  lambda: LambdaClient,
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

  try {
    let marker: string | undefined;
    do {
      const resp = await lambda.send(
        new ListFunctionsCommand({ Marker: marker, MaxItems: 50 })
      );
      for (const fn of resp.Functions ?? []) {
        if (!fn.FunctionArn || !fn.FunctionName) continue;
        const deps: string[] = [];
        const rels: ResourceRelationship[] = [];

        // VPC config
        for (const subnetId of fn.VpcConfig?.SubnetIds ?? []) {
          deps.push(subnetId);
          rels.push({ source: fn.FunctionArn, target: subnetId, relationship: 'RUNS_IN' });
        }
        for (const sgId of fn.VpcConfig?.SecurityGroupIds ?? []) {
          deps.push(sgId);
          rels.push({ source: fn.FunctionArn, target: sgId, relationship: 'USES' });
        }

        // Execution role
        if (fn.Role) {
          deps.push(fn.Role);
          rels.push({ source: fn.FunctionArn, target: fn.Role, relationship: 'USES' });
        }

        const r: AwsResource = {
          id: fn.FunctionArn,
          arn: fn.FunctionArn,
          type: 'AWS::Lambda::Function',
          name: fn.FunctionName,
          region,
          accountId,
          properties: {
            runtime: fn.Runtime,
            handler: fn.Handler,
            memorySize: fn.MemorySize,
            timeout: fn.Timeout,
            lastModified: fn.LastModified,
            packageType: fn.PackageType,
            architectures: fn.Architectures,
            state: fn.State,
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
      marker = resp.NextMarker;
    } while (marker);
  } catch (err) {
    errors.push({ resourceType: 'AWS::Lambda::Function', message: String(err), code: (err as { Code?: string }).Code });
  }

  return { resources, relationships, errors };
}
