/**
 * Freelance-Informatique scraper — French freelance job board.
 * Extracts job data from server-rendered HTML (no JS needed).
 * Listing pages at /offres-freelance?page=N, 50 offers per page.
 */

import * as cheerio from 'cheerio';

import { logger } from '../../logger.js';
import { FREELANCE_INFO_CONFIG, HTTP_CONFIG, RATE_LIMITS } from '../config.js';
import type { ScrapedOffer, Scraper, ScraperRunConfig } from '../types.js';

const BASE_URL = 'https://www.freelance-informatique.fr';

function buildPageUrl(page: number): string {
  if (page <= 1) return `${BASE_URL}${FREELANCE_INFO_CONFIG.LISTING_PATH}`;
  return `${BASE_URL}${FREELANCE_INFO_CONFIG.LISTING_PATH}?page=${page}`;
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
    throw new Error(`Freelance-Informatique HTTP ${resp.status}: ${url}`);
  }

  return resp.text();
}

/**
 * Decode the `data-obf` base64 attribute to get the offer URL path.
 * Example: "L21pc3Npb24tY2hlZi1kZS1wcm9qZXQtMjYwMzI2UzAwMw==" → "/mission-chef-de-projet-260326S003"
 */
function decodeObf(encoded: string): string | null {
  try {
    return Buffer.from(encoded, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

/**
 * Extract the reference ID from a decoded URL path.
 * Pattern: "/mission-...-{REF}" where REF is like "260326S003" or "260326B004"
 */
function extractRefId(urlPath: string): string | null {
  // The ref is the last segment after the final dash, matching the pattern YYMMDD + letter + number
  const match = urlPath.match(/(\d{6}[A-Z]\d{3})$/);
  return match ? match[1] : null;
}

/**
 * Parse a relative date string like "Publiée il y a 4h" or "Publiée aujourd'hui" into ISO 8601.
 */
function parseRelativeDate(text: string): string | undefined {
  const now = new Date();
  const cleaned = text.replace(/Publiée\s*/i, '').trim();

  if (/aujourd'hui/i.test(cleaned)) {
    return now.toISOString().slice(0, 10);
  }
  if (/hier/i.test(cleaned)) {
    now.setDate(now.getDate() - 1);
    return now.toISOString().slice(0, 10);
  }

  const hoursMatch = cleaned.match(/il y a (\d+)\s*h/i);
  if (hoursMatch) {
    now.setHours(now.getHours() - parseInt(hoursMatch[1], 10));
    return now.toISOString().slice(0, 10);
  }

  const daysMatch = cleaned.match(/il y a (\d+)\s*j/i);
  if (daysMatch) {
    now.setDate(now.getDate() - parseInt(daysMatch[1], 10));
    return now.toISOString().slice(0, 10);
  }

  const weeksMatch = cleaned.match(/il y a (\d+)\s*sem/i);
  if (weeksMatch) {
    now.setDate(now.getDate() - parseInt(weeksMatch[1], 10) * 7);
    return now.toISOString().slice(0, 10);
  }

  const monthsMatch = cleaned.match(/il y a (\d+)\s*mois/i);
  if (monthsMatch) {
    now.setMonth(now.getMonth() - parseInt(monthsMatch[1], 10));
    return now.toISOString().slice(0, 10);
  }

  return undefined;
}

/**
 * Parse a French date string "DD/MM/YYYY" into ISO 8601 "YYYY-MM-DD".
 */
function parseFrenchDate(text: string): string | undefined {
  const match = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return undefined;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

interface ParsedCard {
  title: string;
  urlPath: string;
  refId: string;
  description?: string;
  location?: string;
  skills: string[];
  datePublished?: string;
  startDate?: string;
  duration?: string;
}

function parseCards(html: string): ParsedCard[] {
  const $ = cheerio.load(html);
  const cards: ParsedCard[] = [];

  $('div.card.job-card-line').each((_, el) => {
    const card = $(el);

    // Title + URL from data-obf
    const titleSpan = card.find('h2.job-title span.stretched-link[data-obf]');
    const title = titleSpan.text().trim();
    const obfValue = titleSpan.attr('data-obf');
    if (!title || !obfValue) return;

    const urlPath = decodeObf(obfValue);
    if (!urlPath) return;

    const refId = extractRefId(urlPath);
    if (!refId) return;

    // Description (truncated)
    const description = card.find('p.line-clamp-2').text().trim() || undefined;

    // Skills from tags
    const skills: string[] = [];
    card.find('div.tags span').each((_, tag) => {
      const skill = $(tag).text().trim();
      if (skill) skills.push(skill);
    });

    // Metadata from ul > li
    let location: string | undefined;
    let datePublished: string | undefined;
    let startDate: string | undefined;
    let duration: string | undefined;

    card.find('ul li').each((_, li) => {
      const liEl = $(li);
      const text = liEl.text().trim();

      if (liEl.find('.icon-clock').length > 0) {
        datePublished = parseRelativeDate(text);
      } else if (liEl.find('.icon-map').length > 0) {
        location = text;
      } else if (liEl.find('.icon-calendar').length > 0) {
        startDate = parseFrenchDate(text);
      } else if (liEl.find('.icon-time').length > 0) {
        duration = text;
      }
    });

    cards.push({
      title,
      urlPath,
      refId,
      description,
      location,
      skills,
      datePublished,
      startDate,
      duration,
    });
  });

  return cards;
}

function cardToOffer(card: ParsedCard): ScrapedOffer {
  return {
    platform: 'freelance-info',
    platformId: card.refId,
    title: card.title,
    description: card.description,
    location: card.location,
    skills: card.skills.length > 0 ? card.skills : undefined,
    offerType: 'freelance',
    url: `${BASE_URL}${card.urlPath}`,
    deadline: card.startDate, // startDate is the closest thing to a deadline
    datePublished: card.datePublished,
    rawData: {
      duration: card.duration,
      startDate: card.startDate,
    },
  };
}

/**
 * Check if the listing page has a next page link.
 */
function hasNextPage(html: string, currentPage: number): boolean {
  const $ = cheerio.load(html);
  return (
    $(`a.page-link[href*="page=${currentPage + 1}"]`).length > 0 ||
    $('link[rel="next"]').length > 0
  );
}

export const freelanceInfoScraper: Scraper = {
  platform: 'freelance-info',
  name: 'Freelance-Informatique',

  async scrape(config: ScraperRunConfig): Promise<ScrapedOffer[]> {
    const allOffers = new Map<string, ScrapedOffer>();

    for (let page = 1; page <= config.maxPages; page++) {
      const url = buildPageUrl(page);

      try {
        const html = await fetchHtml(url, config.timeout);
        const cards = parseCards(html);

        if (cards.length === 0) {
          logger.debug({ page }, 'Freelance-Info: no cards found on page');
          break;
        }

        for (const card of cards) {
          const offer = cardToOffer(card);
          if (!allOffers.has(offer.platformId)) {
            allOffers.set(offer.platformId, offer);
          }
        }

        logger.info(
          { page, pageCards: cards.length, total: allOffers.size },
          'Freelance-Info page fetched',
        );

        if (!hasNextPage(html, page)) break;
        if (allOffers.size >= RATE_LIMITS.MAX_RESULTS_PER_SCRAPER) break;

        await new Promise((r) => setTimeout(r, config.requestDelay));
      } catch (err) {
        logger.warn({ page, err }, 'Freelance-Info page fetch failed');
        break;
      }
    }

    const offers = Array.from(allOffers.values());
    logger.info({ total: offers.length }, 'Freelance-Info scrape completed');
    return offers;
  },

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const html = await fetchHtml(
        `${BASE_URL}${FREELANCE_INFO_CONFIG.LISTING_PATH}`,
        30_000,
      );
      const cards = parseCards(html);

      if (cards.length > 0) {
        return { ok: true };
      }

      return {
        ok: false,
        error: `No job cards found (HTML length: ${html.length})`,
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },
};
