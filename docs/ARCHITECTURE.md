# NanoClaw - Architecture complète

> Dernière mise à jour : 2026-03-27

## Vue d'ensemble

NanoClaw est un assistant personnel Claude fonctionnant en un seul processus Node.js. Il orchestre des canaux de messagerie (WhatsApp, Telegram), des agents IA isolés dans des containers Docker, un scheduler de tâches, et un système de scraping freelance automatisé.

**Principes clés :**
- Un seul processus orchestrateur (pas de microservices)
- Isolation totale des agents dans des containers Docker
- Les secrets ne quittent jamais le host (injection par proxy HTTP)
- État persisté en SQLite
- Extensibilité par skills (branches Git)

---

## Architecture des dossiers

```
nanoclaw/
├── src/                              # Code source principal (TypeScript)
│   ├── index.ts                      # Orchestrateur : boucle messages, invocation agents, sessions
│   ├── ipc.ts                        # Watcher IPC : traite les fichiers échangés avec les containers
│   ├── db.ts                         # Couche SQLite (messages, chats, tasks, sessions, groups)
│   ├── freelance-db.ts               # Extension DB : table freelance_offers
│   ├── config.ts                     # Chemins, intervalles, trigger pattern, timezone
│   ├── types.ts                      # Interfaces globales (Channel, NewMessage, RegisteredGroup)
│   ├── container-runner.ts           # Spawn des containers Docker, mounts, parsing sortie
│   ├── container-runtime.ts          # Abstraction Docker (proxy credentials, host gateway)
│   ├── credential-proxy.ts           # Proxy HTTP : injection API key/OAuth dans les requêtes
│   ├── router.ts                     # Formatage messages (XML escape) et routage sortant
│   ├── group-queue.ts                # File d'attente par groupe (max 5 containers simultanés)
│   ├── group-folder.ts               # Validation et résolution des dossiers groupe
│   ├── task-scheduler.ts             # Exécution des tâches planifiées (cron, interval, once)
│   ├── session-commands.ts           # Commandes session (/compact)
│   ├── sender-allowlist.ts           # Whitelist d'expéditeurs par chat
│   ├── mount-security.ts             # Validation des mounts additionnels
│   ├── logger.ts                     # Configuration Pino logger
│   ├── channels/                     # Implémentations canaux (auto-enregistrement au démarrage)
│   │   ├── registry.ts               # Registre et interface Channel
│   │   ├── whatsapp.ts               # WhatsApp via Baileys
│   │   └── telegram.ts               # Telegram via Grammy
│   └── scrapers/                     # Système de scraping freelance
│       ├── types.ts                  # Interfaces Scraper, ScrapedOffer, ScraperRunConfig
│       ├── config.ts                 # Termes de recherche, rate limits, URLs, seuils scoring
│       ├── orchestrator.ts           # Exécution séquentielle des scrapers, dédup, stockage DB
│       ├── relevance.ts              # Scoring Tier 1 (mots-clés vs profile.json)
│       └── platforms/                # Scrapers par plateforme
│           ├── boamp.ts              # Appels d'offre publics (API OpenDataSoft)
│           ├── free-work.ts          # Free-Work (HTML SSR + Nuxt hydration)
│           └── freelance-informatique.ts  # Freelance-Informatique (HTML SSR)
│
├── container/                        # Code agent (exécuté dans Docker)
│   ├── Dockerfile                    # Image multi-stage (Node 24, Chromium, LibreOffice)
│   ├── build.sh                      # Script de build
│   ├── agent-runner/                 # Agent Claude SDK
│   │   └── src/
│   │       ├── index.ts              # Point d'entrée agent, gestion sessions, streaming
│   │       └── ipc-mcp-stdio.ts      # Protocole IPC agent ↔ host
│   └── skills/                       # Skills chargés dans les containers
│       ├── agent-browser/            # Automatisation navigateur (Playwright/Chromium)
│       ├── status/                   # Reporting système
│       ├── capabilities/             # Découverte des capacités
│       ├── slack-formatting/         # Formatage Slack
│       ├── resume-optimizer/         # Optimisation CV (python-docx)
│       └── freelance-cv/             # Génération CV adaptés par offre
│
├── groups/                           # Mémoire isolée par groupe
│   ├── global/CLAUDE.md              # Instructions système partagées
│   ├── main/CLAUDE.md                # Groupe de contrôle (admin)
│   └── {nom_groupe}/CLAUDE.md        # Mémoire spécifique au groupe
│
├── data/                             # Données runtime
│   ├── ipc/{groupe}/                 # Répertoires IPC (messages, tasks, input, output)
│   ├── freelance/                    # Données système freelance
│   │   ├── profile.json             # Profil utilisateur (skills, TJM, localisation)
│   │   └── CV.docx                  # CV source
│   └── sessions/{groupe}/.claude/    # Sessions persistantes par groupe
│
├── store/                            # Stockage persistant
│   ├── messages.db                   # Base SQLite (tout l'état applicatif)
│   └── auth/                         # Credentials WhatsApp (Baileys)
│
├── tools/                            # Outils externes
│   ├── boamp/                        # Scrapers Python legacy (référence)
│   └── docx2pdf/                     # Convertisseur DOCX → PDF (LibreOffice dans Docker)
│
├── Autoapply/                        # Documentation système Autoapply
│   ├── ARCHITECTURE.md               # Design système
│   ├── SCRAPERS.md                   # Guide d'implémentation scrapers
│   ├── SCORING.md                    # Algorithme de scoring
│   ├── CV-ADAPTER.md                 # Génération CV
│   └── ...                           # Autres docs (phases, scheduler, IPC, config)
│
├── logs/                             # Logs applicatifs
│   ├── nanoclaw.log                  # Stdout du service
│   └── nanoclaw.error.log            # Stderr du service
│
├── .env                              # Variables d'environnement (secrets)
├── CLAUDE.md                         # Instructions système agents
├── package.json                      # Dépendances (Baileys, Grammy, cheerio, sqlite3, pino)
└── tsconfig.json                     # Config TypeScript
```

---

## Flux de messages

```
Utilisateur envoie un message (WhatsApp/Telegram)
        │
        ▼
   Canal reçoit le message → callback onMessage()
        │
        ▼
   Stockage en DB (messages table)
        │
        ▼
   Vérification trigger (@Andy) + sender allowlist
        │
        ▼
   GroupQueue : file d'attente par groupe (max 5 containers)
        │
        ▼
   processGroupMessages() : récupère messages depuis lastAgentTimestamp
        │
        ▼
   Formatage XML : <messages><message sender="..." time="...">contenu</message></messages>
        │
        ▼
   runContainerAgent() : spawn Docker
   ┌──────────────────────────────────────────────────────────┐
   │ Container Docker (nanoclaw-agent:latest)                  │
   │                                                           │
   │  stdin ← ContainerInput JSON (prompt, sessionId, ...)     │
   │  agent-runner → Claude Agent SDK → génère réponse         │
   │  stdout → ---NANOCLAW_OUTPUT_START--- {result} ---END---  │
   │                                                           │
   │  Mounts :                                                 │
   │   /workspace/group  ← groups/{nom}/ (RW)                 │
   │   /workspace/project ← racine projet (RO, main only)     │
   │   /workspace/ipc    ← data/ipc/{groupe}/ (follow-up)     │
   └──────────────────────────────────────────────────────────┘
        │
        ▼
   Host parse les markers, strip <internal> tags
        │
        ▼
   canal.sendMessage(jid, texte) → réponse visible par l'utilisateur
        │
        ▼
   Mise à jour session + lastAgentTimestamp en DB
```

---

## Système de canaux

Les canaux s'auto-enregistrent au démarrage via un pattern factory.

| Canal | Bibliothèque | Auth | JID format |
|-------|-------------|------|------------|
| WhatsApp | Baileys | QR code / pairing code | `120xxx@g.us` / `120xxx@s.whatsapp.net` |
| Telegram | Grammy | Bot token (env) | `tg:123456789` |

Chaque canal implémente l'interface `Channel` :
- `connect()` — Connexion au service
- `sendMessage(jid, text)` — Envoi de message
- `isConnected()` — État de connexion
- `ownsJid(jid)` — Ce JID appartient-il à ce canal ?
- `disconnect()` — Déconnexion propre

---

## Système de groupes et isolation

| Aspect | Main group | Autres groupes |
|--------|-----------|----------------|
| Trigger requis | Non | Oui (@Andy) |
| Accès projet | `/workspace/project` (RO) | Non |
| Accès groupe | `/workspace/group` (RW) | `/workspace/group` (RW) |
| Mémoire | `groups/main/CLAUDE.md` | `groups/{nom}/CLAUDE.md` |
| Session | Isolée par groupe | Isolée par groupe |
| Containers | Séparé | Séparé |

Chaque groupe a :
- Un dossier isolé (`groups/{nom}/`)
- Un fichier mémoire (`CLAUDE.md`)
- Une session persistante (ID stocké en DB)
- Aucun accès croisé entre groupes

---

## Système de credentials (proxy)

Les containers n'ont **jamais** accès aux secrets. Un proxy HTTP injecte les credentials à la volée.

```
Container → HTTP request → Credential Proxy (host:3001) → Anthropic API
                              │
                              └── Injecte x-api-key ou Bearer token
```

Deux modes d'auth :
- **API Key** : injecte `x-api-key` header sur chaque requête
- **OAuth** : échange de token, puis injection du token temporaire

---

## Scheduler de tâches

Interroge la DB toutes les 60 secondes pour les tâches `status='active'` et `next_run <= NOW`.

| Type | Exemple | Description |
|------|---------|-------------|
| `cron` | `0 20 * * *` | Expression cron (timezone IANA) |
| `interval` | `300000` | Millisecondes entre exécutions |
| `once` | `2026-04-01T09:00:00` | Exécution unique |

**Host tasks** : fonctions enregistrées côté host (préfixe `HOST:` dans le prompt). Peuvent optionnellement déclencher un container après exécution (`triggerContainer`).

**Tasks enregistrées :**
- `autoapply_scraping` — Scraping quotidien des offres freelance
- `autoapply_generate_pdfs` — Conversion DOCX → PDF
- `autoapply_generate_messages` — Génération messages de candidature
- `autoapply_cleanup` — Expiration et purge des vieilles offres

---

## Système Autoapply (freelance)

### Pipeline complet

```
  Scraping (host)              Scoring Tier 1 (host)         Scoring Tier 2 + CV (container)
┌──────────────┐            ┌──────────────────┐           ┌─────────────────────────┐
│ Free-Work    │            │ profile.json      │           │ Claude Agent SDK        │
│ Freelance-   │──offres──▶│ Skills: 40%       │──score──▶│ Analyse sémantique      │
│ Informatique │            │ XP: 20%           │ ≥ 0.3    │ Adaptation CV (docx)    │
│ BOAMP (off)  │            │ Location: 15%     │           │ Message candidature     │
└──────────────┘            │ TJM: 15%          │           └──────────┬──────────────┘
                            │ Fraîcheur: 10%    │                      │
                            └──────────────────┘                      ▼
                                                            ┌─────────────────────┐
                                                            │ PDF generation      │
                                                            │ Git commit + push   │
                                                            │ freelance-radar/    │
                                                            └─────────────────────┘
```

### Scrapers actifs

| Plateforme | ID | Méthode | Volume |
|------------|----|---------|--------|
| Free-Work | `free-work` | HTML SSR (Nuxt `__NUXT__` hydration) | 10 700+ |
| Freelance-Informatique | `freelance-info` | HTML SSR (cheerio) | 1 100+ |
| BOAMP | `boamp` | API JSON (OpenDataSoft) | 15 800+ (désactivé) |

### Scoring Tier 1

Chargé depuis `data/freelance/profile.json`. Pondérations :

| Critère | Poids | Description |
|---------|-------|-------------|
| skillMatch | 40% | Correspondance skills offre vs profil (+ aliases) |
| experienceMatch | 20% | Niveau séniorité détecté |
| locationMatch | 15% | Remote, IDF, exclusions géographiques |
| tjmMatch | 15% | Comparaison TJM min/cible du profil |
| freshnessBonus | 10% | Offres récentes favorisées |

Seuil passage Tier 2 : **score ≥ 0.3**

Exclusions automatiques : SAP, Oracle, Salesforce, COBOL, AS400, ERP, MOA/AMOA...

### Post-traitement (onComplete)

Après le container Tier 2 :
1. Génération des PDFs manquants (DOCX → PDF via LibreOffice dans Docker)
2. Commit des PDFs dans le repo
3. Git push vers `freelance-radar`

### Heartbeat

Pendant le traitement container, un message `🔄 Traitement en cours… (X min)` est envoyé toutes les 3 minutes pour indiquer que le système est actif.

### Repo freelance-radar

```
freelance-radar/
├── free-work/                    # Offres Free-Work retenues
│   └── {slug}/
│       ├── description.md        # Détails offre + scoring
│       ├── context.md            # Statut traitement (pending → processed)
│       ├── CV.docx               # CV adapté
│       └── CV.pdf                # PDF généré
├── freelance-info/               # Offres Freelance-Informatique retenues
│   └── {slug}/...
├── applied/                      # Offres avec candidature envoyée
│   └── {slug}/...
└── archived/                     # Offres archivées / expirées
```

---

## Base de données (SQLite)

Fichier unique : `store/messages.db`

### Tables principales

| Table | Rôle |
|-------|------|
| `chats` | Métadonnées des conversations (JID, nom, canal, dernier message) |
| `messages` | Tous les messages (ID, chat_jid, sender, content, timestamp) |
| `scheduled_tasks` | Tâches planifiées (cron/interval/once, prompt, next_run, status) |
| `task_run_logs` | Historique d'exécution des tâches (durée, statut, résultat) |
| `registered_groups` | Groupes enregistrés (JID, folder, trigger, config container) |
| `sessions` | ID de session par groupe (persistence conversations) |
| `router_state` | Curseurs (last_timestamp, last_agent_timestamp par groupe) |
| `freelance_offers` | Offres scrapées (platform, titre, TJM, skills, score, statut) |

### Cycle de vie des offres

```
new → analyzed → applied
       ↓
     rejected / expired → purged (après 90 jours)
```

---

## Configuration (.env)

| Variable | Description | Défaut |
|----------|-------------|--------|
| `ANTHROPIC_API_KEY` | Clé API Anthropic | — |
| `CLAUDE_CODE_OAUTH_TOKEN` | Token OAuth Claude | — |
| `ASSISTANT_NAME` | Nom du trigger | `"Claude"` |
| `TZ` | Fuseau horaire IANA | `Europe/Paris` |
| `CREDENTIAL_PROXY_PORT` | Port du proxy credentials | `3001` |
| `CONTAINER_IMAGE` | Image Docker agent | `nanoclaw-agent:latest` |
| `CONTAINER_TIMEOUT` | Timeout container (ms) | `1800000` (30 min) |
| `MAX_CONCURRENT_CONTAINERS` | Containers simultanés max | `5` |
| `AUTOAPPLY_SCRAPING_CRON` | Cron du scraping | `0 20 * * *` (20h) |
| `AUTOAPPLY_MAX_NEW_RESULTS` | Max nouvelles offres/run | `100` |
| `AUTOAPPLY_TIER1_THRESHOLD` | Seuil scoring Tier 1 | `0.3` |
| `AUTOAPPLY_JOB_REPO` | Chemin repo offres | `../freelance-radar` |

---

## Gestion du service

```bash
# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw

# Développement
npm run dev          # Hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild image Docker agent

# Logs
tail -f logs/nanoclaw.log
tail -f logs/nanoclaw.error.log
```
