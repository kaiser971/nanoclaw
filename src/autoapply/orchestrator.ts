/**
 * Scraper orchestrator — runs all scrapers, deduplicates, stores in OFFRES/.
 * Designed to run host-side (no container needed).
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  initOfferStore,
  getOffresDir,
  isDuplicate,
  insertOffer,
  registerForDedup,
  flushRegistry,
  getOffersByStatus,
  getOfferStats,
  writeRapportLog,
} from './offer-store.js';
import { RATE_LIMITS, SCORING_CONFIG, SEARCH_PROFILES } from './config.js';
import { scoreOffer } from './relevance.js';
import type { RawOffer, Scraper, ScraperRunConfig } from './types.js';

// Import scrapers
import { boampScraper } from './platforms/boamp.js';
import { freeWorkScraper } from './platforms/free-work.js';

/** Last scraping result, used by buildDigest to access ignored offers. */
let lastScrapingResult: ScrapingResult | null = null;

/** All registered scrapers, keyed by site name. */
const SCRAPERS: Record<string, Scraper> = {
  'free-work': freeWorkScraper,
  // boamp: boampScraper, // Disabled for now
};

interface InsertedOffer {
  title: string;
  site: string;
  score: number;
  folderPath: string;
}

export interface ScrapingResult {
  totalScraped: number;
  totalInserted: number;
  totalDuplicates: number;
  totalBelowThreshold: number;
  newOffers: InsertedOffer[];
  ignoredOffers: Array<{
    title: string;
    site: string;
    reason: string;
    score?: number;
  }>;
  byProfile: Record<string, { scraped: number; inserted: number }>;
  errors: Array<{ profile: string; site: string; error: string }>;
}

/**
 * Run all registered scrapers for each search profile, deduplicate, and store in OFFRES/.
 * Returns a summary of the run.
 */
export async function runAllScrapers(): Promise<ScrapingResult> {
  initOfferStore();

  const result: ScrapingResult = {
    totalScraped: 0,
    totalInserted: 0,
    totalDuplicates: 0,
    totalBelowThreshold: 0,
    newOffers: [],
    ignoredOffers: [],
    byProfile: {},
    errors: [],
  };

  logger.info(
    { profileCount: SEARCH_PROFILES.length },
    'Starting scraping run',
  );

  for (let pi = 0; pi < SEARCH_PROFILES.length; pi++) {
    const profile = SEARCH_PROFILES[pi];
    let profileScraped = 0;
    let profileInserted = 0;

    for (const siteName of profile.sites) {
      const scraper = SCRAPERS[siteName];
      if (!scraper) {
        logger.warn({ site: siteName }, 'Unknown scraper site, skipping');
        continue;
      }

      const config: ScraperRunConfig = {
        searchTerms: profile.searchTerms,
        searchProfile: profile.name,
        maxPages: RATE_LIMITS.MAX_PAGES_PER_RUN,
        requestDelay: RATE_LIMITS.SAME_DOMAIN_DELAY,
        timeout: RATE_LIMITS.REQUEST_TIMEOUT,
      };

      try {
        // Test scraper health first
        const testResult = await scraper.test();
        if (!testResult.ok) {
          logger.warn(
            { site: siteName, error: testResult.error },
            'Scraper test failed, skipping',
          );
          result.errors.push({
            profile: profile.name,
            site: siteName,
            error: `Test failed: ${testResult.error}`,
          });
          continue;
        }

        // Run the scraper
        const offers = await scraper.scrape(config);

        for (const offer of offers) {
          profileScraped++;

          // Check dedup before scoring
          if (isDuplicate(offer.offer_url, offer.fingerprint)) {
            result.totalDuplicates++;
            continue;
          }

          // Score the offer
          const { score } = scoreOffer(offer);

          if (score >= SCORING_CONFIG.TIER1_THRESHOLD) {
            // Insert with folder creation
            const { inserted, folderPath } = insertOffer(offer, score);
            if (inserted && folderPath) {
              profileInserted++;
              result.newOffers.push({
                title: offer.title,
                site: siteName,
                score,
                folderPath,
              });

              logger.debug(
                {
                  site: siteName,
                  profile: profile.name,
                  score,
                  title: offer.title.slice(0, 60),
                },
                'New offer stored and scored',
              );

              if (profileInserted >= RATE_LIMITS.MAX_NEW_RESULTS) {
                logger.info(
                  { profile: profile.name, limit: RATE_LIMITS.MAX_NEW_RESULTS },
                  'Max new results reached, stopping profile',
                );
                break;
              }
            }
          } else {
            // Register for dedup only (no folder)
            registerForDedup(offer, score);
            result.totalBelowThreshold++;
            const reason =
              score === 0
                ? 'Hard-exclusion (titre, localisation ou compétence exclue)'
                : `Score Tier 1 insuffisant (${score.toFixed(2)} < ${SCORING_CONFIG.TIER1_THRESHOLD})`;
            result.ignoredOffers.push({
              title: offer.title,
              site: siteName,
              reason,
              score,
            });
          }
        }

        logger.info(
          {
            site: siteName,
            profile: profile.name,
            scraped: profileScraped,
            inserted: profileInserted,
          },
          'Scraper completed for profile',
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(
          { site: siteName, profile: profile.name, err },
          'Scraper failed',
        );
        result.errors.push({
          profile: profile.name,
          site: siteName,
          error: errorMsg,
        });
      }

      // Delay between scrapers
      await new Promise((r) => setTimeout(r, RATE_LIMITS.INTER_SCRAPER_DELAY));
    }

    result.byProfile[profile.name] = {
      scraped: profileScraped,
      inserted: profileInserted,
    };
    result.totalScraped += profileScraped;
    result.totalInserted += profileInserted;
  }

  // Flush registry to disk after all inserts
  flushRegistry();

  const stats = getOfferStats();
  logger.info(
    {
      totalScraped: result.totalScraped,
      totalInserted: result.totalInserted,
      storeTotal: stats.total,
      errors: result.errors.length,
    },
    'Scraping run completed',
  );

  // Write rapport
  const date = new Date().toISOString();
  writeRapportLog(
    `[${date}] Scraped: ${result.totalScraped}, Inserted: ${result.totalInserted}, ` +
      `Duplicates: ${result.totalDuplicates}, Ignored: ${result.totalBelowThreshold}, ` +
      `Errors: ${result.errors.length}\n` +
      `Profiles: ${JSON.stringify(result.byProfile)}\n` +
      `Store: ${JSON.stringify(stats)}\n`,
  );

  // Store for buildDigest to access
  lastScrapingResult = result;

  return result;
}

/**
 * Git commit + push new offers in the freelance-radar repo.
 */
export function commitJobRepo(offerCount: number): void {
  const repoDir = path.dirname(getOffresDir()); // freelance-radar/ (parent of OFFRES/)
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    logger.warn(
      { dir: repoDir },
      'freelance-radar repo not initialized, skipping commit',
    );
    return;
  }

  try {
    const opts = { cwd: repoDir, stdio: 'pipe' as const };
    execSync('git add -A', opts);

    // Check if there's anything to commit
    const status = execSync('git status --porcelain', opts).toString().trim();
    if (!status) return;

    const date = new Date().toISOString().slice(0, 10);
    execSync(
      `git commit -m "feat: ${offerCount} nouvelle(s) offre(s) — ${date}"`,
      opts,
    );
    logger.info({ offerCount }, 'OFFRES repo committed');

    // Push if remote is configured
    try {
      execSync('git remote get-url origin', opts);
      execSync('git push', opts);
      logger.info('OFFRES repo pushed');
    } catch {
      // No remote configured, skip push
    }
  } catch (err) {
    logger.warn({ err }, 'OFFRES repo commit failed');
  }
}

/**
 * Write pertinent offers to IPC for the container agent to read.
 */
export function writeOffersToIpc(
  groupFolder: string,
  offers: InsertedOffer[],
): void {
  if (offers.length === 0) {
    logger.info('No pertinent offers to write to IPC');
    return;
  }

  const ipcDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  fs.mkdirSync(ipcDir, { recursive: true });

  const payload = {
    offerFolders: offers.map((o) => o.folderPath),
    offresDir: getOffresDir(),
    profilePath: '/workspace/project/data/freelance/profile.json',
    cvPath: '/workspace/project/data/freelance/CV.docx',
    scrapedAt: new Date().toISOString(),
  };

  const ipcFile = path.join(ipcDir, 'autoapply_offers.json');
  fs.writeFileSync(ipcFile, JSON.stringify(payload, null, 2));

  logger.info(
    { count: offers.length, path: ipcFile },
    'Offers written to IPC for container',
  );
}

/**
 * Build the container prompt for Tier 2 scoring only (no CV generation).
 */
export function buildScoringPrompt(count: number): string {
  return `${count} offres en attente de scoring Tier 2.

INSTRUCTIONS — SCORING UNIQUEMENT :
1. Trouve les offres à scorer (celles dans RECU/ sans SCORING.json) :
   find /workspace/extra/freelance-radar/OFFRES -path "*/RECU/*/RAW.json" | while read f; do d=$(dirname "$f"); [ ! -f "$d/SCORING.json" ] && echo "$d"; done | sort
2. Pour CHAQUE offre, envoie un message via mcp__nanoclaw__send_message : "⏳ Scoring offre X/${count} : [titre]..."
3. Lis le RAW.json, évalue la pertinence sémantique par rapport au profil
4. Écris un fichier SCORING.json dans le dossier de l'offre avec cette structure EXACTE :
   {
     "tier2_score": 0.85,
     "recommendation": "apply",
     "reasoning": "Explication détaillée de pourquoi cette offre est retenue ou rejetée...",
     "matched_skills": ["PHP", "Symfony", "Docker"],
     "missing_skills": ["Terraform"]
   }
   - recommendation : "apply" (>= 0.7), "maybe" (0.5–0.7), "skip" (< 0.5)
   - reasoning : OBLIGATOIRE, doit expliquer précisément les raisons du score

RÈGLES STRICTES :
- NE PAS déplacer de dossiers. NE PAS supprimer de dossiers. Le host s'en charge.
- NE PAS générer de CV. NE PAS appeler le skill resume-optimizer.
- ÉCRIRE un SCORING.json pour CHAQUE offre sans exception.
- Le champ "reasoning" doit être rempli pour TOUTES les offres (apply, maybe ET skip).

Profil : /workspace/project/data/freelance/profile.json
Repo offres : /workspace/extra/freelance-radar/OFFRES/`;
}

/**
 * Build a WhatsApp-friendly digest message from scraping results.
 */
export function buildDigest(resultSummary: string): string | null {
  const ignoredOffers = lastScrapingResult?.ignoredOffers;
  const match = resultSummary.match(
    /(\d+) scraped, (\d+) new, (\d+) pertinent, (\d+) pending, (\d+) already_processed, (\d+) duplicates, (\d+) ignored/,
  );
  if (!match) return null;

  const [
    ,
    scraped,
    newCount,
    pertinent,
    pending,
    alreadyProcessed,
    duplicates,
    ignored,
  ] = match;

  const date = new Date().toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  let digest = `📋 *Scraping du ${date}*\n\n`;
  digest += `*Bilan :*\n`;
  digest += `• ${scraped} offres analysées\n`;
  digest += `• ${duplicates} doublons ignorés\n`;
  digest += `• ${ignored} offres rejetées (score insuffisant)\n`;
  digest += `• ${newCount} nouvelles retenues\n`;
  digest += `• ${alreadyProcessed} offres déjà traitées (CV existant)\n`;
  digest += `• ${pending} offres en attente de traitement (Tier 2)\n\n`;

  // Top retained offers
  const recuOffers = getOffersByStatus('RECU');
  if (recuOffers.length > 0) {
    const topOffers = recuOffers
      .sort((a, b) => b.tier1Score - a.tier1Score)
      .slice(0, 5);

    digest += `*Top offres retenues :*\n\n`;

    for (const offer of topOffers) {
      const icon =
        offer.tier1Score >= 0.6 ? '🟢' : offer.tier1Score >= 0.4 ? '🟡' : '🟠';
      const rate = offer.raw.daily_rate ? `${offer.raw.daily_rate}€/j` : '';

      digest += `${icon} *${offer.raw.title.slice(0, 60)}*\n`;
      digest += `   [${offer.site}] ${offer.raw.company || ''} ${rate}\n`;
      digest += `   Score: ${offer.tier1Score.toFixed(2)}\n`;
      digest += `   ${offer.raw.offer_url}\n\n`;
    }
  }

  // Ignored offers summary
  if (ignoredOffers && ignoredOffers.length > 0) {
    const hardExcluded = ignoredOffers.filter((o) => o.score === 0);
    const lowScore = ignoredOffers.filter(
      (o) => o.score !== undefined && o.score > 0,
    );

    if (hardExcluded.length > 0) {
      digest += `*Offres exclues (hors scope) :*\n`;
      for (const o of hardExcluded.slice(0, 5)) {
        digest += `   ❌ ${o.title.slice(0, 50)} [${o.site}]\n`;
      }
      if (hardExcluded.length > 5) {
        digest += `   ... et ${hardExcluded.length - 5} autres\n`;
      }
      digest += `\n`;
    }

    if (lowScore.length > 0) {
      digest += `*Offres rejetées (score trop bas) :*\n`;
      for (const o of lowScore.slice(0, 5)) {
        digest += `   ⚪ ${o.title.slice(0, 50)} — ${o.score!.toFixed(2)} [${o.site}]\n`;
      }
      if (lowScore.length > 5) {
        digest += `   ... et ${lowScore.length - 5} autres\n`;
      }
      digest += `\n`;
    }
  }

  digest += `───────\n`;
  digest += `📂 Détails dans le repo OFFRES`;

  return digest;
}

/**
 * Test all scrapers and return their health status.
 */
export async function testAllScrapers(): Promise<
  Array<{ site: string; name: string; ok: boolean; error?: string }>
> {
  const results = [];
  for (const scraper of Object.values(SCRAPERS)) {
    const test = await scraper.test();
    results.push({
      site: scraper.site,
      name: scraper.name,
      ...test,
    });
  }
  return results;
}
