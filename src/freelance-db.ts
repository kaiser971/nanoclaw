/**
 * Freelance offers database layer.
 * Extends the NanoClaw SQLite DB with freelance_* tables.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';
import type {
  FreelanceOffer,
  OfferStatus,
  ScrapedOffer,
} from './scrapers/types.js';

let db: Database.Database;
let initialized = false;

export function initFreelanceDb(): void {
  if (initialized) return;

  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  createFreelanceSchema(db);
  initialized = true;
}

/** @internal - for tests only. */
export function _initFreelanceTestDb(database: Database.Database): void {
  db = database;
  createFreelanceSchema(db);
  initialized = true;
}

function createFreelanceSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS freelance_offers (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      buyer TEXT,
      location TEXT,
      tjm_min REAL,
      tjm_max REAL,
      skills TEXT,
      offer_type TEXT NOT NULL DEFAULT 'freelance',
      url TEXT,
      deadline TEXT,
      date_published TEXT,
      date_scraped TEXT NOT NULL,
      raw_data TEXT,
      relevance_score REAL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'new',
      UNIQUE(platform, platform_id)
    );
    CREATE INDEX IF NOT EXISTS idx_fl_offers_status ON freelance_offers(status);
    CREATE INDEX IF NOT EXISTS idx_fl_offers_platform ON freelance_offers(platform);
    CREATE INDEX IF NOT EXISTS idx_fl_offers_score ON freelance_offers(relevance_score DESC);
    CREATE INDEX IF NOT EXISTS idx_fl_offers_date ON freelance_offers(date_scraped DESC);
  `);

  // Future migration: Tier 2 score column
  try {
    database.exec(
      `ALTER TABLE freelance_offers ADD COLUMN relevance_score_t2 REAL`,
    );
  } catch {
    /* column already exists */
  }
}

// --- Helpers ---

function makeId(platform: string, platformId: string): string {
  return `${platform}_${platformId}`;
}

function offerToRow(offer: ScrapedOffer, dateScraped: string) {
  return {
    id: makeId(offer.platform, offer.platformId),
    platform: offer.platform,
    platform_id: offer.platformId,
    title: offer.title,
    description: offer.description ?? null,
    buyer: offer.buyer ?? null,
    location: offer.location ?? null,
    tjm_min: offer.tjmMin ?? null,
    tjm_max: offer.tjmMax ?? null,
    skills: offer.skills ? JSON.stringify(offer.skills) : null,
    offer_type: offer.offerType,
    url: offer.url,
    deadline: offer.deadline ?? null,
    date_published: offer.datePublished ?? null,
    date_scraped: dateScraped,
    raw_data: offer.rawData ? JSON.stringify(offer.rawData) : null,
  };
}

function rowToOffer(row: Record<string, unknown>): FreelanceOffer {
  return {
    id: row.id as string,
    platform: row.platform as string,
    platformId: row.platform_id as string,
    title: row.title as string,
    description: (row.description as string) ?? undefined,
    buyer: (row.buyer as string) ?? undefined,
    location: (row.location as string) ?? undefined,
    tjmMin: (row.tjm_min as number) ?? undefined,
    tjmMax: (row.tjm_max as number) ?? undefined,
    skills: row.skills ? JSON.parse(row.skills as string) : undefined,
    offerType: row.offer_type as FreelanceOffer['offerType'],
    url: row.url as string,
    deadline: (row.deadline as string) ?? undefined,
    datePublished: (row.date_published as string) ?? undefined,
    dateScraped: row.date_scraped as string,
    rawData: row.raw_data ? JSON.parse(row.raw_data as string) : undefined,
    relevanceScore: (row.relevance_score as number) ?? 0,
    relevanceScoreT2: (row.relevance_score_t2 as number) ?? undefined,
    status: row.status as OfferStatus,
  };
}

// --- CRUD ---

export function insertOffer(offer: ScrapedOffer): boolean {
  const row = offerToRow(offer, new Date().toISOString());
  try {
    db.prepare(
      `INSERT INTO freelance_offers
       (id, platform, platform_id, title, description, buyer, location,
        tjm_min, tjm_max, skills, offer_type, url, deadline,
        date_published, date_scraped, raw_data)
       VALUES (@id, @platform, @platform_id, @title, @description, @buyer,
        @location, @tjm_min, @tjm_max, @skills, @offer_type, @url,
        @deadline, @date_published, @date_scraped, @raw_data)`,
    ).run(row);
    return true;
  } catch {
    // Duplicate — already exists
    return false;
  }
}

export function upsertOffers(offers: ScrapedOffer[]): number {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO freelance_offers
     (id, platform, platform_id, title, description, buyer, location,
      tjm_min, tjm_max, skills, offer_type, url, deadline,
      date_published, date_scraped, raw_data)
     VALUES (@id, @platform, @platform_id, @title, @description, @buyer,
      @location, @tjm_min, @tjm_max, @skills, @offer_type, @url,
      @deadline, @date_published, @date_scraped, @raw_data)`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const offer of offers) {
      const info = stmt.run(offerToRow(offer, now));
      if (info.changes > 0) inserted++;
    }
  });
  tx();
  return inserted;
}

export function getOfferById(id: string): FreelanceOffer | undefined {
  const row = db
    .prepare('SELECT * FROM freelance_offers WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToOffer(row) : undefined;
}

export function getNewOffers(limit: number = 50): FreelanceOffer[] {
  const rows = db
    .prepare(
      `SELECT * FROM freelance_offers
       WHERE status = 'new'
       ORDER BY relevance_score DESC, date_scraped DESC
       LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToOffer);
}

export function getTopOffers(limit: number = 10): FreelanceOffer[] {
  const rows = db
    .prepare(
      `SELECT * FROM freelance_offers
       WHERE status IN ('new', 'analyzed') AND relevance_score > 0
       ORDER BY relevance_score DESC
       LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToOffer);
}

export function getOffersByPlatform(platform: string): FreelanceOffer[] {
  const rows = db
    .prepare(
      `SELECT * FROM freelance_offers
       WHERE platform = ?
       ORDER BY date_scraped DESC`,
    )
    .all(platform) as Record<string, unknown>[];
  return rows.map(rowToOffer);
}

export function getOffersNearDeadline(days: number = 7): FreelanceOffer[] {
  const rows = db
    .prepare(
      `SELECT * FROM freelance_offers
       WHERE deadline IS NOT NULL
         AND deadline > date('now')
         AND deadline <= date('now', '+' || ? || ' days')
         AND status NOT IN ('expired', 'rejected')
       ORDER BY deadline ASC`,
    )
    .all(days) as Record<string, unknown>[];
  return rows.map(rowToOffer);
}

export function updateOfferStatus(id: string, status: OfferStatus): void {
  db.prepare('UPDATE freelance_offers SET status = ? WHERE id = ?').run(
    status,
    id,
  );
}

export function updateOfferScore(id: string, score: number, tier: 1 | 2): void {
  const col = tier === 1 ? 'relevance_score' : 'relevance_score_t2';
  db.prepare(`UPDATE freelance_offers SET ${col} = ? WHERE id = ?`).run(
    score,
    id,
  );
}

export function markExpiredOffers(): number {
  const info = db
    .prepare(
      `UPDATE freelance_offers
       SET status = 'expired'
       WHERE deadline < date('now')
         AND status NOT IN ('applied', 'expired')`,
    )
    .run();
  return info.changes;
}

export function purgeOldOffers(daysOld: number): number {
  const info = db
    .prepare(
      `DELETE FROM freelance_offers
       WHERE date_scraped < date('now', '-' || ? || ' days')
         AND status NOT IN ('applied')`,
    )
    .run(daysOld);
  return info.changes;
}

export function getOfferStats(): {
  total: number;
  new: number;
  analyzed: number;
  applied: number;
  byPlatform: Record<string, number>;
} {
  const total = (
    db.prepare('SELECT COUNT(*) as c FROM freelance_offers').get() as {
      c: number;
    }
  ).c;

  const newCount = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM freelance_offers WHERE status = 'new'",
      )
      .get() as { c: number }
  ).c;

  const analyzed = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM freelance_offers WHERE status = 'analyzed'",
      )
      .get() as { c: number }
  ).c;

  const applied = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM freelance_offers WHERE status = 'applied'",
      )
      .get() as { c: number }
  ).c;

  const platformRows = db
    .prepare(
      'SELECT platform, COUNT(*) as c FROM freelance_offers GROUP BY platform',
    )
    .all() as Array<{ platform: string; c: number }>;

  const byPlatform: Record<string, number> = {};
  for (const row of platformRows) {
    byPlatform[row.platform] = row.c;
  }

  return { total, new: newCount, analyzed, applied, byPlatform };
}
