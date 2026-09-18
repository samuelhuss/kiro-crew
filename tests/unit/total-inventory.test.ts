/**
 * Unit tests for the Total Inventory ("radar") pipeline:
 * broad discovery (Resource Explorer + Tagging API fallback) and
 * AWS Config enrichment. Same mock-the-SDK-client pattern as collectors.test.ts.
 */
import { collectTotalInventory, guessTypeFromArn } from '../../infrastructure/aws/collectors/total-inventory.collector.js';
import { enrichWithAwsConfig } from '../../infrastructure/aws/collectors/config-enrichment.collector.js';
import type { RadarResourceItem } from '../../domain/resources/total-inventory.js';

const REGION = 'us-east-1';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockClient(responses: Record<string, unknown>): any {
  return {
    send: (cmd: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const name = cmd.constructor.name;
      if (responses[name] instanceof Error) throw responses[name];
      return Promise.resolve(responses[name] ?? {});
    },
  };
}

describe('collectTotalInventory', () => {
  it('uses Resource Explorer when it succeeds', async () => {
    const explorer = mockClient({
      SearchCommand: {
        Resources: [
          { Arn: 'arn:aws:events:us-east-1:123456789012:rule/my-rule', ResourceType: 'events:rule', Region: REGION },
        ],
        NextToken: undefined,
      },
    });
    const tagging = mockClient({});

    const result = await collectTotalInventory(explorer, tagging, REGION);

    expect(result.source).toBe('RESOURCE_EXPLORER');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.arn).toBe('arn:aws:events:us-east-1:123456789012:rule/my-rule');
  });

  it('falls back to the Tagging API when Resource Explorer is not enabled', async () => {
    const explorer = mockClient({ SearchCommand: new Error('ResourceNotFoundException: no default view') });
    const tagging = mockClient({
      GetResourcesCommand: {
        ResourceTagMappingList: [
          { ResourceARN: 'arn:aws:s3:::my-bucket', Tags: [{ Key: 'Application', Value: 'checkout' }] },
        ],
        PaginationToken: '',
      },
    });

    const result = await collectTotalInventory(explorer, tagging, REGION);

    expect(result.source).toBe('TAGGING_API');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.tags).toEqual({ Application: 'checkout' });
  });
});

describe('guessTypeFromArn', () => {
  it('maps known ARN patterns to a CFN-style type', () => {
    expect(guessTypeFromArn('arn:aws:events:us-east-1:123456789012:rule/my-rule')).toBe('AWS::Events::Rule');
    expect(guessTypeFromArn('arn:aws:ssm:us-east-1:123456789012:parameter/my-param')).toBe('AWS::SSM::Parameter');
  });

  it('returns null for unrecognized ARN patterns', () => {
    expect(guessTypeFromArn('arn:aws:some-unknown-service:us-east-1:123456789012:thing/x')).toBeNull();
  });
});

describe('enrichWithAwsConfig', () => {
  const baseItem: RadarResourceItem = {
    arn: 'arn:aws:events:us-east-1:123456789012:rule/my-rule',
    resourceType: 'AWS::Events::Rule',
    region: REGION,
    tags: {},
    source: 'RESOURCE_EXPLORER',
  };

  it('marks a resource FIDELITY_VIA_CONFIG when AWS Config has it', async () => {
    const config = mockClient({
      BatchGetResourceConfigCommand: {
        baseConfigurationItems: [{ resourceType: 'AWS::Events::Rule', resourceId: 'my-rule' }],
      },
    });

    const [result] = await enrichWithAwsConfig([baseItem], config);

    expect(result!.fidelity).toBe('FIDELITY_VIA_CONFIG');
  });

  it('marks a resource RADAR_ONLY when AWS Config does not track it', async () => {
    const config = mockClient({
      BatchGetResourceConfigCommand: { baseConfigurationItems: [] },
    });

    const [result] = await enrichWithAwsConfig([baseItem], config);

    expect(result!.fidelity).toBe('RADAR_ONLY');
  });

  it('marks the whole batch RADAR_ONLY when the Config call fails (not recording)', async () => {
    const config = mockClient({
      BatchGetResourceConfigCommand: new Error('AWS Config is not recording in this region'),
    });

    const [result] = await enrichWithAwsConfig([baseItem], config);

    expect(result!.fidelity).toBe('RADAR_ONLY');
    expect(result!.fidelityReason).toMatch(/lookup failed/i);
  });

  it('marks unresolvable ARNs RADAR_ONLY without calling AWS Config', async () => {
    let called = false;
    const config = { send: () => { called = true; return Promise.resolve({}); } };
    const unresolvable: RadarResourceItem = {
      arn: 'arn:aws:some-unknown-service:us-east-1:123456789012:thing/x',
      resourceType: 'unknown',
      region: REGION,
      tags: {},
      source: 'TAGGING_API',
    };

    const [result] = await enrichWithAwsConfig([unresolvable], config as never);

    expect(called).toBe(false);
    expect(result!.fidelity).toBe('RADAR_ONLY');
  });
});
