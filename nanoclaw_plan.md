# NanoClaw — Définition de l'application

## Qu'est-ce que NanoClaw ?

NanoClaw est un assistant personnel basé sur Claude qui tourne comme un unique process Node.js. Il reçoit des messages depuis des canaux de messagerie (WhatsApp, Telegram, Slack, Discord, Gmail), les route vers des agents Claude isolés dans des containers Linux, et renvoie les réponses.

## Architecture générale

```
Canaux (WhatsApp, Telegram, ...)
  ↕ messages
Process Node.js (host)
  ├── Message loop        — polling des nouveaux messages
  ├── Channel registry    — canaux auto-enregistrés au démarrage
  ├── Group queue         — 1 container par groupe, max 5 en parallèle
  ├── Container runner    — spawn docker, pipe stdin/stdout
  ├── IPC watcher         — communication filesystem host ↔ container
  ├── Task scheduler      — cron, interval, one-shot
  ├── Credential proxy    — injecte les secrets sans les exposer aux containers
  ├── Offer store         — persistence filesystem des offres (OFFRES/)
  └── Scraper orchestrator — scraping, scoring Tier 1, déclenchement Tier 2
        ↕ IPC
Containers Linux (agents Claude)
  ├── Claude Code SDK
  ├── Skills (freelance-cv, resume-optimizer, ...)
  ├── Outils (bash, grep, browser, python-docx, ...)
  └── Filesystem isolé par groupe
```

## Composants principaux

### 1. Canaux de messagerie

Système de factory auto-enregistrées. Chaque canal implémente `Channel` (connect, sendMessage, ownsJid, disconnect). Les canaux sont ajoutés via des skills (`/add-whatsapp`, `/add-telegram`, etc.) et se déclarent au startup.

**Fichiers** : `src/channels/registry.ts`, `src/channels/*.ts`

### 2. Groupes et isolation

Chaque groupe de discussion est isolé :
- **Filesystem** : dossier dédié `groups/{folder}/` monté dans le container
- **Mémoire** : `CLAUDE.md` par groupe (contexte persistant)
- **Session** : session Claude Code indépendante par groupe
- **IPC** : répertoire IPC dédié par groupe

Le groupe "main" a des privilèges étendus (gestion des autres groupes, mounts additionnels, tâches cross-groupes).

**Fichiers** : `src/index.ts`, `src/group-folder.ts`, `src/types.ts`

### 3. Containers et exécution

Les agents Claude tournent dans des containers Docker (`nanoclaw-agent:latest`). Le host :
1. Monte les volumes (groupe, IPC, mounts additionnels)
2. Injecte les variables d'environnement (proxy URL, timezone)
3. Pipe le prompt via stdin (JSON)
4. Parse la sortie via des marqueurs `---NANOCLAW_OUTPUT_START/END---`
5. Timeout après 30 minutes par défaut

Les containers n'ont jamais accès aux secrets — le credential proxy (`localhost:3001`) intercepte et injecte les clés API.

**Fichiers** : `src/container-runner.ts`, `src/credential-proxy.ts`, `container/Dockerfile`

### 4. IPC (Inter-Process Communication)

Communication filesystem entre host et containers via `data/ipc/{groupFolder}/` :
- `messages/` : container → host (envoyer un message WhatsApp)
- `tasks/` : container → host (créer/modifier des tâches, lancer des host tasks)
- `input/` : host → container (données pour le container)

Le host poll ce répertoire toutes les secondes.

**Fichiers** : `src/ipc.ts`, `container/agent-runner/src/ipc-mcp-stdio.ts`

### 5. Task scheduler

Tâches planifiées stockées en SQLite. Trois types :
- **cron** : expression cron (`0 20 * * *`)
- **interval** : millisecondes entre chaque exécution
- **once** : exécution unique à une date donnée

Les tâches "HOST:" s'exécutent côté host (scraping, PDF, cleanup). Les autres lancent un container.

**Fichiers** : `src/task-scheduler.ts`, `src/db.ts`

### 6. Group queue et concurrence

File d'attente par groupe. Un seul container par groupe à la fois, max 5 containers en parallèle. Les tâches sont mises en queue et exécutées séquentiellement par groupe.

**Fichier** : `src/group-queue.ts`

---

## Pipeline Autoapply (offres freelance/CDI)

Pipeline automatisé de candidature en deux tiers :

### Tier 1 — Host (scoring par mots-clés)

1. **Scraping** : parcourt les job boards (Free-Work, BOAMP) par profil de recherche
2. **Déduplication** : fingerprint SHA-256 (titre + entreprise + lieu + contrat) + URL
3. **Scoring** : score pondéré (compétences 40%, expérience 20%, localisation 15%, TJM 15%, fraîcheur 10%)
4. **Persistence** : offres au-dessus du seuil (0.3) écrites dans `OFFRES/{site}/{profile}/RECU/` avec `RAW.json` + `DESCRIPTION.md`
5. **Registry** : toutes les offres (même sous le seuil) enregistrées dans `registry.json` pour la dédup

**Fichiers** : `src/scrapers/orchestrator.ts`, `src/scrapers/relevance.ts`, `src/scrapers/platforms/*.ts`, `src/offer-store.ts`

### Tier 2 — Container (scoring sémantique + CV)

Déclenché automatiquement après le scraping si des offres sont en attente dans RECU/ :

1. **Scan** : `find OFFRES -path "*/RECU/*/RAW.json"`
2. **Pour chaque offre** :
   - Lecture du RAW.json
   - Scoring sémantique (correspondances implicites, contexte métier, red flags)
   - Si `apply` ou `maybe` : délègue au skill `resume-optimizer` (copie + adapte le CV via python-docx)
   - Si `skip` : écrit `cause.md` (raison du rejet) puis déplace vers `ARCHIVED/`
3. **Git commit** des offres retenues
4. **Digest** envoyé sur WhatsApp

**Fichiers** : `container/skills/freelance-cv/SKILL.md`, `container/skills/resume-optimizer/SKILL.md`

### Post-Tier 2 — Host (PDF)

Après la fin du container Tier 2, le host lance `autoapply_generate_pdfs` :
- Scanne `RECU/` et `APPLIED/` pour les `CV_*.docx` sans PDF
- Convertit via `docker run docx2pdf:latest` (LibreOffice headless)

### Cycle de vie d'une offre

```
Scraping → RECU/ → Tier 2 scoring
                     ├── apply/maybe → CV adapté + PDF → reste dans RECU/
                     └── skip → cause.md + déplacement ARCHIVED/

Utilisateur : "j'ai postulé" → RECU/ → APPLIED/
Expiration automatique (6 mois) → cause.md + ARCHIVED/
Purge (90 jours en ARCHIVED) → suppression
```

### Structure OFFRES/

```
freelance-radar/OFFRES/
├── registry.json
├── RAPPORT.log
├── queue/
├── {site}/                     # free-work, linkedin, lehibou, boamp
│   └── {profile}/              # lead_dev, php
│       ├── RECU/
│       │   └── {date}_{company}_{title}/
│       │       ├── RAW.json          # Données structurées
│       │       ├── DESCRIPTION.md    # Version lisible
│       │       ├── CV_{COMPANY}.docx # CV adapté
│       │       └── CV_{COMPANY}.pdf  # PDF généré
│       ├── APPLIED/
│       └── ARCHIVED/
│           └── {date}_{company}_{title}/
│               ├── RAW.json
│               ├── DESCRIPTION.md
│               └── cause.md          # Raison de l'archivage
```

### Profils de recherche

Définis dans `src/scrapers/config.ts` :
- `lead_dev` : Lead Dev PHP, Tech Lead PHP, Chef de projet web
- `php` : PHP Symfony, PHP Laravel, Développeur PHP, TMA applicative, etc.

### Profil utilisateur

`data/freelance/profile.json` : compétences, TJM min/cible, localisations préférées, types de contrat acceptés (freelance, cdi, appel-offre), skills exclus.

---

## Sécurité

| Couche | Mécanisme |
|--------|-----------|
| Secrets | Credential proxy — containers ne voient jamais les clés |
| Filesystem | Mount allowlist — seuls les répertoires autorisés sont montés |
| Exécution | Containers Linux isolés, user non-root |
| Messages | Sender allowlist par groupe, trigger word obligatoire |
| Mounts | Validation contre allowlist, non-main forcé en read-only |

---

## Base de données (SQLite)

Tables principales : `chats`, `messages`, `registered_groups`, `sessions`, `scheduled_tasks`, `task_run_logs`, `router_state`.

**Fichier** : `src/db.ts`, stocké dans `store/messages.db`

---

## Configuration

Variables d'environnement clés :

| Variable | Défaut | Description |
|----------|--------|-------------|
| `ASSISTANT_NAME` | Andy | Nom de l'assistant |
| `CONTAINER_TIMEOUT` | 1800000 | Timeout container (30 min) |
| `MAX_CONCURRENT_CONTAINERS` | 5 | Containers simultanés max |
| `CREDENTIAL_PROXY_PORT` | 3001 | Port du proxy credentials |
| `AUTOAPPLY_TIER1_THRESHOLD` | 0.3 | Seuil scoring Tier 1 |
| `AUTOAPPLY_MAX_NEW_RESULTS` | 3 | Max nouvelles offres par site (temp) |
| `AUTOAPPLY_SCRAPING_CRON` | 0 20 * * * | Cron du scraping |
| `TZ` | Europe/Paris | Timezone |

---

## Développement

```bash
npm run dev          # Dev avec hot reload
npm run build        # Compile TypeScript
npm test             # Tests
./container/build.sh # Rebuild image agent
```

## Déploiement

```bash
# Linux (systemd)
systemctl --user start nanoclaw
journalctl --user -u nanoclaw -f

# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```
