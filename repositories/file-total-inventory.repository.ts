import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TotalInventoryReport } from '../domain/resources/total-inventory.js';
import type { TotalInventoryRepository } from './total-inventory.repository.js';
import { resolveArtifactDir } from '../infrastructure/run/run-context.js';

/**
 * File-backed TotalInventoryRepository — same atomic temp-file+rename pattern
 * as FileInfrastructureRepository/FileGraphRepository: many readers, one
 * atomic writer, no exclusive lock. Layout: one JSON document at
 * `<dir>/total-inventory.json` holding a map of region → TotalInventoryReport.
 */
export class FileTotalInventoryRepository implements TotalInventoryRepository {
  private readonly dirOverride: string | undefined;

  constructor(dir?: string) {
    this.dirOverride = dir;
  }

  private get filePath(): string {
    const baseDir = resolveArtifactDir('inventory', this.dirOverride ?? process.env['TOTAL_INVENTORY_DIR']);
    return /\.json$/i.test(baseDir) ? baseDir : join(baseDir, 'total-inventory.json');
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
  }

  async close(): Promise<void> {
    // Nothing to close — no persistent handle, no lock.
  }

  private async readAll(): Promise<Record<string, TotalInventoryReport>> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, TotalInventoryReport>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  private async writeAll(data: Record<string, TotalInventoryReport>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }

  async saveReport(report: TotalInventoryReport): Promise<void> {
    const all = await this.readAll();
    all[report.region] = report;
    await this.writeAll(all);
  }

  async getReport(region: string): Promise<TotalInventoryReport | undefined> {
    const all = await this.readAll();
    return all[region];
  }
}
