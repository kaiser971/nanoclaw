/** Type definitions for the Autoapply offer system (OFFRES/ architecture). */

// --- RAW.json schema ---

export type RemotePolicy = 'remote' | 'hybrid' | 'onsite' | 'unknown';

export type ContractType =
  | 'CDI'
  | 'CDD'
  | 'Freelance'
  | 'Portage'
  | 'Stage'
  | 'Alternance'
  | 'Unknown';

/** On-disk RAW.json — one per offer folder. */
export interface RawOffer {
  source_site: string;
  search_profile: string;
  offer_url: string;
  apply_url: string;
  collected_at: string; // ISO 8601 with timezone
  fingerprint: string; // SHA-256 truncated to 16 hex
  title: string;
  company: string | null;
  requester: string | null;
  intermediary: string | null;
  location: string | null;
  remote_policy: RemotePolicy;
  contract_type: ContractType;
  salary_min: number | null;
  salary_max: number | null;
  daily_rate: number | null;
  currency: string;
  team_size: number | null;
  experience_years: number | null;
  skills_required: string[];
  skills_optional: string[];
  description_raw: string;
}

// --- Registry ---

/** One entry per processed offer in registry.json. */
export interface RegistryEntry {
  fingerprint: string;
  offer_url: string;
  folder: string; // Absolute path to offer directory
  site: string;
  search_profile: string;
  collected_at: string;
  tier1_score: number;
}

// --- Queue ---

/** Scraper output file dropped into OFFRES/queue/. */
export interface QueueEntry {
  site: string;
  profile: string;
  collected_at: string;
  total_found: number;
  total_new: number;
  total_duplicates: number;
  urls: string[];
}

// --- Lifecycle ---

export type OfferLifecycle = 'RECU' | 'APPLIED' | 'ARCHIVED';

/** A fully resolved offer = RAW.json + filesystem metadata. */
export interface ResolvedOffer {
  raw: RawOffer;
  folderPath: string;
  status: OfferLifecycle;
  site: string;
  searchProfile: string;
  tier1Score: number;
}

// --- Scraper interfaces ---

export interface ScraperRunConfig {
  searchTerms: string[];
  searchProfile: string;
  maxPages: number;
  requestDelay: number;
  timeout: number;
}

export interface Scraper {
  site: string;
  name: string;
  scrape(config: ScraperRunConfig): Promise<RawOffer[]>;
  test(): Promise<{ ok: boolean; error?: string }>;
}
