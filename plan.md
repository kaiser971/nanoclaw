# Plan — Outil Freelance : Scraping d'offres + CV adaptatif

> Date : 2026-03-25

## Vision

Un système intégré à NanoClaw qui :
1. **Scrape** les offres freelance et appels d'offre des plateformes françaises
2. **Adapte automatiquement** le CV à chaque offre pertinente
3. **Gère les profils** sur les différentes plateformes
4. **Notifie** l'utilisateur via WhatsApp/Telegram des nouvelles opportunités

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     NanoClaw (Host)                       │
│                                                           │
│  ┌─────────────────┐   ┌──────────────┐   ┌───────────┐ │
│  │ Scraper Engine   │──▶│  SQLite DB    │◀──│ Task      │ │
│  │ (cheerio + fetch)│   │ (freelance_*) │   │ Scheduler │ │
│  └────────┬────────┘   └──────┬───────┘   └─────┬─────┘ │
│           │                    │                   │       │
│           ▼                    ▼                   ▼       │
│  ┌─────────────────────────────────────────────────────┐  │
│  │              IPC (new_offers.json)                   │  │
│  └─────────────────────┬───────────────────────────────┘  │
└────────────────────────┼──────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────┐
│              Agent Container (Claude)                     │
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ CV Adapter    │  │ Profile Sync │  │ agent-browser  │ │
│  │ (docx manip.) │  │ (Playwright) │  │ (Chromium)     │ │
│  └──────────────┘  └──────────────┘  └────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

---

## Modèle de données (SQLite)

### Table `freelance_offers`
| Colonne | Type | Description |
|---------|------|-------------|
| id | TEXT PK | platform_slug + platform_id |
| platform | TEXT | 'free-work', 'boamp', etc. |
| platform_id | TEXT | ID sur la plateforme source |
| title | TEXT | Titre de l'offre |
| description | TEXT | Description complète |
| buyer | TEXT | Entreprise / organisme |
| location | TEXT | Localisation |
| tjm_min | REAL | TJM minimum |
| tjm_max | REAL | TJM maximum |
| skills | TEXT | JSON array de compétences |
| offer_type | TEXT | 'freelance', 'cdi', 'appel-offre' |
| url | TEXT | Lien direct vers l'offre |
| deadline | TEXT | Date limite ISO |
| date_published | TEXT | Date de publication |
| date_scraped | TEXT | Date de scraping |
| raw_data | TEXT | JSON brut de l'offre complète |
| relevance_score | REAL | Score 0-1 calculé |
| status | TEXT | 'new', 'analyzed', 'applied', 'rejected', 'expired' |

### Table `freelance_cv_versions`
| Colonne | Type | Description |
|---------|------|-------------|
| id | TEXT PK | UUID |
| offer_id | TEXT FK | Référence vers freelance_offers |
| cv_path | TEXT | Chemin vers le .docx généré |
| adaptation_notes | TEXT | Ce qui a été modifié et pourquoi |
| created_at | TEXT | Date de création |

### Table `freelance_profiles`
| Colonne | Type | Description |
|---------|------|-------------|
| id | TEXT PK | UUID |
| platform | TEXT UNIQUE | Nom de la plateforme |
| username | TEXT | Identifiant sur la plateforme |
| profile_url | TEXT | URL du profil |
| last_synced | TEXT | Dernière synchro |
| auth_state_path | TEXT | Chemin vers l'état d'auth |
| status | TEXT | 'active', 'needs-auth', 'disabled' |

### Table `freelance_applications`
| Colonne | Type | Description |
|---------|------|-------------|
| id | TEXT PK | UUID |
| offer_id | TEXT FK | Référence vers freelance_offers |
| cv_version_id | TEXT FK | Référence vers freelance_cv_versions |
| platform | TEXT | Plateforme |
| applied_at | TEXT | Date de candidature |
| response | TEXT | 'pending', 'interview', 'rejected', 'accepted' |
| notes | TEXT | Notes libres |

---

## Structure des fichiers

```
src/scrapers/
  types.ts                    — Interfaces ScrapedOffer, Scraper
  config.ts                   — Termes de recherche, rate limits, URLs
  orchestrator.ts             — Exécute tous les scrapers, déduplique, stocke
  relevance.ts                — Score de pertinence (keywords vs profil)
  platforms/
    boamp.ts                  — API JSON Opendatasoft
    free-work.ts              — HTML SSR + JSON-LD
    freelance-info.ts         — HTML SSR
    codeur.ts                 — HTML + JSON-LD
    404works.ts               — HTML simple
    marches-online.ts         — HTML SSR
    place.ts                  — HTML SSR (jQuery)
    maximilien.ts             — Réutilise le code de PLACE
    externatic.ts             — HTML SSR (le plus simple)
    michael-page.ts           — HTML SSR

src/freelance-db.ts           — Schéma SQLite + CRUD tables freelance

container/skills/freelance-cv/
  SKILL.md                    — Instructions pour adapter les CV

container/skills/freelance-profiles/
  SKILL.md                    — Instructions pour MAJ des profils

data/freelance/
  cv-base.docx                — CV template de base
  profile.json                — Profil professionnel structuré (source de vérité)

data/freelance-auth/
  {platform}/auth-state.json  — État d'authentification par plateforme
```

---

## Choix techniques

| Décision | Choix | Raison |
|----------|-------|--------|
| Parsing HTML | **cheerio** | Léger, pas de browser, suffisant pour les sites SSR (Priorité 1) |
| HTTP | **node-fetch** (natif) | Déjà disponible dans Node.js 18+ |
| Manipulation .docx | **npm docx** ou **python-docx** en container | Reste dans l'écosystème. python-docx dispo dans le container |
| Base de données | **SQLite existant** | Même DB que NanoClaw, transactions partagées, pattern migration existant |
| Langage scrapers | **TypeScript** | Même process Node.js que NanoClaw, accès direct SQLite, cohérent |
| Browser automation | **Playwright** (container) | Déjà installé dans les containers (agent-browser + Chromium) |
| Scheduling | **Task scheduler NanoClaw** | Intégration native, pas de dépendance externe |

---

## Phases d'implémentation

### Phase 1 — MVP : Scraping + Stockage (2 jours)

**Objectif** : Scraper BOAMP et Free-Work, stocker en SQLite, envoyer un digest via messagerie.

- [ ] 1.1 Créer `src/scrapers/types.ts` — interfaces ScrapedOffer et Scraper
- [ ] 1.2 Créer `src/scrapers/config.ts` — termes de recherche (portés depuis `tools/boamp/config.py`), rate limits, URLs
- [ ] 1.3 Implémenter `src/scrapers/platforms/boamp.ts` — port du Python existant vers TypeScript (API JSON Opendatasoft)
- [ ] 1.4 Implémenter `src/scrapers/platforms/free-work.ts` — parsing HTML SSR + extraction JSON-LD
- [ ] 1.5 Créer `src/freelance-db.ts` — migration schéma + CRUD
- [ ] 1.6 Créer `src/scrapers/orchestrator.ts` — exécution, déduplication, stockage
- [ ] 1.7 Brancher sur le task scheduler NanoClaw (cron: `0 8,12,18 * * *`)
- [ ] 1.8 Ajouter dépendance `cheerio` dans `package.json`
- [ ] 1.9 Test end-to-end : scrape → stocke → "montre-moi les nouvelles offres" via chat

### Phase 2 — Scrapers restants (2-3 jours)

**Objectif** : Couvrir les 10 sites Priorité 1.

- [ ] 2.1 Freelance-Informatique, Codeur.com, 404Works (HTML simple)
- [ ] 2.2 Marchés Online, PLACE, Maximilien (appels d'offre publics, PLACE et Maximilien partagent le code)
- [ ] 2.3 Externatic, Michael Page (recrutement IT)
- [ ] 2.4 Tests unitaires pour chaque scraper
- [ ] 2.5 Validation structurelle automatique (chaque scraper a un `test()` qui vérifie que le HTML attendu est présent)

### Phase 3 — Scoring + Adaptation CV (2-3 jours)

**Objectif** : Filtrer les offres pertinentes et générer des CV adaptés.

- [ ] 3.1 Créer `data/freelance/profile.json` — profil structuré (compétences, expériences, formations)
- [ ] 3.2 Implémenter `src/scrapers/relevance.ts` — scoring Tier 1 (keywords côté host, rapide)
- [ ] 3.3 Créer `container/skills/freelance-cv/SKILL.md` — instructions Claude pour adaptation CV
- [ ] 3.4 Implémenter le flux IPC : orchestrator écrit les offres → agent container lit + génère CV adapté
- [ ] 3.5 Manipulation .docx dans le container (réutiliser la logique Python qu'on a développée ce soir)
- [ ] 3.6 Stocker les versions CV dans `freelance_cv_versions`
- [ ] 3.7 Notifier l'utilisateur : top offres + chemin du CV adapté

**Scoring en 2 niveaux** :
- **Tier 1 (host, rapide)** : matching mots-clés vs `profile.json`. Élimine les offres non pertinentes (ex: SAP quand le profil est PHP/Python)
- **Tier 2 (Claude, container)** : analyse sémantique pour les offres qui passent le Tier 1. Capture les correspondances subtiles

### Phase 4 — Gestion des profils (2-3 jours)

**Objectif** : Mettre à jour les profils sur les plateformes automatiquement.

- [ ] 4.1 Créer `container/skills/freelance-profiles/SKILL.md` — flux de login et navigation par plateforme
- [ ] 4.2 Implémenter l'auth interactive (pattern X integration : setup.ts)
- [ ] 4.3 Tester avec Free-Work (plus haute valeur)
- [ ] 4.4 Ajouter les autres plateformes
- [ ] 4.5 Brancher la synchro profils en tâche hebdomadaire (cron: `0 9 * * 1`)

### Phase 5 — Suivi des candidatures + polish (1-2 jours)

**Objectif** : Tracking complet du pipeline de candidature.

- [ ] 5.1 Table `freelance_applications` + CRUD
- [ ] 5.2 Commande chat : "j'ai postulé à l'offre X" → marque comme applied
- [ ] 5.3 Digest quotidien : N nouvelles offres, top 5 par pertinence, deadlines proches
- [ ] 5.4 Nettoyage automatique des offres expirées
- [ ] 5.5 Reporting : "combien d'offres cette semaine ?", "quelle plateforme a le plus ?"

---

## Tâches planifiées

| Tâche | Cron | Description |
|-------|------|-------------|
| Scraping offres | `0 8,12,18 * * *` | 3x/jour : scrape tous les sites, stocke, notifie si nouvelles offres pertinentes |
| Synchro profils | `0 9 * * 1` | Hebdo lundi 9h : met à jour les profils sur toutes les plateformes |
| Nettoyage | `0 2 * * *` | Quotidien 2h : marque les offres expirées, purge les données >90 jours |

---

## Rate limiting

| Paramètre | Valeur | Raison |
|-----------|--------|--------|
| Délai entre requêtes (même domaine) | 2s | Respectueux, évite le ban |
| Délai entre scrapers différents | 5s | Étale la charge |
| Max pages par scraper par run | 50 | Évite les runs trop longs |
| Timeout par requête | 30s | Failsafe |

---

## Risques et mitigations

| Risque | Mitigation |
|--------|------------|
| Changement de structure HTML des sites | Chaque scraper a un `test()` de validation. Les scrapers en échec sont loggués et ignorés, pas bloquants. |
| Rate limiting / blocage IP | Délais conservateurs (2s/requête). Tous les sites P1 confirmés sans anti-bot sur SSR. |
| Qualité de l'adaptation CV | Claude gère le matching sémantique. Qualité dépend du prompt dans SKILL.md. Itération progressive. |
| Problèmes de formatage .docx | Template de base testé. Le container valide le fichier après génération. |
| Expiration de l'auth (profils) | Tâche de vérification hebdomadaire. Si l'auth échoue, notification utilisateur. |
| Volume de données (15K+ offres BOAMP) | Pré-filtrage par termes de recherche côté API. SQLite gère le volume sans problème. |

---

## Fichiers de référence

| Fichier | Utilité |
|---------|---------|
| `sites_a_traiter.md` | Liste complète des sites ciblés |
| `suivi_parsing_sites.md` | Résultats des tests de faisabilité par site |
| `tools/boamp/boamp_scraper.py` | Implémentation Python de référence à porter en TS |
| `tools/boamp/config.py` | Termes de recherche et configuration existants |
| `src/db.ts` | Pattern de migration SQLite à suivre |
| `src/task-scheduler.ts` | Point d'intégration pour les tâches planifiées |
| `.claude/skills/x-integration/SKILL.md` | Pattern architectural pour un feature skill complexe |
| `container/skills/agent-browser/SKILL.md` | Pattern pour l'automatisation browser en container |
