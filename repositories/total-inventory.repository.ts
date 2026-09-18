import type { TotalInventoryReport } from '../domain/resources/total-inventory.js';

/**
 * Repository abstraction for the "radar" total inventory report.
 * Same role as InfrastructureRepository, but for the broad-discovery pass —
 * lets migration-analysis-mcp (a separate process) read what aws-discovery-mcp
 * found, without re-querying Resource Explorer/Tagging API/Config.
 */
export interface TotalInventoryRepository {
  init?(): Promise<void>;
  close?(): Promise<void>;

  /** Persist (or replace) the most recent report for a region. */
  saveReport(report: TotalInventoryReport): Promise<void>;

  /** Retrieve the most recent report for a region, if any scan has run. */
  getReport(region: string): Promise<TotalInventoryReport | undefined>;
}

/** In-memory implementation — isolated per process (tests / ephemeral runs). */
export class InMemoryTotalInventoryRepository implements TotalInventoryRepository {
  private reports = new Map<string, TotalInventoryReport>();

  async saveReport(report: TotalInventoryReport): Promise<void> {
    this.reports.set(report.region, report);
  }

  async getReport(region: string): Promise<TotalInventoryReport | undefined> {
    return this.reports.get(region);
  }
}
