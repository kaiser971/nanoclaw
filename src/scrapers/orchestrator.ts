/**
 * Scraper orchestrator — runs all scrapers, deduplicates, stores in DB.
 * Designed to run host-side (no container needed).
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  initFreelanceDb,
  insertOffer,
  updateOfferScore,
  getOfferById,
  getOfferStats,
} from '../freelance-db.js';
import { RATE_LIMITS, SCORING_CONFIG, FREELANCE_SEARCH_TERMS, ALL_SEARCH_TERMS } from './config.js';
import { scoreOffer } from './relevance.js';
import type { ScrapedOffer, Scraper, ScraperRunConfig } from './types.js';

// Import scrapers
import { boampScraper } from './platforms/boamp.js';
import { freeWorkScraper } from './platforms/free-work.js';

/** All registered scrapers. Add new ones here. */
const SCRAPERS: Scraper[] = [boampScraper, freeWorkScraper];

interface InsertedOffer {
  id: string;
  title: string;
  platform: string;
  score: number;
  slug: string;
}

/** Path to the job tracking repo. Configurable via env var. */
const JOB_REPO_DIR = path.resolve(
  process.env.AUTOAPPLY_JOB_REPO || path.join(process.cwd(), '..', 'freelance-radar'),
);

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export interface ScrapingResult {
  totalScraped: number;
  totalInserted: number;
  newOffers: InsertedOffer[];
  byPlatform: Record<string, { scraped: number; inserted: number }>;
  errors: Array<{ platform: string; error: string }>;
}

/**
 * Run all registered scrapers sequentially, deduplicate, and store in DB.
 * Returns a summary of the run.
 */
export async function runAllScrapers(): Promise<ScrapingResult> {
  // Ensure DB is ready
  initFreelanceDb();

  const result: ScrapingResult = {
    totalScraped: 0,
    totalInserted: 0,
    newOffers: [],
    byPlatform: {},
    errors: [],
  };

  logger.info(
    { scraperCount: SCRAPERS.length },
    'Starting scraping run',
  );

  for (let i = 0; i < SCRAPERS.length; i++) {
    const scraper = SCRAPERS[i];

    // Build config per scraper
    const config: ScraperRunConfig = {
      searchTerms:
        scraper.platform === 'boamp' ? ALL_SEARCH_TERMS : FREELANCE_SEARCH_TERMS,
      maxPages: RATE_LIMITS.MAX_PAGES_PER_RUN,
      requestDelay: RATE_LIMITS.SAME_DOMAIN_DELAY,
      timeout: RATE_LIMITS.REQUEST_TIMEOUT,
    };

    try {
      // Test scraper health first
      const testResult = await scraper.test();
      if (!testResult.ok) {
        logger.warn(
          { platform: scraper.platform, error: testResult.error },
          'Scraper test failed, skipping',
        );
        result.errors.push({
          platform: scraper.platform,
          error: `Test failed: ${testResult.error}`,
        });
        continue;
      }

      // Run the scraper
      const offers = await scraper.scrape(config);

      // Insert one by one, stop at MAX_NEW_RESULTS new offers
      let scraped = 0;
      let inserted = 0;
      for (const offer of offers) {
        scraped++;
        const isNew = insertOffer(offer);
        if (isNew) {
          inserted++;

          // Score immediately after insertion
          const offerId = `${offer.platform}_${offer.platformId}`;
          const { score, breakdown } = scoreOffer(offer);
          updateOfferScore(offerId, score, 1);

          const slug = slugify(offer.title);

          // Write to JOBTOAPPLY/{platform}/{slug}/description.md
          if (score >= SCORING_CONFIG.TIER1_THRESHOLD) {
            writeOfferDescription(offer, score, breakdown);
          }

          result.newOffers.push({
            id: offerId,
            title: offer.title,
            platform: offer.platform,
            score,
            slug,
          });

          logger.debug(
            { platform: scraper.platform, id: offer.platformId, score, title: offer.title.slice(0, 60) },
            'New offer stored and scored',
          );
          if (inserted >= RATE_LIMITS.MAX_NEW_RESULTS) {
            logger.info(
              { platform: scraper.platform, limit: RATE_LIMITS.MAX_NEW_RESULTS },
              'Max new results reached, stopping scraper',
            );
            break;
          }
        }
      }

      result.totalScraped += scraped;
      result.totalInserted += inserted;
      result.byPlatform[scraper.platform] = { scraped, inserted };

      logger.info(
        { platform: scraper.platform, scraped, inserted },
        'Scraper completed',
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        { platform: scraper.platform, err },
        'Scraper failed',
      );
      result.errors.push({ platform: scraper.platform, error: errorMsg });
    }

    // Delay between different scrapers
    if (i < SCRAPERS.length - 1) {
      await new Promise((r) => setTimeout(r, RATE_LIMITS.INTER_SCRAPER_DELAY));
    }
  }

  const stats = getOfferStats();
  logger.info(
    {
      totalScraped: result.totalScraped,
      totalInserted: result.totalInserted,
      dbTotal: stats.total,
      errors: result.errors.length,
    },
    'Scraping run completed',
  );

  return result;
}

/**
 * Write a description.md for an offer in JOBTOAPPLY/{platform}/{slug}/
 */
function writeOfferDescription(
  offer: ScrapedOffer,
  score: number,
  breakdown: Record<string, number>,
): void {
  const slug = slugify(offer.title);
  const offerDir = path.join(JOB_REPO_DIR, offer.platform, slug);
  fs.mkdirSync(offerDir, { recursive: true });

  const descPath = path.join(offerDir, 'description.md');

  // Don't overwrite if already exists
  if (fs.existsSync(descPath)) return;

  const skills = (offer.skills || []).join(', ') || 'Non spécifiées';
  const now = new Date().toISOString().slice(0, 10);

  const md = `# ${offer.title}

## Informations

| Champ | Valeur |
|-------|--------|
| **Plateforme** | ${offer.platform} |
| **Acheteur** | ${offer.buyer || '—'} |
| **Localisation** | ${offer.location || '—'} |
| **TJM** | ${offer.tjmMin ? `${offer.tjmMin}–${offer.tjmMax || '?'}€/j` : '—'} |
| **Type** | ${offer.offerType} |
| **Deadline** | ${offer.deadline?.slice(0, 10) || '—'} |
| **Publiée** | ${offer.datePublished?.slice(0, 10) || '—'} |
| **URL** | ${offer.url} |
| **Scrapée le** | ${now} |

## Compétences demandées

${skills}

## Description

${offer.description || '*Description non disponible — consulter l\'URL de l\'offre.*'}

## Scoring Tier 1 (automatique)

**Score global : ${score.toFixed(2)}**

| Critère | Score |
|---------|-------|
| Compétences (skill match) | ${breakdown.skillMatch?.toFixed(2) || '—'} |
| Pertinence domaine | ${breakdown.domainRelevance?.toFixed(2) || '—'} |
| Expérience | ${breakdown.experienceMatch?.toFixed(2) || '—'} |
| Localisation | ${breakdown.locationMatch?.toFixed(2) || '—'} |
| TJM | ${breakdown.tjmMatch?.toFixed(2) || '—'} |
| Fraîcheur | ${breakdown.freshnessBonus?.toFixed(2) || '—'} |

## Pourquoi cette offre

${score >= 0.6 ? '🟢 **Fortement recommandée**' : score >= 0.4 ? '🟡 **Correspondance partielle**' : '🟠 **À vérifier**'} — ${
    breakdown.domainRelevance >= 0.6
      ? 'Le domaine correspond directement au profil (maintenance applicative, développement web, IA).'
      : 'Le domaine est adjacent au profil.'
  }

---

*Généré automatiquement par Autoapply le ${now}. Le scoring Tier 2 (Claude) et le CV adapté seront ajoutés après analyse.*
`;

  fs.writeFileSync(descPath, md, 'utf-8');
  logger.info({ platform: offer.platform, slug }, 'Offer description written to JOBTOAPPLY');
}

/**
 * Git commit + push new offers in the freelance-radar repo.
 */
function commitJobRepo(offerCount: number): void {
  if (!fs.existsSync(path.join(JOB_REPO_DIR, '.git'))) {
    logger.warn({ dir: JOB_REPO_DIR }, 'Job repo not initialized, skipping commit');
    return;
  }

  try {
    const opts = { cwd: JOB_REPO_DIR, stdio: 'pipe' as const };
    execSync('git add -A', opts);

    // Check if there's anything to commit
    const status = execSync('git status --porcelain', opts).toString().trim();
    if (!status) return;

    const date = new Date().toISOString().slice(0, 10);
    execSync(
      `git commit -m "feat: ${offerCount} nouvelle(s) offre(s) — ${date}"`,
      opts,
    );
    logger.info({ offerCount }, 'Job repo committed');

    // Push if remote is configured
    try {
      execSync('git remote get-url origin', opts);
      execSync('git push', opts);
      logger.info('Job repo pushed');
    } catch {
      // No remote configured, skip push
    }
  } catch (err) {
    logger.warn({ err }, 'Job repo commit failed');
  }
}

/**
 * Write pertinent offers to IPC for the container agent to read.
 * The container skill (freelance-cv) reads this file and runs Tier 2 scoring + CV adaptation.
 */
export function writeOffersToIpc(
  groupFolder: string,
  offers: InsertedOffer[],
): void {
  const pertinent = offers.filter(
    (o) => o.score >= SCORING_CONFIG.TIER1_THRESHOLD,
  );

  if (pertinent.length === 0) {
    logger.info('No pertinent offers to write to IPC');
    return;
  }

  // Build full offer data for the container
  const fullOffers = pertinent
    .map((o) => {
      const dbOffer = getOfferById(o.id);
      if (!dbOffer) return null;
      return {
        id: dbOffer.id,
        platform: dbOffer.platform,
        title: dbOffer.title,
        description: dbOffer.description,
        buyer: dbOffer.buyer,
        location: dbOffer.location,
        tjmMin: dbOffer.tjmMin,
        tjmMax: dbOffer.tjmMax,
        skills: dbOffer.skills,
        offerType: dbOffer.offerType,
        url: dbOffer.url,
        deadline: dbOffer.deadline,
        datePublished: dbOffer.datePublished,
        tier1Score: dbOffer.relevanceScore,
      };
    })
    .filter(Boolean);

  const ipcDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  fs.mkdirSync(ipcDir, { recursive: true });

  const payload = {
    offers: fullOffers,
    profilePath: '/workspace/project/data/freelance/profile.json',
    cvPath: '/workspace/project/data/freelance/CV.docx',
    jobDir: '/workspace/project/JOBTOAPPLY',
    scrapedAt: new Date().toISOString(),
  };

  const ipcFile = path.join(ipcDir, 'autoapply_offers.json');
  fs.writeFileSync(ipcFile, JSON.stringify(payload, null, 2));

  logger.info(
    { count: fullOffers.length, path: ipcFile },
    'Offers written to IPC for container',
  );
}

/**
 * Register Autoapply host tasks with the scheduler.
 * Call this once at startup.
 */
export function registerAutoapplyTasks(): void {
  // Lazy import to avoid circular dependency
  import('../task-scheduler.js').then(({ registerHostTask }) => {
    registerHostTask('autoapply_scraping', async () => {
      const result = await runAllScrapers();
      const pertinent = result.newOffers.filter(
        (o) => o.score >= SCORING_CONFIG.TIER1_THRESHOLD,
      );

      // Commit new offers to freelance-radar repo
      if (result.totalInserted > 0) {
        commitJobRepo(result.totalInserted);
      }

      if (pertinent.length > 0) {
        writeOffersToIpc('main', result.newOffers);
      }

      return {
        result: `${result.totalScraped} scraped, ${result.totalInserted} new, ${pertinent.length} pertinent`,
        triggerContainer:
          pertinent.length > 0
            ? {
                prompt: `${pertinent.length} nouvelles offres freelance pertinentes ont été trouvées. Analyse-les avec le skill freelance-cv : lis /workspace/ipc/input/autoapply_offers.json, fais le scoring Tier 2, adapte les CV, et envoie le digest.`,
              }
            : undefined,
      };
    });

    registerHostTask('autoapply_cleanup', async () => {
      const { markExpiredOffers, purgeOldOffers } = await import(
        '../freelance-db.js'
      );
      const expired = markExpiredOffers();
      const purged = purgeOldOffers(90);
      return { result: `${expired} expired, ${purged} purged` };
    });

    logger.info('Autoapply host tasks registered');
  });
}

/**
 * Test all scrapers and return their health status.
 */
export async function testAllScrapers(): Promise<
  Array<{ platform: string; name: string; ok: boolean; error?: string }>
> {
  const results = [];
  for (const scraper of SCRAPERS) {
    const test = await scraper.test();
    results.push({
      platform: scraper.platform,
      name: scraper.name,
      ...test,
    });
  }
  return results;
}
