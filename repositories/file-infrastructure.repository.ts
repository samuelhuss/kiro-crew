import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AwsResource } from '../domain/resources/resource.js';
import type { ResourceRelationship } from '../domain/relationships/relationship.js';
import type { RegionInventory } from '../domain/resources/inventory.js';
import type { InfrastructureRepository } from './infrastructure.repository.js';

/**
 * File-backed InfrastructureRepository — the SHARED inventory store.
 *
 * Why not Kuzu here: the embedded Kuzu store takes an EXCLUSIVE lock on its
 * directory for the whole life of the process holding it open, so two pipeline
 * MCP servers (discovery + graph) pointing at the same directory cannot both
 * run — the second dies at startup with "Could not set lock". Opening/closing
 * Kuzu per operation avoids the lock but segfaults the native addon after many
 * cycles in a long-lived server. A plain JSON file has neither problem: many
 * readers, atomic single-writer, no native lock.
 *
 * Layout: one JSON document at `<dir>/inventory.json` holding a map of
 * region → RegionInventory. Writes are atomic (temp file + rename).
 */
export class FileInfrastructureRepository implements InfrastructureRepository {
  private readonly filePath: string;

  constructor(dir?: string) {
    const baseDir =
      dir ??
      process.env['INVENTORY_DIR'] ??
      process.env['KUZU_INVENTORY_DIR'] ??
      process.env['KUZU_DATA_DIR'] ??
      join(process.cwd(), 'data');
    // If the configured path looks like a Kuzu DB dir/file, store the JSON
    // alongside it under a stable, unambiguous name.
    this.filePath = /\.json$/i.test(baseDir) ? baseDir : join(baseDir, 'inventory.json');
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
  }

  async close(): Promise<void> {
    // Nothing to close — no persistent handle, no lock.
  }

  // ── Persistence helpers ───────────────────────────────────────────────────────

  private async readAll(): Promise<Record<string, RegionInventory>> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, RegionInventory>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  private async writeAll(data: Record<string, RegionInventory>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    // Atomic write: write to a temp file then rename over the target.
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }

  // ── InfrastructureRepository implementation ─────────────────────────────────

  async saveInventory(inventory: RegionInventory): Promise<void> {
    const all = await this.readAll();
    all[inventory.region] = inventory;
    await this.writeAll(all);
  }

  async getInventory(region: string): Promise<RegionInventory | undefined> {
    const all = await this.readAll();
    return all[region];
  }

  async listRegions(): Promise<string[]> {
    const all = await this.readAll();
    return Object.keys(all);
  }

  async findResource(id: string): Promise<AwsResource | undefined> {
    const all = await this.readAll();
    for (const inventory of Object.values(all)) {
      const found = inventory.resources.find((r) => r.id === id || r.arn === id);
      if (found) return found;
    }
    return undefined;
  }

  async findRelationships(resourceId: string): Promise<ResourceRelationship[]> {
    const all = await this.readAll();
    const results: ResourceRelationship[] = [];
    for (const inventory of Object.values(all)) {
      for (const rel of inventory.relationships) {
        if (rel.source === resourceId || rel.target === resourceId) {
          results.push(rel);
        }
      }
    }
    return results;
  }

  async clearRegion(region: string): Promise<void> {
    const all = await this.readAll();
    if (region in all) {
      delete all[region];
      await this.writeAll(all);
    }
  }
}
