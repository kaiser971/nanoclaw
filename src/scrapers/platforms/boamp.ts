/**
 * BOAMP scraper — French government procurement notices.
 * Uses the OpenDataSoft JSON API (no browser needed).
 * Ported from tools/boamp/boamp_scraper.py.
 */

import { logger } from '../../logger.js';
import {
  ALL_SEARCH_TERMS,
  BOAMP_CONFIG,
  HTTP_CONFIG,
  RATE_LIMITS,
} from '../config.js';
import type { ScrapedOffer, Scraper, ScraperRunConfig } from '../types.js';

interface BoampRecord {
  idweb?: string;
  objet?: string;
  nomacheteur?: string;
  dateparution?: string;
  datelimitereponse?: string;
  nature_categorise_libelle?: string;
  type_marche?: string;
  procedure_categorise?: string;
  descripteur_libelle?: string | string[];
  url_avis?: string;
  donnees?: string;
  gestion?: string;
}

function buildWhereClause(searchTerms: string[]): string {
  const parts = searchTerms.map((t) => `search(objet,"${t}")`);
  const today = new Date().toISOString().slice(0, 10);
  return `(${parts.join(' OR ')}) AND datelimitereponse >= "${today}"`;
}

function extractSkills(record: BoampRecord): string[] {
  const descripteurs = record.descripteur_libelle;
  if (!descripteurs) return [];
  if (Array.isArray(descripteurs)) return descripteurs;
  return descripteurs
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function mapToOffer(record: BoampRecord): ScrapedOffer | null {
  if (!record.idweb || !record.objet) return null;

  return {
    platform: 'boamp',
    platformId: record.idweb,
    title: record.objet,
    buyer: record.nomacheteur,
    location: undefined, // Extracted from XML donnees if needed
    skills: extractSkills(record),
    offerType: 'appel-offre',
    url: BOAMP_CONFIG.NOTICE_URL_TEMPLATE.replace('{idweb}', record.idweb),
    deadline: record.datelimitereponse,
    datePublished: record.dateparution,
    rawData: record as Record<string, unknown>,
  };
}

async function fetchPage(
  searchTerms: string[],
  offset: number,
  limit: number,
  timeout: number,
): Promise<{ records: BoampRecord[]; totalCount: number }> {
  const url = `${BOAMP_CONFIG.API_BASE}/${BOAMP_CONFIG.DATASET}/records`;
  const params = new URLSearchParams({
    where: buildWhereClause(searchTerms),
    select:
      'idweb,objet,nomacheteur,dateparution,datelimitereponse,nature_categorise_libelle,type_marche,procedure_categorise,descripteur_libelle,url_avis,donnees,gestion',
    order_by: 'dateparution desc',
    limit: String(limit),
    offset: String(offset),
  });

  const resp = await fetch(`${url}?${params}`, {
    headers: { 'User-Agent': HTTP_CONFIG.USER_AGENT },
    signal: AbortSignal.timeout(timeout),
  });

  if (!resp.ok) {
    throw new Error(`BOAMP API error: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as {
    total_count: number;
    results: BoampRecord[];
  };

  return {
    records: data.results || [],
    totalCount: data.total_count || 0,
  };
}

export const boampScraper: Scraper = {
  platform: 'boamp',
  name: 'BOAMP (Marchés publics)',

  async scrape(config: ScraperRunConfig): Promise<ScrapedOffer[]> {
    const offers: ScrapedOffer[] = [];
    const pageSize = BOAMP_CONFIG.MAX_RESULTS;
    const terms =
      config.searchTerms.length > 0 ? config.searchTerms : ALL_SEARCH_TERMS;

    for (let page = 0; page < config.maxPages; page++) {
      const offset = page * pageSize;

      try {
        const { records, totalCount } = await fetchPage(
          terms,
          offset,
          pageSize,
          config.timeout,
        );

        logger.info(
          { page: page + 1, fetched: records.length, total: totalCount },
          'BOAMP page fetched',
        );

        for (const record of records) {
          const offer = mapToOffer(record);
          if (offer) offers.push(offer);
        }

        // Stop if we've fetched all results or hit the limit
        if (
          records.length < pageSize ||
          offers.length >= RATE_LIMITS.MAX_RESULTS_PER_SCRAPER
        ) {
          break;
        }

        // Rate limit between pages
        if (page < config.maxPages - 1) {
          await new Promise((r) => setTimeout(r, config.requestDelay));
        }
      } catch (err) {
        logger.error({ page, err }, 'BOAMP page fetch failed');
        break;
      }
    }

    logger.info({ total: offers.length }, 'BOAMP scrape completed');
    return offers;
  },

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const { records, totalCount } = await fetchPage(
        ALL_SEARCH_TERMS.slice(0, 3),
        0,
        1,
        10_000,
      );
      if (totalCount === 0 || records.length === 0) {
        return { ok: false, error: 'No results from BOAMP API' };
      }
      const offer = mapToOffer(records[0]);
      if (!offer) {
        return { ok: false, error: 'Failed to map BOAMP record to offer' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },
};
