/**
 * Free-Work scraper — French freelance job board.
 * Parses HTML SSR (Nuxt.js) with cheerio + JSON-LD extraction.
 */

import * as cheerio from 'cheerio';

import { logger } from '../../logger.js';
import { FREE_WORK_CONFIG, HTTP_CONFIG, RATE_LIMITS } from '../config.js';
import type { ScrapedOffer, Scraper, ScraperRunConfig } from '../types.js';

interface FreeWorkJsonLd {
  '@type'?: string;
  title?: string;
  name?: string;
  description?: string;
  datePosted?: string;
  validThrough?: string;
  hiringOrganization?: { name?: string };
  jobLocation?: {
    address?: { addressLocality?: string; addressRegion?: string };
  };
  baseSalary?: {
    value?: { minValue?: number; maxValue?: number; value?: number };
  };
  skills?: string[];
  url?: string;
  identifier?: { value?: string };
}

function buildSearchUrl(query: string, page: number): string {
  const params = new URLSearchParams({
    query,
    page: String(page),
  });
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

function extractJsonLd(html: string): FreeWorkJsonLd[] {
  const $ = cheerio.load(html);
  const items: FreeWorkJsonLd[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html();
      if (!raw) return;
      const parsed = JSON.parse(raw);

      // Can be a single object or an array
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        if (
          entry['@type'] === 'JobPosting' ||
          entry['@type'] === 'JobListing'
        ) {
          items.push(entry);
        }
      }
    } catch {
      // Malformed JSON-LD, skip
    }
  });

  return items;
}

function parseJobCardsFromHtml(html: string): ScrapedOffer[] {
  const $ = cheerio.load(html);
  const offers: ScrapedOffer[] = [];

  // Free-Work actual job URLs contain "/job-mission/"
  // e.g. /fr/tech-it/developpeur-php/job-mission/lead-dev-symfony-42
  $('a[href*="/job-mission/"]').each((_: number, el: any) => {
    const $card = $(el);
    const href = $card.attr('href') || '';

    // Extract slug (and optional numeric ID) from URL
    const slugMatch = href.match(/\/job-mission\/([\w-]+?)(?:-(\d+))?$/);
    if (!slugMatch) return;

    const slug = slugMatch[1];
    const platformId = slugMatch[2] || slug;

    // Title from .job-title inside the card
    const title = $card.find('.job-title').first().text().trim();
    if (!title || title.length < 3) return;

    const fullUrl = `https://www.free-work.com${href}`;

    // Extract tags (Freelance/CDI) from the card
    const tags = $card
      .find('.tag, [class*="tag"]')
      .map((_: number, t: any) => $(t).text().trim())
      .get();
    const isFreelance = tags.some((t: string) => /freelance/i.test(t));
    const isCdi = tags.some((t: string) => /cdi/i.test(t));

    offers.push({
      platform: 'free-work',
      platformId,
      title,
      url: fullUrl,
      offerType: isFreelance ? 'freelance' : isCdi ? 'cdi' : 'freelance',
    });
  });

  return offers;
}

function jsonLdToOffer(item: FreeWorkJsonLd): ScrapedOffer | null {
  const title = item.title || item.name;
  if (!title) return null;

  const id =
    item.identifier?.value ||
    item.url?.match(/(\d+)$/)?.[1] ||
    title.replace(/\W+/g, '-').slice(0, 50);

  let tjmMin: number | undefined;
  let tjmMax: number | undefined;
  if (item.baseSalary?.value) {
    const sal = item.baseSalary.value;
    tjmMin = sal.minValue ?? sal.value;
    tjmMax = sal.maxValue ?? sal.value;
  }

  const location = item.jobLocation?.address
    ? [
        item.jobLocation.address.addressLocality,
        item.jobLocation.address.addressRegion,
      ]
        .filter(Boolean)
        .join(', ')
    : undefined;

  return {
    platform: 'free-work',
    platformId: String(id),
    title,
    description: item.description,
    buyer: item.hiringOrganization?.name,
    location,
    tjmMin,
    tjmMax,
    skills: item.skills,
    offerType: 'freelance',
    url:
      item.url ||
      `${FREE_WORK_CONFIG.BASE_URL}/${title.toLowerCase().replace(/\s+/g, '-')}-${id}`,
    deadline: item.validThrough,
    datePublished: item.datePosted,
  };
}

export const freeWorkScraper: Scraper = {
  platform: 'free-work',
  name: 'Free-Work',

  async scrape(config: ScraperRunConfig): Promise<ScrapedOffer[]> {
    const allOffers = new Map<string, ScrapedOffer>();
    const terms =
      config.searchTerms.length > 0
        ? config.searchTerms
        : ['PHP', 'Symfony', 'Python', 'DevOps', 'Tech Lead'];

    for (const term of terms) {
      for (let page = 1; page <= config.maxPages; page++) {
        const url = buildSearchUrl(term, page);

        try {
          const html = await fetchHtml(url, config.timeout);

          // Try JSON-LD first (most reliable)
          const jsonLdItems = extractJsonLd(html);
          if (jsonLdItems.length > 0) {
            for (const item of jsonLdItems) {
              const offer = jsonLdToOffer(item);
              if (offer && !allOffers.has(offer.platformId)) {
                allOffers.set(offer.platformId, offer);
              }
            }
          }

          // Fallback: parse HTML cards
          if (jsonLdItems.length === 0) {
            const htmlOffers = parseJobCardsFromHtml(html);
            for (const offer of htmlOffers) {
              if (!allOffers.has(offer.platformId)) {
                allOffers.set(offer.platformId, offer);
              }
            }
          }

          logger.info(
            { term, page, found: allOffers.size },
            'Free-Work page fetched',
          );

          // Check if there are more pages
          const $ = cheerio.load(html);
          const hasNext =
            $('a[rel="next"], [class*="next"], [aria-label="Next"]').length > 0;
          if (!hasNext) break;

          if (allOffers.size >= RATE_LIMITS.MAX_RESULTS_PER_SCRAPER) break;

          // Rate limit
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

      // Check JSON-LD
      const jsonLd = extractJsonLd(html);
      if (jsonLd.length > 0) {
        return { ok: true };
      }

      // Fallback: check HTML cards
      const cards = parseJobCardsFromHtml(html);
      if (cards.length > 0) {
        return { ok: true };
      }

      return {
        ok: false,
        error: 'No job cards or JSON-LD found on Free-Work',
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },
};
