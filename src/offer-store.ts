/**
 * Offer store — filesystem-based persistence for the OFFRES/ architecture.
 * Replaces freelance-db.ts (SQLite) with a directory tree + registry.json.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import type {
  OfferLifecycle,
  RawOffer,
  RegistryEntry,
  ResolvedOffer,
} from './scrapers/types.js';

// --- State ---

let offresDir: string;
let registryByUrl: Map<string, RegistryEntry>;
let registryByFingerprint: Map<string, RegistryEntry>;
let registryList: RegistryEntry[];
let initialized = false;

// --- Init ---

export function initOfferStore(dir?: string): void {
  if (initialized) return;

  offresDir =
    dir ||
    path.resolve(
      process.env.AUTOAPPLY_OFFRES_DIR ||
        path.join(process.cwd(), '..', 'freelance-radar', 'OFFRES'),
    );

  fs.mkdirSync(path.join(offresDir, 'queue'), { recursive: true });

  registryList = loadRegistry();
  registryByUrl = new Map();
  registryByFingerprint = new Map();

  for (const entry of registryList) {
    registryByUrl.set(entry.offer_url, entry);
    registryByFingerprint.set(entry.fingerprint, entry);
  }

  initialized = true;
  logger.info(
    { dir: offresDir, entries: registryList.length },
    'Offer store initialized',
  );
}

export function getOffresDir(): string {
  return offresDir;
}

// --- Registry I/O ---

function registryPath(): string {
  return path.join(offresDir, 'registry.json');
}

function loadRegistry(): RegistryEntry[] {
  const p = registryPath();
  if (!fs.existsSync(p)) return [];

  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as RegistryEntry[];
  } catch {
    // Try recovery from tmp
    const tmp = p + '.tmp';
    if (fs.existsSync(tmp)) {
      logger.warn('Recovering registry from .tmp file');
      return JSON.parse(fs.readFileSync(tmp, 'utf-8')) as RegistryEntry[];
    }
    return [];
  }
}

function saveRegistry(): void {
  const p = registryPath();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(registryList, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

// --- Fingerprint ---

export function computeFingerprint(
  title: string,
  company: string | null,
  location: string | null,
  contractType: string,
): string {
  const input = [title, company ?? '', location ?? '', contractType]
    .map((s) => s.toLowerCase().trim())
    .join('|');
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// --- Deduplication ---

export function isDuplicate(offerUrl: string, fingerprint: string): boolean {
  return registryByUrl.has(offerUrl) || registryByFingerprint.has(fingerprint);
}

// --- Slugify ---

function slugify(text: string, maxLen: number): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, maxLen);
}

export function buildOfferFolderName(
  collectedAt: string,
  company: string | null,
  title: string,
): string {
  const date = collectedAt.slice(0, 10); // YYYY-MM-DD
  const companySlug = slugify(company || 'Inconnu', 20);
  const titleSlug = slugify(title, 30);
  return `${date}_${companySlug}_${titleSlug}`;
}

// --- DESCRIPTION.md generation ---

function generateDescriptionMd(offer: RawOffer): string {
  const xp = offer.experience_years
    ? `${offer.experience_years} an(s)`
    : 'Non spécifié';

  const rate = offer.daily_rate ? `${offer.daily_rate}€/j` : null;
  const salary =
    offer.salary_min || offer.salary_max
      ? `${offer.salary_min ?? '?'}–${offer.salary_max ?? '?'}€/an`
      : null;
  const remuneration = rate || salary || 'Non spécifié';

  const skills = [...offer.skills_required, ...offer.skills_optional];

  return `# ${offer.title}

**Entreprise** : ${offer.company ?? 'Inconnu'}
**Localisation** : ${offer.location ?? 'Non spécifié'}
**Politique remote** : ${offer.remote_policy}
**Type de contrat** : ${offer.contract_type}
**Rémunération** : ${remuneration}

**Expérience** : ${xp}
${skills.length > 0 ? `**Compétences** : ${skills.join(', ')}` : ''}

## Description

${offer.description_raw || "*Description non disponible — consulter l'URL de l'offre.*"}

---
Source : [${offer.source_site}](${offer.offer_url})
Postuler : [lien](${offer.apply_url})
Collecté le : ${offer.collected_at}
Fingerprint : \`${offer.fingerprint}\`
`;
}

// --- Insert ---

export interface InsertResult {
  inserted: boolean;
  folderPath: string | null;
}

/**
 * Insert an offer into the store.
 * Creates the folder under OFFRES/{site}/{profile}/RECU/, writes RAW.json + DESCRIPTION.md,
 * and adds to registry. Returns false if duplicate.
 */
export function insertOffer(offer: RawOffer, tier1Score: number): InsertResult {
  if (isDuplicate(offer.offer_url, offer.fingerprint)) {
    return { inserted: false, folderPath: null };
  }

  const folderName = buildOfferFolderName(
    offer.collected_at,
    offer.company,
    offer.title,
  );
  const folderPath = path.join(
    offresDir,
    offer.source_site,
    offer.search_profile,
    'RECU',
    folderName,
  );

  fs.mkdirSync(folderPath, { recursive: true });
  fs.writeFileSync(
    path.join(folderPath, 'RAW.json'),
    JSON.stringify(offer, null, 2),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(folderPath, 'DESCRIPTION.md'),
    generateDescriptionMd(offer),
    'utf-8',
  );

  const entry: RegistryEntry = {
    fingerprint: offer.fingerprint,
    offer_url: offer.offer_url,
    folder: folderPath,
    site: offer.source_site,
    search_profile: offer.search_profile,
    collected_at: offer.collected_at,
    tier1_score: tier1Score,
  };

  registryList.push(entry);
  registryByUrl.set(entry.offer_url, entry);
  registryByFingerprint.set(entry.fingerprint, entry);

  return { inserted: true, folderPath };
}

/**
 * Register an offer in the registry for dedup without creating a folder.
 * Used for offers below the Tier 1 threshold.
 */
export function registerForDedup(offer: RawOffer, tier1Score: number): void {
  if (isDuplicate(offer.offer_url, offer.fingerprint)) return;

  const entry: RegistryEntry = {
    fingerprint: offer.fingerprint,
    offer_url: offer.offer_url,
    folder: '', // No folder created
    site: offer.source_site,
    search_profile: offer.search_profile,
    collected_at: offer.collected_at,
    tier1_score: tier1Score,
  };

  registryList.push(entry);
  registryByUrl.set(entry.offer_url, entry);
  registryByFingerprint.set(entry.fingerprint, entry);
}

/** Flush the in-memory registry to disk. Call after a batch of inserts. */
export function flushRegistry(): void {
  saveRegistry();
}

// --- Move (status transition) ---

/**
 * Move an offer folder from its current status to a new one.
 * Updates the registry entry's folder path.
 */
export function moveOffer(
  currentFolderPath: string,
  newStatus: OfferLifecycle,
): string {
  if (!fs.existsSync(currentFolderPath)) {
    throw new Error(`Offer folder not found: ${currentFolderPath}`);
  }

  const folderName = path.basename(currentFolderPath);
  // Current structure: OFFRES/{site}/{profile}/{STATUS}/{folderName}
  const statusDir = path.dirname(currentFolderPath);
  const profileDir = path.dirname(statusDir);

  const newFolderPath = path.join(profileDir, newStatus, folderName);
  fs.mkdirSync(path.dirname(newFolderPath), { recursive: true });
  fs.renameSync(currentFolderPath, newFolderPath);

  // Update registry
  const entry = registryList.find((e) => e.folder === currentFolderPath);
  if (entry) {
    entry.folder = newFolderPath;
    registryByUrl.set(entry.offer_url, entry);
    registryByFingerprint.set(entry.fingerprint, entry);
    saveRegistry();
  }

  return newFolderPath;
}

// --- Query ---

/**
 * Get all offers in a given status, optionally filtered by site/profile.
 * Scans the filesystem and reads RAW.json from each folder.
 */
export function getOffersByStatus(
  status: OfferLifecycle,
  site?: string,
  profile?: string,
): ResolvedOffer[] {
  const offers: ResolvedOffer[] = [];

  const sites = site
    ? [site]
    : fs
        .readdirSync(offresDir)
        .filter(
          (d) =>
            d !== 'queue' &&
            !d.startsWith('.') &&
            d !== 'registry.json' &&
            d !== 'RAPPORT.log' &&
            fs.statSync(path.join(offresDir, d)).isDirectory(),
        );

  for (const s of sites) {
    const siteDir = path.join(offresDir, s);
    if (!fs.existsSync(siteDir)) continue;

    const profiles = profile
      ? [profile]
      : fs
          .readdirSync(siteDir)
          .filter((d) => fs.statSync(path.join(siteDir, d)).isDirectory());

    for (const p of profiles) {
      const statusDir = path.join(siteDir, p, status);
      if (!fs.existsSync(statusDir)) continue;

      for (const folderName of fs.readdirSync(statusDir)) {
        const folderPath = path.join(statusDir, folderName);
        if (!fs.statSync(folderPath).isDirectory()) continue;

        const rawPath = path.join(folderPath, 'RAW.json');
        if (!fs.existsSync(rawPath)) continue;

        try {
          const raw = JSON.parse(fs.readFileSync(rawPath, 'utf-8')) as RawOffer;

          const registryEntry = registryByUrl.get(raw.offer_url);

          offers.push({
            raw,
            folderPath,
            status,
            site: s,
            searchProfile: p,
            tier1Score: registryEntry?.tier1_score ?? 0,
          });
        } catch {
          logger.warn({ folder: folderPath }, 'Failed to read RAW.json');
        }
      }
    }
  }

  return offers;
}

/**
 * Get offers in RECU that haven't been scored yet (no SCORING.json).
 */
export function getUnscoredOffers(
  site?: string,
  profile?: string,
): ResolvedOffer[] {
  const recuOffers = getOffersByStatus('RECU', site, profile);
  return recuOffers.filter((offer) => {
    return !fs.existsSync(path.join(offer.folderPath, 'SCORING.json'));
  });
}

/**
 * Get offers in RECU that have been scored (apply/maybe) but don't have a CV yet.
 */
export function getScoredWithoutCV(
  site?: string,
  profile?: string,
): ResolvedOffer[] {
  const recuOffers = getOffersByStatus('RECU', site, profile);
  return recuOffers.filter((offer) => {
    const scoringPath = path.join(offer.folderPath, 'SCORING.json');
    if (!fs.existsSync(scoringPath)) return false;
    try {
      const scoring = JSON.parse(fs.readFileSync(scoringPath, 'utf-8'));
      if (scoring.recommendation === 'skip') return false;
    } catch {
      return false;
    }
    const files = fs.readdirSync(offer.folderPath);
    return (
      !files.some((f) => f.startsWith('CV_') && f.endsWith('.docx')) &&
      !files.includes('CV.docx')
    );
  });
}

/**
 * Get offers in RECU that don't have a CV yet (not yet fully processed).
 * An offer is "pending" if it has no SCORING.json OR has scoring but no CV.
 */
export function getPendingOffers(
  site?: string,
  profile?: string,
): ResolvedOffer[] {
  const recuOffers = getOffersByStatus('RECU', site, profile);
  return recuOffers.filter((offer) => {
    const hasScoringJson = fs.existsSync(
      path.join(offer.folderPath, 'SCORING.json'),
    );
    if (!hasScoringJson) return true; // not scored yet
    // Scored — check if it's apply/maybe without CV
    try {
      const scoring = JSON.parse(
        fs.readFileSync(path.join(offer.folderPath, 'SCORING.json'), 'utf-8'),
      );
      if (scoring.recommendation === 'skip') return false; // will be moved to ARCHIVED
    } catch {
      return true;
    }
    const files = fs.readdirSync(offer.folderPath);
    return (
      !files.some((f) => f.startsWith('CV_') && f.endsWith('.docx')) &&
      !files.includes('CV.docx')
    );
  });
}

/** Read a single offer by its folder path. */
export function getOfferByFolder(folderPath: string): ResolvedOffer | null {
  const rawPath = path.join(folderPath, 'RAW.json');
  if (!fs.existsSync(rawPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(rawPath, 'utf-8')) as RawOffer;
    const registryEntry = registryByUrl.get(raw.offer_url);

    // Derive status from path: .../{STATUS}/{folderName}
    const statusDir = path.basename(path.dirname(folderPath));
    const status = (
      ['RECU', 'APPLIED', 'ARCHIVED'].includes(statusDir) ? statusDir : 'RECU'
    ) as OfferLifecycle;

    // Derive site/profile: OFFRES/{site}/{profile}/{STATUS}/{folder}
    const profileDir = path.dirname(path.dirname(folderPath));
    const siteDir = path.dirname(profileDir);

    return {
      raw,
      folderPath,
      status,
      site: path.basename(siteDir),
      searchProfile: path.basename(profileDir),
      tier1Score: registryEntry?.tier1_score ?? 0,
    };
  } catch {
    return null;
  }
}

// --- Stats ---

export function getOfferStats(): {
  total: number;
  recu: number;
  applied: number;
  archived: number;
  bySite: Record<string, number>;
} {
  let recu = 0;
  let applied = 0;
  let archived = 0;
  const bySite: Record<string, number> = {};

  const sites = fs
    .readdirSync(offresDir)
    .filter(
      (d) =>
        d !== 'queue' &&
        !d.startsWith('.') &&
        d !== 'registry.json' &&
        d !== 'RAPPORT.log' &&
        fs.existsSync(path.join(offresDir, d)) &&
        fs.statSync(path.join(offresDir, d)).isDirectory(),
    );

  for (const site of sites) {
    let siteCount = 0;
    const siteDir = path.join(offresDir, site);

    const profiles = fs
      .readdirSync(siteDir)
      .filter((d) => fs.statSync(path.join(siteDir, d)).isDirectory());

    for (const profile of profiles) {
      for (const status of ['RECU', 'APPLIED', 'ARCHIVED'] as const) {
        const statusDir = path.join(siteDir, profile, status);
        if (!fs.existsSync(statusDir)) continue;

        const count = fs
          .readdirSync(statusDir)
          .filter((d) =>
            fs.statSync(path.join(statusDir, d)).isDirectory(),
          ).length;

        if (status === 'RECU') recu += count;
        else if (status === 'APPLIED') applied += count;
        else archived += count;

        siteCount += count;
      }
    }

    if (siteCount > 0) bySite[site] = siteCount;
  }

  return { total: recu + applied + archived, recu, applied, archived, bySite };
}

// --- Post-scoring processing (host-side, deterministic) ---

export interface ScoringBilan {
  apply: number;
  maybe: number;
  skip: number;
  unscored: number;
  moved: number;
  errors: string[];
}

/**
 * Process scoring results after the container finishes.
 * Reads SCORING.json from each RECU offer, writes cause.md for skips,
 * and moves skips to ARCHIVED. Fully deterministic — no LLM involved.
 */
export function processScoringResults(): ScoringBilan {
  const bilan: ScoringBilan = {
    apply: 0,
    maybe: 0,
    skip: 0,
    unscored: 0,
    moved: 0,
    errors: [],
  };

  const recuOffers = getOffersByStatus('RECU');

  for (const offer of recuOffers) {
    const scoringPath = path.join(offer.folderPath, 'SCORING.json');

    if (!fs.existsSync(scoringPath)) {
      bilan.unscored++;
      continue;
    }

    let scoring: {
      tier2_score?: number;
      recommendation?: string;
      reasoning?: string;
      matched_skills?: string[];
      missing_skills?: string[];
    };

    try {
      scoring = JSON.parse(fs.readFileSync(scoringPath, 'utf-8'));
    } catch {
      bilan.errors.push(`Malformed SCORING.json: ${offer.folderPath}`);
      continue;
    }

    const rec = scoring.recommendation;
    if (rec === 'apply') {
      bilan.apply++;
    } else if (rec === 'maybe') {
      bilan.maybe++;
    } else if (rec === 'skip') {
      bilan.skip++;

      // Write cause.md from SCORING.json content (deterministic)
      const causeMd =
        `# Cause d'archivage\n\n` +
        `**Type** : skip (scoring Tier 2)\n` +
        `**Score Tier 2** : ${scoring.tier2_score ?? 'N/A'}\n` +
        `**Date** : ${new Date().toISOString()}\n\n` +
        `## Raison detaillee\n\n` +
        `${scoring.reasoning || 'Aucune raison fournie par le scoring.'}\n\n` +
        `## Competences matchees\n` +
        `${scoring.matched_skills?.join(', ') || 'Aucune'}\n\n` +
        `## Competences manquantes\n` +
        `${scoring.missing_skills?.join(', ') || 'Aucune'}\n`;

      fs.writeFileSync(
        path.join(offer.folderPath, 'cause.md'),
        causeMd,
        'utf-8',
      );

      // Move to ARCHIVED
      try {
        moveOffer(offer.folderPath, 'ARCHIVED');
        bilan.moved++;
      } catch (err) {
        bilan.errors.push(`Failed to move ${offer.folderPath}: ${err}`);
      }
    }
  }

  if (bilan.moved > 0) saveRegistry();

  logger.info(
    {
      apply: bilan.apply,
      maybe: bilan.maybe,
      skip: bilan.skip,
      moved: bilan.moved,
      unscored: bilan.unscored,
    },
    'Scoring results processed',
  );

  return bilan;
}

// --- Cleanup ---

/**
 * Move offers in RECU older than `days` to ARCHIVED.
 * Returns the number of offers archived.
 */
export function archiveExpiredOffers(days: number): number {
  const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
  let count = 0;

  const recuOffers = getOffersByStatus('RECU');
  for (const offer of recuOffers) {
    const collectedAt = new Date(offer.raw.collected_at).getTime();
    if (isNaN(collectedAt) || collectedAt >= threshold) continue;

    try {
      // Écrire cause.md avant de déplacer
      const ageInDays = Math.round(
        (Date.now() - collectedAt) / (1000 * 60 * 60 * 24),
      );
      const causePath = path.join(offer.folderPath, 'cause.md');
      fs.writeFileSync(
        causePath,
        `# Cause d'archivage\n\n` +
          `**Type** : expiration automatique\n` +
          `**Date** : ${new Date().toISOString()}\n\n` +
          `## Raison détaillée\n\n` +
          `Offre collectée le ${offer.raw.collected_at.slice(0, 10)}, soit ${ageInDays} jours.\n` +
          `Archivée automatiquement car dépassant le seuil de rétention (${days} jours).\n`,
        'utf-8',
      );

      moveOffer(offer.folderPath, 'ARCHIVED');
      count++;
    } catch (err) {
      logger.warn({ folder: offer.folderPath, err }, 'Failed to archive offer');
    }
  }

  return count;
}

/**
 * Delete ARCHIVED offer folders older than `daysOld`.
 * Also removes their registry entries.
 */
export function purgeOldOffers(daysOld: number): number {
  const threshold = Date.now() - daysOld * 24 * 60 * 60 * 1000;
  let count = 0;

  const archivedOffers = getOffersByStatus('ARCHIVED');
  for (const offer of archivedOffers) {
    const collectedAt = new Date(offer.raw.collected_at).getTime();
    if (isNaN(collectedAt) || collectedAt >= threshold) continue;

    try {
      fs.rmSync(offer.folderPath, { recursive: true, force: true });

      // Remove from registry
      const idx = registryList.findIndex(
        (e) => e.offer_url === offer.raw.offer_url,
      );
      if (idx >= 0) {
        registryList.splice(idx, 1);
        registryByUrl.delete(offer.raw.offer_url);
        registryByFingerprint.delete(offer.raw.fingerprint);
      }

      count++;
    } catch (err) {
      logger.warn({ folder: offer.folderPath, err }, 'Failed to purge offer');
    }
  }

  if (count > 0) saveRegistry();
  return count;
}

// --- Rapport ---

export function writeRapportLog(report: string): void {
  fs.writeFileSync(path.join(offresDir, 'RAPPORT.log'), report, 'utf-8');
}
