import {
  Database,
  Connection,
  type KuzuValue,
} from 'kuzu';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AwsResource } from '../domain/resources/resource.js';
import type { ResourceRelationship } from '../domain/relationships/relationship.js';
import type { RegionInventory, InventoryStats } from '../domain/resources/inventory.js';
import type { InfrastructureRepository } from './infrastructure.repository.js';

/**
 * Kuzu-backed InfrastructureRepository.
 *
 * Schema
 * ──────
 * NODE TABLE Resource   — one node per AwsResource (id as primary key)
 * NODE TABLE RegionMeta — one node per scanned region (tracks scan metadata)
 * REL TABLE  DependsOn  — directed edge Resource → Resource with relationship type
 *
 * All properties are stored as strings or INT64 to avoid schema complexity.
 * JSON-serialised fields (properties, metadata) are stored as STRING.
 *
 * Data directory defaults to ./data/infrastructure.kuzu relative to cwd.
 * Override with KUZU_DATA_DIR env var.
 */
export class KuzuInfrastructureRepository implements InfrastructureRepository {
  private db!: Database;
  private conn!: Connection;
  private readonly dataDir: string;
  private initialised = false;

  constructor(dataDir?: string) {
    this.dataDir =
      dataDir ??
      process.env['KUZU_DATA_DIR'] ??
      join(process.cwd(), 'data', 'infrastructure.kuzu');
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Open (or create) the database and ensure the schema exists.
   * Idempotent — safe to call multiple times.
   */
  async init(): Promise<void> {
    if (this.initialised) return;
    // Create the PARENT directory — Kuzu creates the database path itself
    const parent = this.dataDir.includes('/') || this.dataDir.includes('\\')
      ? this.dataDir.split(/[/\\]/).slice(0, -1).join('/')
      : '.';
    if (parent && parent !== '.') {
      await mkdir(parent, { recursive: true });
    }
    this.db = new Database(this.dataDir);
    this.conn = new Connection(this.db);
    await this.ensureSchema();
    this.initialised = true;
  }

  async close(): Promise<void> {
    if (!this.initialised) return;
    await this.conn.close();
    await this.db.close();
    this.initialised = false;
  }

  // ── Schema ──────────────────────────────────────────────────────────────────

  private async ensureSchema(): Promise<void> {
    // Node: Resource
    await this.exec(`
      CREATE NODE TABLE IF NOT EXISTS Resource (
        id         STRING,
        arn        STRING,
        type       STRING,
        name       STRING,
        region     STRING,
        accountId  STRING,
        properties STRING,
        PRIMARY KEY (id)
      )
    `);

    // Node: RegionMeta (tracks scan state per region)
    await this.exec(`
      CREATE NODE TABLE IF NOT EXISTS RegionMeta (
        region      STRING,
        accountId   STRING,
        scannedAt   STRING,
        durationMs  INT64,
        statsJson   STRING,
        errorsJson  STRING,
        PRIMARY KEY (region)
      )
    `);

    // Rel: DependsOn (directed — source depends on target)
    await this.exec(`
      CREATE REL TABLE IF NOT EXISTS DependsOn (
        FROM Resource TO Resource,
        relationship STRING,
        metadata     STRING
      )
    `);
  }

  // ── InfrastructureRepository implementation ─────────────────────────────────

  async saveInventory(inventory: RegionInventory): Promise<void> {
    await this.init();

    // Upsert RegionMeta — MERGE works like upsert in Kuzu (match or create)
    await this.exec(`
      MERGE (m:RegionMeta {region: '${esc(inventory.region)}'})
      SET m.accountId  = '${esc(inventory.accountId)}',
          m.scannedAt  = '${esc(inventory.scannedAt)}',
          m.durationMs = ${inventory.stats.durationMs},
          m.statsJson  = '${esc(JSON.stringify(inventory.stats))}',
          m.errorsJson = '${esc(JSON.stringify(inventory.errors))}'
    `);

    // Upsert all resource nodes
    for (const resource of inventory.resources) {
      await this.exec(`
        MERGE (r:Resource {id: '${esc(resource.id)}'})
        SET r.arn        = '${esc(resource.arn)}',
            r.type       = '${esc(resource.type)}',
            r.name       = '${esc(resource.name)}',
            r.region     = '${esc(resource.region)}',
            r.accountId  = '${esc(resource.accountId)}',
            r.properties = '${esc(JSON.stringify(resource.properties))}'
      `);
    }

    // For relationships: delete old edges for this region's resources, then re-insert.
    // Kuzu does not support MERGE on rel tables directly, so we DELETE + CREATE.
    const regionResourceIds = inventory.resources.map((r) => `'${esc(r.id)}'`).join(', ');
    if (regionResourceIds.length > 0) {
      await this.exec(`
        MATCH (a:Resource)-[rel:DependsOn]->(b:Resource)
        WHERE a.region = '${esc(inventory.region)}'
        DELETE rel
      `);
    }

    for (const rel of inventory.relationships) {
      // Ensure both endpoints exist as nodes (may be from other regions)
      await this.exec(`
        MERGE (src:Resource {id: '${esc(rel.source)}'})
      `);
      await this.exec(`
        MERGE (tgt:Resource {id: '${esc(rel.target)}'})
      `);
      await this.exec(`
        MATCH (src:Resource {id: '${esc(rel.source)}'}),
              (tgt:Resource {id: '${esc(rel.target)}'})
        CREATE (src)-[:DependsOn {
          relationship: '${esc(rel.relationship)}',
          metadata:     '${esc(JSON.stringify(rel.metadata ?? {}))}'
        }]->(tgt)
      `);
    }
  }

  async getInventory(region: string): Promise<RegionInventory | undefined> {
    await this.init();

    // Load region meta
    const metaRows = await this.queryAll(
      `MATCH (m:RegionMeta {region: '${esc(region)}'}) RETURN m`
    );
    if (metaRows.length === 0) return undefined;

    const meta = metaRows[0]!['m'] as Record<string, KuzuValue>;
    const stats = JSON.parse(String(meta['statsJson'] ?? '{}')) as InventoryStats;
    const errors = JSON.parse(String(meta['errorsJson'] ?? '[]')) as RegionInventory['errors'];

    // Load all resources for the region
    const resourceRows = await this.queryAll(
      `MATCH (r:Resource {region: '${esc(region)}'}) RETURN r`
    );
    const resources = resourceRows.map((row) => nodeToResource(row['r'] as Record<string, KuzuValue>));

    // Load all relationships for these resources
    const relationships = await this.findRelationshipsForRegion(region);

    return {
      region,
      accountId: String(meta['accountId'] ?? ''),
      scannedAt: String(meta['scannedAt'] ?? ''),
      resources,
      relationships,
      errors,
      stats,
    };
  }

  async listRegions(): Promise<string[]> {
    await this.init();
    const rows = await this.queryAll(`MATCH (m:RegionMeta) RETURN m.region AS region`);
    return rows.map((r) => String(r['region'] ?? ''));
  }

  async findResource(id: string): Promise<AwsResource | undefined> {
    await this.init();
    const rows = await this.queryAll(
      `MATCH (r:Resource {id: '${esc(id)}'}) RETURN r`
    );
    if (rows.length === 0) return undefined;
    return nodeToResource(rows[0]!['r'] as Record<string, KuzuValue>);
  }

  async findRelationships(resourceId: string): Promise<ResourceRelationship[]> {
    await this.init();
    // Outgoing
    const out = await this.queryAll(`
      MATCH (src:Resource {id: '${esc(resourceId)}'})-[rel:DependsOn]->(tgt:Resource)
      RETURN src.id AS source, tgt.id AS target, rel.relationship AS relationship, rel.metadata AS metadata
    `);
    // Incoming
    const inc = await this.queryAll(`
      MATCH (src:Resource)-[rel:DependsOn]->(tgt:Resource {id: '${esc(resourceId)}'})
      RETURN src.id AS source, tgt.id AS target, rel.relationship AS relationship, rel.metadata AS metadata
    `);
    return [...out, ...inc].map(rowToRelationship);
  }

  async clearRegion(region: string): Promise<void> {
    await this.init();
    // Delete relationships first (Kuzu requires no dangling edges)
    await this.exec(`
      MATCH (r:Resource {region: '${esc(region)}'})-[rel:DependsOn]->()
      DELETE rel
    `);
    await this.exec(`
      MATCH ()-[rel:DependsOn]->(r:Resource {region: '${esc(region)}'})
      DELETE rel
    `);
    await this.exec(`
      MATCH (r:Resource {region: '${esc(region)}'}) DELETE r
    `);
    await this.exec(`
      MATCH (m:RegionMeta {region: '${esc(region)}'}) DELETE m
    `);
  }

  // ── Graph-specific queries ──────────────────────────────────────────────────

  /**
   * Find all resources reachable from a given resource up to `depth` hops.
   */
  async findReachable(
    resourceId: string,
    depth = 3
  ): Promise<{ id: string; type: string; name: string }[]> {
    await this.init();
    const rows = await this.queryAll(`
      MATCH (src:Resource {id: '${esc(resourceId)}'})-[:DependsOn*1..${depth}]->(dst:Resource)
      RETURN dst.id AS id, dst.type AS type, dst.name AS name
    `);
    return rows.map((r) => ({
      id: String(r['id'] ?? ''),
      type: String(r['type'] ?? ''),
      name: String(r['name'] ?? ''),
    }));
  }

  /**
   * Find resources with the most outgoing relationships (highest fan-out).
   * Useful for identifying critical hub resources.
   */
  async findHighDependencyResources(
    region: string,
    limit = 10
  ): Promise<{ id: string; name: string; type: string; outDegree: number }[]> {
    await this.init();
    const rows = await this.queryAll(`
      MATCH (r:Resource {region: '${esc(region)}'})-[rel:DependsOn]->()
      RETURN r.id AS id, r.name AS name, r.type AS type, COUNT(rel) AS outDegree
      ORDER BY outDegree DESC
      LIMIT ${limit}
    `);
    return rows.map((r) => ({
      id: String(r['id'] ?? ''),
      name: String(r['name'] ?? ''),
      type: String(r['type'] ?? ''),
      outDegree: Number(r['outDegree'] ?? 0),
    }));
  }

  /**
   * Find the shortest dependency path between two resources.
   */
  async findShortestPath(
    sourceId: string,
    targetId: string
  ): Promise<string[] | undefined> {
    await this.init();
    const rows = await this.queryAll(`
      MATCH p = shortestPath(
        (src:Resource {id: '${esc(sourceId)}'})-[:DependsOn*]->(dst:Resource {id: '${esc(targetId)}'})
      )
      RETURN nodes(p) AS pathNodes
      LIMIT 1
    `);
    if (rows.length === 0) return undefined;
    const pathNodes = rows[0]!['pathNodes'];
    if (!Array.isArray(pathNodes)) return undefined;
    return (pathNodes as Array<Record<string, unknown>>).map((n) => String((n as Record<string, unknown>)['id'] ?? ''));
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async exec(cypher: string): Promise<void> {
    const result = await this.conn.query(cypher);
    // query() can return a single QueryResult or an array
    const r = Array.isArray(result) ? result[0] : result;
    if (r) await r.getAll(); // consume to ensure execution
  }

  private async queryAll(cypher: string): Promise<Record<string, KuzuValue>[]> {
    const result = await this.conn.query(cypher);
    const r = Array.isArray(result) ? result[0] : result;
    if (!r) return [];
    return await r.getAll();
  }

  private async findRelationshipsForRegion(region: string): Promise<ResourceRelationship[]> {
    const rows = await this.queryAll(`
      MATCH (src:Resource {region: '${esc(region)}'})-[rel:DependsOn]->(tgt:Resource)
      RETURN src.id AS source, tgt.id AS target, rel.relationship AS relationship, rel.metadata AS metadata
    `);
    return rows.map(rowToRelationship);
  }
}

// ── Pure helpers (no class state) ─────────────────────────────────────────────

/** Escape single quotes in Cypher string literals */
function esc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Convert a Kuzu node row to an AwsResource */
function nodeToResource(node: Record<string, KuzuValue>): AwsResource {
  return {
    id: String(node['id'] ?? ''),
    arn: String(node['arn'] ?? ''),
    type: String(node['type'] ?? '') as AwsResource['type'],
    name: String(node['name'] ?? ''),
    region: String(node['region'] ?? ''),
    accountId: String(node['accountId'] ?? ''),
    properties: JSON.parse(String(node['properties'] ?? '{}')),
    dependencies: [],  // rebuilt from graph edges on demand
  };
}

/** Convert a query row to a ResourceRelationship */
function rowToRelationship(row: Record<string, KuzuValue>): ResourceRelationship {
  return {
    source: String(row['source'] ?? ''),
    target: String(row['target'] ?? ''),
    relationship: String(row['relationship'] ?? 'DEPENDS_ON') as ResourceRelationship['relationship'],
    metadata: JSON.parse(String(row['metadata'] ?? '{}')),
  };
}
