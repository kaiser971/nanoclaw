# Scrapers — Spécifications par plateforme

## Interface commune

Chaque scraper implémente l'interface `Scraper` :

```typescript
interface Scraper {
  /** Identifiant unique de la plateforme */
  platform: string;

  /** Nom affiché */
  name: string;

  /** Exécute le scraping, retourne les offres trouvées */
  scrape(config: ScraperRunConfig): Promise<ScrapedOffer[]>;

  /** Teste que le site est accessible et le HTML a la structure attendue */
  test(): Promise<{ ok: boolean; error?: string }>;
}

interface ScraperRunConfig {
  searchTerms: string[];
  maxPages: number;
  requestDelay: number;
  timeout: number;
}

interface ScrapedOffer {
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
  deadline?: string;        // ISO 8601
  datePublished?: string;    // ISO 8601
  rawData?: Record<string, unknown>;
}
```

---

## Priorité 1 — Prêts à parser

### 1. BOAMP (API JSON)

| Attribut | Valeur |
|----------|--------|
| Platform | `boamp` |
| Type | `appel-offre` |
| Méthode | API REST (JSON) |
| Volume | 15 800+ avis actifs |
| Effort | Faible — port direct du Python existant |

**API Endpoint** :
```
GET https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/boamp/records
```

**Paramètres** :
```typescript
{
  where: buildWhereClause(searchTerms),   // search(objet, "terme") OR ...
  select: 'idweb,objet,nomacheteur,dateparution,datelimitereponse,nature_categorise_libelle,type_marche,procedure_categorise,descripteur_libelle,url_avis,donnees,gestion',
  order_by: 'dateparution desc',
  limit: 100,
  offset: page * 100,
}
```

**WHERE clause** (port de `_build_where_clause()` Python) :
```
(search(objet,"tierce maintenance applicative") OR search(objet,"développement application web") OR ...)
AND datelimitereponse >= "2026-03-25"
```

**Mapping ScrapedOffer** :
```typescript
{
  platform: 'boamp',
  platformId: record.idweb,
  title: record.objet,
  buyer: record.nomacheteur,
  deadline: record.datelimitereponse,    // format YYYY-MM-DD natif
  datePublished: record.dateparution,
  offerType: 'appel-offre',
  url: `https://www.boamp.fr/pages/avis/?q=idweb:${record.idweb}`,
  // description extraite du XML donnees (parse_donnees_xml)
  // skills extraits des descripteur_libelle
}
```

**HTML complet** (2e requête optionnelle) :
```
GET .../datasets/boamp-html/records?where=idweb="{idweb}"&select=html,htmlsynthese
```

**Notes** :
- Port direct de `tools/boamp/boamp_scraper.py`
- Classification par catégorie (TMA, DEV, FORMATION, IA) via keywords
- Le XML `donnees` contient : lots, CPV codes, lieu d'exécution, durée, valeur estimée, critères
- Pagination : `offset` natif dans l'API

---

### 2. Free-Work (HTML SSR + JSON-LD)

| Attribut | Valeur |
|----------|--------|
| Platform | `free-work` |
| Type | `freelance` |
| Méthode | HTML parsing (cheerio) |
| Volume | 10 700+ offres |
| Effort | Faible |

**URL pattern** :
```
https://www.free-work.com/fr/tech-it/jobs?query={query}&page={page}
```

**Sélecteurs cheerio** :
```typescript
// Liste des offres
const cards = $('a[data-cy="job-card"]');  // ou équivalent Nuxt.js

// JSON-LD structuré (dans <script type="application/ld+json">)
const jsonLd = JSON.parse($('script[type="application/ld+json"]').html());
// Schema.org JobPosting → title, description, datePosted, validThrough, hiringOrganization

// Par carte (fallback si pas de JSON-LD)
card.find('.job-title').text();           // titre
card.find('.company-name').text();        // entreprise
card.find('.location').text();            // localisation
card.find('.salary, .tjm').text();        // TJM
card.find('.skills .tag').map();          // compétences
card.attr('href');                        // URL détail
```

**Notes** :
- Nuxt.js SSR → HTML complet sans JS
- JSON-LD au format Schema.org `JobPosting` (meilleure source de données)
- Sitemap disponible pour crawl exhaustif
- Pas d'auth pour consulter

---

### 3. Freelance-Informatique (HTML SSR)

| Attribut | Valeur |
|----------|--------|
| Platform | `freelance-info` |
| Type | `freelance` |
| Méthode | HTML parsing |
| Volume | 1 111+ offres |
| Effort | Faible |

**URL pattern** :
```
https://www.freelance-informatique.fr/offres-freelance?query={query}&page={page}
```

**Sélecteurs** (à confirmer lors de l'implémentation) :
```typescript
// Liste des offres
const offers = $('.offer-card, .mission-card');

// Détails par offre
offer.find('.title, h2, h3').text();
offer.find('.company').text();
offer.find('.location').text();
offer.find('.tjm, .rate').text();         // Format: "500-600 €/j"
offer.find('.skills .tag, .skill').map();
offer.find('a').attr('href');
```

**Notes** :
- HTML classique, pas de framework JS
- URL patterns clairs, sitemap disponible
- Pagination standard `?page=N`

---

### 4. Codeur.com (HTML + JSON-LD)

| Attribut | Valeur |
|----------|--------|
| Platform | `codeur` |
| Type | `freelance` |
| Méthode | HTML parsing |
| Volume | ~15/page, pagination |
| Effort | Faible |

**URL pattern** :
```
https://www.codeur.com/projects?page={page}
https://www.codeur.com/projects/{id}     (détail)
```

**Données disponibles** :
- IDs séquentiels
- Budget visible
- Skills listées
- Date de publication
- Description du projet

**Notes** :
- JSON-LD possible sur les pages détail
- Pas d'auth requise
- Modèle "enchères" : budget proposé par le client

---

### 5. 404Works (HTML simple)

| Attribut | Valeur |
|----------|--------|
| Platform | `404works` |
| Type | `freelance` |
| Méthode | HTML parsing |
| Volume | 3 356 projets (168 pages) |
| Effort | Très faible |

**URL pattern** :
```
https://www.404works.com/fr/projects?page={page}
```

**Notes** :
- HTML le plus simple de tous
- Aucun anti-bot
- Métadonnées complètes dans le HTML
- Pagination numérique standard

---

### 6. Marchés Online (HTML SSR)

| Attribut | Valeur |
|----------|--------|
| Platform | `marches-online` |
| Type | `appel-offre` |
| Méthode | HTML parsing |
| Volume | 13 800+ appels d'offre |
| Effort | Faible |

**URL pattern** :
```
https://www.marchesonline.com/appels-offres/en-cours?q={query}&page={page}
```

**Notes** :
- HTML bien structuré
- Pagination standard
- Aucun anti-bot
- Service payant pour accès complet, mais les résumés sont publics

---

### 7. PLACE (HTML SSR — jQuery)

| Attribut | Valeur |
|----------|--------|
| Platform | `place` |
| Type | `appel-offre` |
| Méthode | HTML parsing |
| Volume | ~1 999 avis |
| Effort | Faible |

**URL pattern** :
```
https://www.marches-publics.gouv.fr/?page=Entreprise.EntrepriseAdvancedSearch
  &searchAnnCons
  &keywords={query}
```

**Notes** :
- HTML classique avec jQuery
- 10-20 résultats par page
- Matomo uniquement (pas d'anti-bot)
- Même code/plateforme que Maximilien

---

### 8. Maximilien (réutilise PLACE)

| Attribut | Valeur |
|----------|--------|
| Platform | `maximilien` |
| Type | `appel-offre` |
| Méthode | Réutilise le scraper PLACE |
| Volume | Variable (IDF uniquement) |
| Effort | Très faible (même code) |

**URL pattern** :
```
https://marches.maximilien.fr/?page=Entreprise.EntrepriseAdvancedSearch
  &searchAnnCons
  &keywords={query}
```

**Implémentation** : `PlaceScraper` avec baseUrl configurable.

---

### 9. Externatic (HTML SSR — le plus simple)

| Attribut | Valeur |
|----------|--------|
| Platform | `externatic` |
| Type | `freelance` / `cdi` |
| Méthode | HTML parsing |
| Volume | ~200 offres |
| Effort | Très faible |

**URL pattern** :
```
https://www.externatic.fr/offres?pg={page}
```

**Notes** :
- Le plus simple à parser de toute la liste
- Salaires visibles
- Pagination `?pg=N`
- Matomo uniquement

---

### 10. Michael Page (HTML SSR)

| Attribut | Valeur |
|----------|--------|
| Platform | `michael-page` |
| Type | `cdi` / `freelance` |
| Méthode | HTML parsing |
| Volume | ~266 offres tech |
| Effort | Faible |

**URL pattern** :
```
https://www.michaelpage.fr/jobs/technology?page={page}
https://www.michaelpage.fr/job-detail/{slug}/ref/{id}   (détail)
```

**Notes** :
- HTML propre
- Données structurées en JavaScript inline
- Pattern URL clair avec slug + ref ID

---

## Pattern d'implémentation

Chaque scraper suit le même squelette :

```typescript
// src/scrapers/platforms/example.ts
import * as cheerio from 'cheerio';
import { Scraper, ScrapedOffer, ScraperRunConfig } from '../types';
import { PLATFORM_URLS, RATE_LIMITS } from '../config';
import { fetchWithDelay } from '../utils';

export const exampleScraper: Scraper = {
  platform: 'example',
  name: 'Example Platform',

  async scrape(config: ScraperRunConfig): Promise<ScrapedOffer[]> {
    const offers: ScrapedOffer[] = [];

    for (let page = 1; page <= config.maxPages; page++) {
      const url = PLATFORM_URLS.example.page.replace('{page}', String(page));
      const html = await fetchWithDelay(url, config.requestDelay, config.timeout);
      const $ = cheerio.load(html);

      const cards = $('.offer-card');
      if (cards.length === 0) break; // fin de pagination

      cards.each((_, el) => {
        offers.push({
          platform: 'example',
          platformId: $(el).attr('data-id') || '',
          title: $(el).find('.title').text().trim(),
          // ... mapping
        });
      });
    }

    return offers;
  },

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const html = await fetch(PLATFORM_URLS.example.base).then(r => r.text());
      const $ = cheerio.load(html);
      const hasOffers = $('.offer-card').length > 0;
      return { ok: hasOffers, error: hasOffers ? undefined : 'No offer cards found' };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
};
```

## Validation structurelle

Chaque scraper a un `test()` qui vérifie :
1. Le site est accessible (HTTP 200)
2. La structure HTML attendue est présente (sélecteurs CSS retournent des résultats)
3. Les champs critiques sont extractibles (title, url au minimum)

Exécuté au démarrage + loggué. Les scrapers en échec sont ignorés (pas bloquants).
