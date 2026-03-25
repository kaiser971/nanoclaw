# Configuration — Autoapply

## Fichier : `src/scrapers/config.ts`

Configuration centralisée pour tous les scrapers et le système de scoring.

## Termes de recherche

Portés depuis `tools/boamp/config.py` et étendus pour couvrir toutes les plateformes.

```typescript
export const SEARCH_CATEGORIES = {
  TMA: {
    label: 'Tierce Maintenance Applicative',
    terms: [
      'tierce maintenance applicative',
      'maintenance applicative',
      'TMA applicative',
      'TMA web',
      'MCO applicatif',
      'MCO logiciel',
      'maintenance logicielle',
    ],
  },
  DEV: {
    label: 'Développement Web/Application',
    terms: [
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
  },
  FORMATION: {
    label: 'Formation / E-learning',
    terms: [
      'formation développement web',
      'e-learning',
      'plateforme e-learning',
      'plateforme formation en ligne',
      'learning management system',
      'digital learning',
      'formation numérique informatique',
    ],
  },
  IA: {
    label: 'Intelligence Artificielle',
    terms: [
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
  },
  FREELANCE: {
    label: 'Termes freelance (pour les job boards)',
    terms: [
      'PHP', 'Python', 'Node.js', 'TypeScript', 'JavaScript',
      'React', 'Vue.js', 'Angular', 'Next.js',
      'Laravel', 'Symfony', 'Django', 'FastAPI',
      'DevOps', 'Docker', 'Kubernetes', 'CI/CD',
      'PostgreSQL', 'MySQL', 'MongoDB',
      'AWS', 'GCP', 'Azure',
      'Tech Lead', 'Lead Developer', 'Full Stack',
      'Architect', 'CTO',
    ],
  },
} as const;
```

## Rate Limiting

```typescript
export const RATE_LIMITS = {
  /** Délai entre requêtes sur un même domaine (ms) */
  SAME_DOMAIN_DELAY: 2000,

  /** Délai entre scrapers différents (ms) */
  INTER_SCRAPER_DELAY: 5000,

  /** Max pages par scraper par run */
  MAX_PAGES_PER_RUN: 50,

  /** Timeout par requête HTTP (ms) */
  REQUEST_TIMEOUT: 30_000,

  /** Max résultats par scraper par run */
  MAX_RESULTS_PER_SCRAPER: 200,

  /** Nombre max de requêtes concurrentes */
  MAX_CONCURRENT_REQUESTS: 1,
} as const;
```

## URLs des plateformes

```typescript
export const PLATFORM_URLS = {
  boamp: {
    api: 'https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets',
    dataset: 'boamp',
    datasetHtml: 'boamp-html',
    notice: 'https://www.boamp.fr/pages/avis/?q=idweb:{idweb}',
  },
  'free-work': {
    base: 'https://www.free-work.com/fr/tech-it/jobs',
    search: 'https://www.free-work.com/fr/tech-it/jobs?query={query}&page={page}',
  },
  'freelance-info': {
    base: 'https://www.freelance-informatique.fr/offres-freelance',
    search: 'https://www.freelance-informatique.fr/offres-freelance?query={query}&page={page}',
  },
  codeur: {
    base: 'https://www.codeur.com/projects',
    project: 'https://www.codeur.com/projects/{id}',
  },
  '404works': {
    base: 'https://www.404works.com/fr/projects',
    page: 'https://www.404works.com/fr/projects?page={page}',
  },
  'marches-online': {
    base: 'https://www.marchesonline.com/appels-offres/en-cours',
    search: 'https://www.marchesonline.com/appels-offres/en-cours?q={query}&page={page}',
  },
  place: {
    base: 'https://www.marches-publics.gouv.fr',
    search: 'https://www.marches-publics.gouv.fr/?page=Entreprise.EntrepriseAdvancedSearch&searchAnnCons&keywords={query}',
  },
  maximilien: {
    base: 'https://marches.maximilien.fr',
    search: 'https://marches.maximilien.fr/?page=Entreprise.EntrepriseAdvancedSearch&searchAnnCons&keywords={query}',
  },
  externatic: {
    base: 'https://www.externatic.fr/offres',
    page: 'https://www.externatic.fr/offres?pg={page}',
  },
  'michael-page': {
    base: 'https://www.michaelpage.fr/jobs/technology',
    job: 'https://www.michaelpage.fr/job-detail/{slug}/ref/{id}',
  },
} as const;
```

## Scoring

```typescript
export const SCORING_CONFIG = {
  /** Seuil Tier 1 pour passer au container */
  TIER1_THRESHOLD: 0.3,

  /** Seuil Tier 2 pour notification utilisateur */
  TIER2_THRESHOLD: 0.6,

  /** Nombre max d'offres envoyées au container par run */
  MAX_OFFERS_FOR_TIER2: 20,

  /** Poids des critères Tier 1 */
  TIER1_WEIGHTS: {
    skillMatch: 0.40,      // Compétences requises vs profil
    experienceMatch: 0.20, // Niveau d'expérience demandé
    locationMatch: 0.15,   // Localisation / remote
    tjmMatch: 0.15,        // TJM dans la fourchette acceptable
    freshnessBonus: 0.10,  // Bonus pour offres récentes
  },
} as const;
```

## Scheduling

```typescript
export const SCHEDULE_CONFIG = {
  /** Scraping des offres : 1x/jour le soir (machine allumée) */
  SCRAPING_CRON: '0 20 * * *',

  /** Synchro profils : hebdo lundi 9h */
  PROFILE_SYNC_CRON: '0 9 * * 1',

  /** Nettoyage offres : quotidien 2h */
  CLEANUP_CRON: '0 2 * * *',

  /** Rétention des offres en jours */
  OFFER_RETENTION_DAYS: 90,

  /** Rétention des offres appliquées (plus longue) */
  APPLIED_RETENTION_DAYS: 365,
} as const;
```

## User-Agent

```typescript
export const HTTP_CONFIG = {
  USER_AGENT: 'NanoClaw-Autoapply/1.0 (freelance-monitor; +https://github.com/nanoclaw)',
  ACCEPT: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  ACCEPT_LANGUAGE: 'fr-FR,fr;q=0.9,en;q=0.5',
} as const;
```

## Variables d'environnement (optionnelles)

| Variable | Défaut | Description |
|----------|--------|-------------|
| `AUTOAPPLY_ENABLED` | `true` | Active/désactive le module |
| `AUTOAPPLY_SCRAPING_CRON` | `0 8,12,18 * * *` | Override du cron de scraping |
| `AUTOAPPLY_TIER1_THRESHOLD` | `0.3` | Override seuil Tier 1 |
| `AUTOAPPLY_MAX_PAGES` | `50` | Override max pages par scraper |
| `AUTOAPPLY_DRY_RUN` | `false` | Mode test : scrape sans stocker |
