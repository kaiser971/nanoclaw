# Architecture technique — Autoapply

## Vue d'ensemble

Autoapply s'intègre dans l'architecture NanoClaw existante en suivant les patterns établis :
- **Scrapers** tournent côté host (même process Node.js)
- **CV Adapter** et **Profile Sync** tournent dans les containers agent (Claude)
- **Communication** via IPC (fichiers JSON) et MCP tools

## Diagramme de flux

```
                    ┌─── Cron 3x/jour (8h, 12h, 18h) ───┐
                    ▼                                       │
┌──────────────────────────────────────────────────────────┐│
│                    HOST (Node.js)                          ││
│                                                           ││
│  ┌──────────────┐    ┌───────────┐    ┌───────────────┐  ││
│  │ Task         │───▶│ Scraper   │───▶│ SQLite        │  ││
│  │ Scheduler    │    │ Orchestr. │    │ freelance_*   │  ││
│  └──────────────┘    └─────┬─────┘    └───────┬───────┘  ││
│                            │                   │          ││
│  ┌─────────────────────────▼───────────────────▼───────┐ ││
│  │  Relevance Scorer (Tier 1)                           │ ││
│  │  Keywords matching vs profile.json                   │ ││
│  │  Filtre : score >= 0.3 → passe au container          │ ││
│  └─────────────────────────┬───────────────────────────┘ ││
│                            │                              ││
│                   IPC: new_offers.json                     ││
│                  (offres pertinentes)                      ││
└────────────────────────────┼──────────────────────────────┘│
                             ▼                               │
┌──────────────────────────────────────────────────────────┐ │
│              CONTAINER (Claude Agent)                      │ │
│                                                            │ │
│  ┌──────────────────┐  ┌──────────────┐                   │ │
│  │ Tier 2 Scoring   │  │ CV Adapter   │                   │ │
│  │ (Claude sémant.) │─▶│ (.docx manip)│                   │ │
│  └──────────────────┘  └──────┬───────┘                   │ │
│                               │                            │ │
│  ┌────────────────────────────▼──────────────────────────┐│ │
│  │  IPC Output                                            ││ │
│  │  - send_message → digest offres pertinentes            ││ │
│  │  - CV adapté → /workspace/group/cv-versions/           ││ │
│  └────────────────────────────────────────────────────────┘│ │
└───────────────────────────────────────────────────────────┘ │
                                                              │
                    ┌─── Cron hebdo (lundi 9h) ───────────────┘
                    ▼
┌──────────────────────────────────────────────────────────┐
│              CONTAINER (Claude Agent) — Profile Sync       │
│                                                            │
│  ┌──────────────────┐  ┌──────────────┐                   │
│  │ Profile Reader   │  │ Playwright   │                   │
│  │ (profile.json)   │─▶│ (Browser)    │──▶ Plateformes   │
│  └──────────────────┘  └──────────────┘                   │
└───────────────────────────────────────────────────────────┘
```

## Composants

### 1. Scraper Engine (Host-side)

**Localisation** : `src/scrapers/`

Le moteur de scraping tourne dans le process principal NanoClaw. Pas de container car :
- Accès direct à SQLite (pas de latence IPC)
- Pas besoin de Claude pour parser du HTML
- Rate limiting contrôlé directement
- Léger (cheerio, pas de browser)

**Pipeline par run** :
```
config.ts → orchestrator.ts → [platform scraper] → déduplication → freelance-db.ts → relevance.ts
```

1. L'orchestrateur itère sur les scrapers actifs
2. Chaque scraper retourne un `ScrapedOffer[]`
3. Déduplication via `platform + platform_id` (clé composite)
4. Stockage en DB avec status `'new'`
5. Scoring Tier 1 sur les nouvelles offres
6. Les offres avec `score >= seuil` sont écrites en IPC pour le container

### 2. Relevance Scorer (Host-side)

**Localisation** : `src/scrapers/relevance.ts`

Deux niveaux de scoring :

| Tier | Où | Comment | Seuil |
|------|-----|---------|-------|
| Tier 1 | Host (Node.js) | Matching mots-clés vs `profile.json` | score >= 0.3 |
| Tier 2 | Container (Claude) | Analyse sémantique contextuelle | score >= 0.6 |

Le Tier 1 est rapide et élimine les offres clairement hors scope (ex: SAP, COBOL quand le profil est PHP/Python). Le Tier 2 capture les correspondances subtiles (ex: "modernisation d'application legacy" = migration PHP).

### 3. CV Adapter (Container skill)

**Localisation** : `container/skills/freelance-cv/SKILL.md`

Exécuté dans le container agent quand des offres pertinentes sont identifiées :
- Lit `profile.json` (profil complet)
- Lit `cv-base.docx` (template)
- Analyse chaque offre pertinente
- Génère un CV adapté par offre (.docx)
- Stocke les notes d'adaptation en DB

### 4. Profile Sync (Container skill)

**Localisation** : `container/skills/freelance-profiles/SKILL.md`

Tâche hebdomadaire via Playwright :
- Lit `profile.json` pour les données à jour
- Se connecte aux plateformes (auth-state persisté)
- Met à jour le profil / CV sur chaque plateforme
- Rapporte les échecs d'auth

### 5. Application Tracker

Suivi du pipeline de candidature :
- Commandes chat : "j'ai postulé à l'offre X", "statut candidatures"
- Table `freelance_applications` avec lifecycle : pending → interview → accepted/rejected
- Digest quotidien : nouvelles offres, deadlines proches, candidatures en attente

## Intégration NanoClaw

### Points d'ancrage existants

| Composant NanoClaw | Utilisation Autoapply |
|---------------------|----------------------|
| `src/db.ts` | Extension schéma SQLite (4 tables `freelance_*`) |
| `src/task-scheduler.ts` | 3 tâches cron (scraping, profils, nettoyage) |
| `src/ipc.ts` | Communication host ↔ container pour offres et CV |
| `src/container-runner.ts` | Exécution des skills CV et profils |
| `src/router.ts` | Envoi des notifications digest |
| `container/skills/` | Skills freelance-cv et freelance-profiles |

### Nouveaux fichiers

| Fichier | Type | Rôle |
|---------|------|------|
| `src/scrapers/types.ts` | Module host | Interfaces partagées |
| `src/scrapers/config.ts` | Module host | Configuration scraping |
| `src/scrapers/orchestrator.ts` | Module host | Orchestration + scheduling |
| `src/scrapers/relevance.ts` | Module host | Scoring Tier 1 |
| `src/scrapers/platforms/*.ts` | Modules host | Scrapers par plateforme |
| `src/freelance-db.ts` | Module host | CRUD freelance |
| `container/skills/freelance-cv/SKILL.md` | Container skill | Adaptation CV |
| `container/skills/freelance-profiles/SKILL.md` | Container skill | Sync profils |
| `data/freelance/profile.json` | Données | Profil pro source de vérité |
| `data/freelance/cv-base.docx` | Données | Template CV |

## Sécurité

- Les scrapers n'accèdent qu'aux données publiques (Priorité 1 = pas d'auth)
- Les credentials des plateformes (Phase 4) sont gérés via `data/freelance-auth/` et injectés dans le container
- Rate limiting strict pour éviter les bans IP
- Pas de données sensibles dans les IPC (juste les offres publiques)
