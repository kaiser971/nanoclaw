/**
 * Free-Work scraper — French freelance job board.
 * Extracts job data from the Nuxt SSR hydration state (window.__NUXT__).
 */

import * as cheerio from 'cheerio';
import { runInNewContext } from 'vm';

import { logger } from '../../logger.js';
import { computeFingerprint } from '../../offer-store.js';
import { FREE_WORK_CONFIG, HTTP_CONFIG, RATE_LIMITS } from '../config.js';
import type {
  ContractType,
  RawOffer,
  RemotePolicy,
  Scraper,
  ScraperRunConfig,
} from '../types.js';

/** Shape of a job object inside __NUXT__.fetch[].jobs */
interface NuxtJob {
  id: number;
  title: string;
  slug: string;
  description?: string;
  candidateProfile?: string;
  experienceLevel?: string;
  minDailySalary?: number;
  maxDailySalary?: number;
  minAnnualSalary?: number;
  maxAnnualSalary?: number;
  duration?: number;
  remoteMode?: string;
  contracts?: string[];
  location?: {
    locality?: string;
    adminLevel1?: string;
    shortLabel?: string;
    label?: string;
    countryCode?: string;
    country?: string;
  };
  company?: {
    name?: string;
  };
  skills?: Array<{ name: string }>;
  publishedAt?: string;
  expiredAt?: string;
  jobPostingType?: string;
  job?: {
    slug?: string;
    nameForUserSlug?: string;
  };
}

function buildSearchUrl(query: string, page: number): string {
  const params = new URLSearchParams({ query, page: String(page) });
  return `${FREE_WORK_CONFIG.BASE_URL}?${params}`;
}

async function fetchHtml(url: string, timeout: number): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': HTTP_CONFIG.USER_AGENT,
      Accept: HTTP_CONFIG.ACCEPT,
      'Accept-Language': HTTP_CONFIG.ACCEPT_LANGUAGE,
    },
    signal: AbortSignal.timeout(timeout),
  });

  if (!resp.ok) {
    throw new Error(`Free-Work HTTP ${resp.status}: ${url}`);
  }

  return resp.text();
}

/**
 * Extract job listings from the Nuxt SSR hydration state.
 * The data lives in a <script> tag: window.__NUXT__ = (function(...){...})(...);
 * Inside: __NUXT__.fetch[0].jobs (array of NuxtJob).
 */
function extractNuxtJobs(html: string): NuxtJob[] {
  const $ = cheerio.load(html);
  let nuxtData: Record<string, unknown> | null = null;

  $('script:not([src])').each((_: number, el: any) => {
    const content = $(el).html() || '';
    if (!content.includes('window.__NUXT__')) return;

    try {
      const sandbox = { window: {} as Record<string, unknown> };
      runInNewContext(content, sandbox, { timeout: 5000 });
      nuxtData = sandbox.window.__NUXT__ as Record<string, unknown>;
    } catch {
      // Malformed script, skip
    }
  });

  if (!nuxtData) return [];

  // Jobs are in fetch[0].jobs or fetch[N].jobs
  const fetchEntries = (nuxtData as Record<string, unknown>).fetch;
  if (!fetchEntries || typeof fetchEntries !== 'object') return [];

  for (const entry of Object.values(fetchEntries as Record<string, unknown>)) {
    if (
      entry &&
      typeof entry === 'object' &&
      'jobs' in entry &&
      Array.isArray((entry as Record<string, unknown>).jobs)
    ) {
      return (entry as Record<string, unknown>).jobs as NuxtJob[];
    }
  }

  return [];
}

function mapRemotePolicy(remoteMode?: string): RemotePolicy {
  if (!remoteMode) return 'unknown';
  const mode = remoteMode.toLowerCase();
  if (mode === 'fullremote' || mode === 'full') return 'remote';
  if (mode === 'hybrid' || mode === 'partial') return 'hybrid';
  if (mode === 'onsite' || mode === 'no') return 'onsite';
  return 'unknown';
}

function mapContractType(contracts?: string[]): ContractType {
  if (!contracts || contracts.length === 0) return 'Unknown';
  if (contracts.includes('contractor')) return 'Freelance';
  if (contracts.includes('permanent')) return 'CDI';
  if (contracts.includes('fixed-term')) return 'CDD';
  if (contracts.includes('internship')) return 'Stage';
  if (contracts.includes('apprenticeship')) return 'Alternance';
  return 'Unknown';
}

function parseExperienceYears(level?: string): number | null {
  if (!level) return null;
  const match = level.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function nuxtJobToOffer(job: NuxtJob, searchProfile: string): RawOffer {
  const location =
    job.location?.shortLabel || job.location?.label || null;
  const company = job.company?.name || null;
  const contractType = mapContractType(job.contracts);

  const skills = (job.skills || []).map((s) => s.name).filter(Boolean);

  const offerUrl = `https://www.free-work.com/fr/tech-it/${job.job?.slug || job.job?.nameForUserSlug || 'jobs'}/job-mission/${job.slug}`;

  return {
    source_site: 'free-work',
    search_profile: searchProfile,
    offer_url: offerUrl,
    apply_url: offerUrl,
    collected_at: new Date().toISOString(),
    fingerprint: computeFingerprint(job.title, company, location, contractType),
    title: job.title,
    company,
    requester: null,
    intermediary: null,
    location,
    remote_policy: mapRemotePolicy(job.remoteMode),
    contract_type: contractType,
    salary_min: job.minAnnualSalary ?? null,
    salary_max: job.maxAnnualSalary ?? null,
    daily_rate: job.minDailySalary ?? null,
    currency: 'EUR',
    team_size: null,
    experience_years: parseExperienceYears(job.experienceLevel),
    skills_required: skills,
    skills_optional: [],
    description_raw: job.description || '',
  };
}

/**
 * Check if the listing page has a "next" page link.
 */
function hasNextPage(html: string): boolean {
  const $ = cheerio.load(html);
  return $('a[rel="next"], [class*="next"], [aria-label="Next"]').length > 0;
}

export const freeWorkScraper: Scraper = {
  site: 'free-work',
  name: 'Free-Work',

  async scrape(config: ScraperRunConfig): Promise<RawOffer[]> {
    const allOffers = new Map<string, RawOffer>();
    const terms =
      config.searchTerms.length > 0
        ? config.searchTerms
        : ['PHP', 'Symfony', 'Python', 'DevOps', 'Tech Lead'];

    for (const term of terms) {
      for (let page = 1; page <= config.maxPages; page++) {
        const url = buildSearchUrl(term, page);

        try {
          const html = await fetchHtml(url, config.timeout);

          const jobs = extractNuxtJobs(html);
          if (jobs.length === 0) {
            logger.debug({ term, page }, 'No Nuxt jobs found on page');
            break;
          }

          for (const job of jobs) {
            // Only keep offers located in France
            const country =
              job.location?.countryCode || job.location?.country || '';
            if (country && country !== 'FR' && country !== 'France') continue;

            const offer = nuxtJobToOffer(job, config.searchProfile);
            if (!allOffers.has(offer.fingerprint)) {
              allOffers.set(offer.fingerprint, offer);
            }
          }

          logger.info(
            { term, page, pageJobs: jobs.length, total: allOffers.size },
            'Free-Work page fetched',
          );

          if (!hasNextPage(html)) break;
          if (allOffers.size >= RATE_LIMITS.MAX_RESULTS_PER_SCRAPER) break;

          await new Promise((r) => setTimeout(r, config.requestDelay));
        } catch (err) {
          logger.warn({ term, page, err }, 'Free-Work page fetch failed');
          break;
        }
      }

      // Delay between search terms
      await new Promise((r) => setTimeout(r, config.requestDelay));

      if (allOffers.size >= RATE_LIMITS.MAX_RESULTS_PER_SCRAPER) break;
    }

    const offers = Array.from(allOffers.values());
    logger.info({ total: offers.length }, 'Free-Work scrape completed');
    return offers;
  },

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const html = await fetchHtml(FREE_WORK_CONFIG.BASE_URL, 30_000);
      const jobs = extractNuxtJobs(html);

      if (jobs.length > 0) {
        return { ok: true };
      }

      return {
        ok: false,
        error: `No jobs found in Nuxt state (HTML length: ${html.length})`,
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },
};
