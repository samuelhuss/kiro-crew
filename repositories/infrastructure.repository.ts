import type { AwsResource } from '../domain/resources/resource.js';
import type { ResourceRelationship } from '../domain/relationships/relationship.js';
import type { RegionInventory } from '../domain/resources/inventory.js';

/**
 * Repository abstraction for persisted infrastructure state.
 * Current implementations: InMemoryInfrastructureRepository (tests),
 * KuzuInfrastructureRepository (embedded graph DB, file-backed).
 * Future: Amazon Neptune, Neo4j — same interface, drop-in swap.
 */
export interface InfrastructureRepository {
  /**
   * Optional lifecycle hook — open connections, ensure schema.
   * Implementations that need no setup may omit this.
   */
  init?(): Promise<void>;

  /**
   * Optional lifecycle hook — close connections, flush buffers.
   */
  close?(): Promise<void>;

  /** Persist (or replace) a full region inventory */
  saveInventory(inventory: RegionInventory): Promise<void>;

  /** Retrieve the most recent inventory for a region */
  getInventory(region: string): Promise<RegionInventory | undefined>;

  /** List all regions with a stored inventory */
  listRegions(): Promise<string[]>;

  /** Find a specific resource across all stored inventories */
  findResource(id: string): Promise<AwsResource | undefined>;

  /** Get all relationships where the resource is source or target */
  findRelationships(resourceId: string): Promise<ResourceRelationship[]>;

  /** Clear stored data for a region */
  clearRegion(region: string): Promise<void>;
}

/**
 * In-memory implementation — zero dependencies, zero persistence.
 * Replace with a real DB adapter when moving beyond the MVP.
 */
export class InMemoryInfrastructureRepository implements InfrastructureRepository {
  private readonly inventories = new Map<string, RegionInventory>();

  async saveInventory(inventory: RegionInventory): Promise<void> {
    this.inventories.set(inventory.region, inventory);
  }

  async getInventory(region: string): Promise<RegionInventory | undefined> {
    return this.inventories.get(region);
  }

  async listRegions(): Promise<string[]> {
    return Array.from(this.inventories.keys());
  }

  async findResource(id: string): Promise<AwsResource | undefined> {
    for (const inventory of this.inventories.values()) {
      const found = inventory.resources.find((r) => r.id === id || r.arn === id);
      if (found) return found;
    }
    return undefined;
  }

  async findRelationships(resourceId: string): Promise<ResourceRelationship[]> {
    const results: ResourceRelationship[] = [];
    for (const inventory of this.inventories.values()) {
      for (const rel of inventory.relationships) {
        if (rel.source === resourceId || rel.target === resourceId) {
          results.push(rel);
        }
      }
    }
    return results;
  }

  async clearRegion(region: string): Promise<void> {
    this.inventories.delete(region);
  }
}
