/**
 * Integration test — requires real AWS credentials.
 * Set environment variables before running:
 *
 *   export AWS_PROFILE=my-lab-profile
 *   # or
 *   export AWS_ACCESS_KEY_ID=...
 *   export AWS_SECRET_ACCESS_KEY=...
 *   export AWS_SESSION_TOKEN=...   (if using temporary creds)
 *
 * Run with:
 *   npm run test:integration
 *
 * All operations are READ-ONLY. No resources are created, modified, or deleted.
 */

import { scanRegion } from '../../infrastructure/aws/scanner.js';

const TEST_REGION = process.env['TEST_REGION'] ?? 'us-east-1';
const TIMEOUT_MS = 120_000; // 2 minutes — scanning all resource types takes time

// Skip if no AWS credentials are available
const hasCredentials =
  !!process.env['AWS_PROFILE'] ||
  (!!process.env['AWS_ACCESS_KEY_ID'] && !!process.env['AWS_SECRET_ACCESS_KEY']) ||
  !!process.env['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'] ||
  !!process.env['AWS_ROLE_ARN'];

const describeIf = hasCredentials ? describe : describe.skip;

describeIf('scan_region integration (READ-ONLY)', () => {
  it(
    `should scan region ${TEST_REGION} and return a valid inventory`,
    async () => {
      const inventory = await scanRegion(TEST_REGION);

      // Basic structure checks
      expect(inventory.region).toBe(TEST_REGION);
      expect(inventory.accountId).toMatch(/^\d{12}$/);
      expect(inventory.scannedAt).toBeTruthy();
      expect(typeof inventory.stats.totalResources).toBe('number');
      expect(typeof inventory.stats.durationMs).toBe('number');
      expect(inventory.stats.durationMs).toBeGreaterThan(0);
      expect(Array.isArray(inventory.resources)).toBe(true);
      expect(Array.isArray(inventory.relationships)).toBe(true);
      expect(Array.isArray(inventory.errors)).toBe(true);

      // All resources should have required fields
      for (const resource of inventory.resources) {
        expect(resource.id).toBeTruthy();
        expect(resource.type).toBeTruthy();
        expect(resource.region).toBeTruthy();
        expect(resource.accountId).toMatch(/^\d{12}$/);
        expect(Array.isArray(resource.dependencies)).toBe(true);
        expect(typeof resource.properties).toBe('object');
      }

      // All relationships should have valid fields
      for (const rel of inventory.relationships) {
        expect(rel.source).toBeTruthy();
        expect(rel.target).toBeTruthy();
        expect(rel.relationship).toBeTruthy();
      }

      // Log summary for manual inspection
      console.log('\n=== SCAN SUMMARY ===');
      console.log(`Region:        ${inventory.region}`);
      console.log(`Account:       ${inventory.accountId.replace(/\d{4}$/, '****')}`);
      console.log(`Resources:     ${inventory.stats.totalResources}`);
      console.log(`Relationships: ${inventory.stats.totalRelationships}`);
      console.log(`Errors:        ${inventory.stats.totalErrors}`);
      console.log(`Duration:      ${inventory.stats.durationMs}ms`);
      console.log('\nBy type:');
      for (const [type, count] of Object.entries(inventory.stats.byType)) {
        console.log(`  ${type}: ${count}`);
      }
      if (inventory.errors.length > 0) {
        console.log('\nPartial errors (scan continued):');
        for (const err of inventory.errors) {
          console.log(`  ${err.resourceType}: ${err.message.slice(0, 80)}`);
        }
      }
    },
    TIMEOUT_MS
  );

  it(
    'should handle a region with minimal resources without throwing',
    async () => {
      // This just verifies the scan doesn't crash on the target region
      const result = await scanRegion(TEST_REGION);
      expect(result).toBeDefined();
    },
    TIMEOUT_MS
  );
});

describe('scan_region validation (no credentials needed)', () => {
  it('should reject an invalid region immediately', async () => {
    await expect(scanRegion('not-a-region')).rejects.toThrow(/Invalid region format/);
  });
});
