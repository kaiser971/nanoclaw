# Autoapply — Scraping d'offres + CV adaptatif

> Module NanoClaw pour la veille freelance automatisée, l'adaptation de CV, et la gestion de candidatures.

## Vue d'ensemble

Autoapply est un système intégré qui :

1. **Scrape** les offres freelance et appels d'offre des plateformes françaises (10 sites Priorité 1)
2. **Score** chaque offre selon la pertinence par rapport au profil professionnel (2 niveaux)
3. **Adapte** automatiquement le CV à chaque offre pertinente
4. **Notifie** via WhatsApp/Telegram avec un digest des meilleures opportunités
5. **Suit** le pipeline de candidature de bout en bout

## Documentation

| Document | Contenu |
|----------|---------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Architecture technique, flux de données, composants |
| [DATABASE.md](DATABASE.md) | Schéma SQLite, migrations, patterns CRUD |
| [SCRAPERS.md](SCRAPERS.md) | Specs par scraper : sélecteurs, URLs, mapping données |
| [SCORING.md](SCORING.md) | Algorithme de scoring (Tier 1 keywords + Tier 2 Claude) |
| [CV-ADAPTER.md](CV-ADAPTER.md) | Skill container pour l'adaptation CV |
| [PROFILE-SYNC.md](PROFILE-SYNC.md) | Synchronisation des profils sur les plateformes |
| [SCHEDULER.md](SCHEDULER.md) | Intégration task scheduler, crons, IPC |
| [IPC-FLOWS.md](IPC-FLOWS.md) | Formats de messages IPC et flux de données |
| [CONFIG.md](CONFIG.md) | Configuration : termes de recherche, rate limits, URLs |
| [PHASES.md](PHASES.md) | Phases d'implémentation avec critères d'acceptation |
| [NOTIFICATIONS.md](NOTIFICATIONS.md) | Système de notifications et format digest |

## Fichiers source (cibles)

```
src/scrapers/
  types.ts                  — Interfaces ScrapedOffer, Scraper
  config.ts                 — Termes de recherche, rate limits, URLs
  orchestrator.ts           — Exécute tous les scrapers, déduplique, stocke
  relevance.ts              — Score de pertinence (Tier 1 host-side)
  platforms/
    boamp.ts                — API JSON Opendatasoft
    free-work.ts            — HTML SSR + JSON-LD
    freelance-info.ts       — HTML SSR
    codeur.ts               — HTML + JSON-LD
    404works.ts             — HTML simple
    marches-online.ts       — HTML SSR
    place.ts                — HTML SSR (jQuery)
    maximilien.ts           — Réutilise le code de PLACE
    externatic.ts           — HTML SSR (le plus simple)
    michael-page.ts         — HTML SSR

src/freelance-db.ts         — Schéma SQLite + CRUD tables freelance

container/skills/freelance-cv/
  SKILL.md                  — Instructions pour adapter les CV

container/skills/freelance-profiles/
  SKILL.md                  — Instructions pour MAJ des profils

data/freelance/
  cv-base.docx              — CV template de base
  profile.json              — Profil professionnel (source de vérité)

data/freelance-auth/
  {platform}/auth-state.json — État d'auth par plateforme
```

## Stack technique

| Composant | Technologie | Raison |
|-----------|-------------|--------|
| Parsing HTML | cheerio | Léger, SSR suffisant pour P1 |
| HTTP | fetch natif (Node 18+) | Pas de dépendance externe |
| Manipulation .docx | docx (npm) / python-docx (container) | Écosystème existant |
| Base de données | SQLite (better-sqlite3) | Même DB NanoClaw |
| Browser automation | Playwright (container) | Déjà installé |
| Scheduling | Task scheduler NanoClaw | Intégration native |
