/** Configuration for the Autoapply scraping system. */

// --- Search terms (ported from tools/boamp/config.py + extended) ---

export const SEARCH_CATEGORIES = {
  TMA: [
    'tierce maintenance applicative',
    'maintenance applicative',
    'TMA applicative',
    'TMA web',
    'MCO applicatif',
    'MCO logiciel',
    'maintenance logicielle',
  ],
  DEV: [
    'développement application web',
    'création application web',
    'développement site internet',
    'conception application web',
    'développement logiciel web',
    'refonte site web',
    'refonte application web',
    'développement fullstack',
    'développement frontend',
    'développement backend',
    'portail web',
    'intranet',
    'extranet',
    'application mobile',
  ],
  FORMATION: [
    'formation développement web',
    'e-learning',
    'plateforme e-learning',
    'plateforme formation en ligne',
    'learning management system',
    'digital learning',
    'formation numérique informatique',
  ],
  IA: [
    'intelligence artificielle',
    'développement IA',
    'chatbot IA',
    'machine learning',
    'data science',
    'deep learning',
    'traitement automatique du langage naturel',
    'analyse prédictive données',
    'solution IA',
  ],
} as const;

export const ALL_SEARCH_TERMS = Object.values(SEARCH_CATEGORIES).flat();

/** Terms used to search freelance job boards. Kept specific to avoid noise. */
export const FREELANCE_SEARCH_TERMS = [
  'PHP Symfony',
  'PHP Laravel',
  'Développeur PHP',
  'Lead Dev PHP',
  'Tech Lead PHP',
  'Chef de projet web',
  'Full Stack PHP',
  'Symfony développeur',
  'TMA applicative',
  'Maintenance applicative',
];

// --- Rate limits ---

export const RATE_LIMITS = {
  SAME_DOMAIN_DELAY: 2000,
  INTER_SCRAPER_DELAY: 5000,
  MAX_PAGES_PER_RUN: 50,
  REQUEST_TIMEOUT: 30_000,
  MAX_RESULTS_PER_SCRAPER: 200,
  /** Stop scraping once this many NEW (non-duplicate) offers are found per scraper. */
  MAX_NEW_RESULTS: parseInt(process.env.AUTOAPPLY_MAX_NEW_RESULTS || '3', 10),
} as const;

// --- BOAMP API ---

export const BOAMP_CONFIG = {
  API_BASE: 'https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets',
  DATASET: 'boamp',
  DATASET_HTML: 'boamp-html',
  NOTICE_URL_TEMPLATE: 'https://www.boamp.fr/pages/avis/?q=idweb:{idweb}',
  NOTICE_TYPES: ['Avis de marché/', 'Avis de marché'],
  MAX_RESULTS: 100,
} as const;

// --- Free-Work ---

export const FREE_WORK_CONFIG = {
  BASE_URL: 'https://www.free-work.com/fr/tech-it/jobs',
} as const;

// --- Scheduling ---

export const SCHEDULE_CONFIG = {
  SCRAPING_CRON: process.env.AUTOAPPLY_SCRAPING_CRON || '0 20 * * *',
  PROFILE_SYNC_CRON: '0 9 * * 1',
  CLEANUP_CRON: '0 2 * * *',
  OFFER_RETENTION_DAYS: 90,
} as const;

// --- Scoring ---

export const SCORING_CONFIG = {
  TIER1_THRESHOLD: parseFloat(process.env.AUTOAPPLY_TIER1_THRESHOLD || '0.3'),
  TIER2_THRESHOLD: 0.6,
  MAX_OFFERS_FOR_TIER2: 20,
  TIER1_WEIGHTS: {
    skillMatch: 0.40,
    experienceMatch: 0.20,
    locationMatch: 0.15,
    tjmMatch: 0.15,
    freshnessBonus: 0.10,
  },
} as const;

// --- HTTP ---

export const HTTP_CONFIG = {
  USER_AGENT:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ACCEPT:
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  ACCEPT_LANGUAGE: 'fr-FR,fr;q=0.9,en;q=0.5',
} as const;
