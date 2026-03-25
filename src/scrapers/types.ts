/** Scraper interfaces for the Autoapply freelance offer system. */

export interface ScrapedOffer {
  platform: string;
  platformId: string;
  title: string;
  description?: string;
  buyer?: string;
  location?: string;
  tjmMin?: number;
  tjmMax?: number;
  skills?: string[];
  offerType: 'freelance' | 'cdi' | 'appel-offre';
  url: string;
  deadline?: string; // ISO 8601
  datePublished?: string; // ISO 8601
  rawData?: Record<string, unknown>;
}

export interface ScraperRunConfig {
  searchTerms: string[];
  maxPages: number;
  requestDelay: number;
  timeout: number;
}

export interface Scraper {
  platform: string;
  name: string;
  scrape(config: ScraperRunConfig): Promise<ScrapedOffer[]>;
  test(): Promise<{ ok: boolean; error?: string }>;
}

/** DB row for freelance_offers table. */
export interface FreelanceOffer extends ScrapedOffer {
  id: string; // platform + '_' + platformId
  dateScraped: string;
  relevanceScore: number;
  relevanceScoreT2?: number;
  status: OfferStatus;
}

export type OfferStatus =
  | 'new'
  | 'analyzed'
  | 'applied'
  | 'rejected'
  | 'expired';
