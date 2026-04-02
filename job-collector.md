# job-collector

Pipeline async Python qui collecte des offres d'emploi depuis plusieurs sites (LinkedIn, LeHibou, ...), extrait les donnees structurees et les stocke localement.

Tourne dans un **container Docker** sous **WSL2**, connecte a un **Brave Browser** ouvert sous Windows via le protocole CDP (Chrome DevTools Protocol).

---

## Fonctionnement general

```
Queue JSON (URLs)
     │
     ▼
┌──────────┐     ┌──────────────┐     ┌──────────────┐     ┌────────────┐
│  Browser  │────▶│   Fetcher    │────▶│  Extractor   │────▶│   Output   │
│  (CDP /   │     │  (par site)  │     │  (par site)  │     │  RAW.json  │
│  cookies) │     │              │     │              │     │  DESC.md   │
└──────────┘     └──────────────┘     └──────────────┘     └────────────┘
                                             │
                                             ▼
                                      ┌──────────────┐
                                      │  Registry    │
                                      │  (dedup URL  │
                                      │  + fingerprint)│
                                      └──────────────┘
```

1. Lit un ou plusieurs fichiers `queue.json` contenant des URLs d'offres
2. Ouvre un navigateur (CDP vers Brave Windows ou Playwright headless + cookies)
3. Pour chaque URL : fetch la page via le fetcher adapte au site
4. Extrait les donnees structurees via l'extracteur adapte au site
5. Deduplique par URL et par fingerprint (titre + entreprise + lieu + contrat)
6. Ecrit `RAW.json` + `DESCRIPTION.md` par offre
7. Met a jour le registre global `registry.json`

---

## Chaine reseau (Docker → Windows)

```
Docker container
  → host.docker.internal (resout vers l'hote WSL2/Windows)
  → Windows port 9222
  → Brave en mode debug (--remote-debugging-port=9222)
```

---

## Structure du projet

```
job-collector/
├── main.py                          # CLI : --queue, --debug, --check-cdp, --stats
│
├── config/
│   ├── settings.py                  # Configuration globale via .env
│   └── sites.py                     # SiteConfig par site (timeouts, defaults)
│
├── core/
│   ├── models.py                    # QueueEntry, RawOffer, RegistryEntry
│   ├── fingerprint.py               # SHA-256 tronque (titre+entreprise+lieu+contrat)
│   └── registry.py                  # Lecture/ecriture registry.json + dedup
│
├── crawler/
│   ├── browser.py                   # Initialisation navigateur (CDP prioritaire, cookies fallback)
│   ├── cdp_connector.py             # Connexion CDP avec fix Host header + WebSocket rewrite
│   ├── cookie_loader.py             # Chargement cookies JSON (fallback)
│   ├── queue_reader.py              # Decouverte et parsing des queue.json
│   └── fetchers/                    # Strategies de chargement par site
│       ├── base.py                  # BaseFetcher (interface)
│       ├── default.py               # DefaultFetcher : goto + networkidle + retries
│       ├── cloudflare.py            # CloudflareFetcher : attente challenge Cloudflare
│       └── factory.py               # Mapping site → fetcher
│
├── extractors/                      # Parsing HTML par site
│   ├── base.py                      # BaseExtractor + methodes partagees
│   ├── utils.py                     # Fonctions pures : remote_policy, experience, Cloudflare
│   ├── generic.py                   # GenericExtractor (fallback og:title, meta, article)
│   ├── linkedin.py                  # LinkedInExtractor (selectors CSS, noise removal)
│   ├── lehibou.py                   # LeHibouExtractor (TJM, skills, villes FR)
│   └── factory.py                   # Mapping site → extracteur
│
├── pipeline/
│   ├── runner.py                    # Orchestration : browser lifecycle, queues, pauses anti-bot
│   └── worker.py                    # Traitement d'une URL : dedup → fetch → extract → persist
│
├── output/
│   ├── raw_writer.py                # Ecrit RAW.json
│   ├── description_writer.py        # Ecrit DESCRIPTION.md
│   └── log_writer.py                # Stats + RAPPORT.log
│
├── OFFRES/                          # Volume Docker — donnees persistantes
│   ├── registry.json
│   ├── RAPPORT.log
│   ├── queue/                       # Input : fichiers queue.json
│   ├── linkedin/
│   │   └── lead_dev/
│   │       ├── RECU/                # Offres collectees
│   │       ├── APPLIED/             # Candidatures envoyees
│   │       └── ARCHIVED/            # Classees/expirees
│   └── lehibou/
│       └── php/
│           ├── RECU/
│           ├── APPLIED/
│           └── ARCHIVED/
│
├── cookies/                         # Fallback : exports JSON Cookie-Editor
├── Dockerfile
├── docker-compose.yml
├── pyproject.toml
└── tests/
```

---

## Pipeline de traitement d'une URL

```
1. URL deja dans registry.json ?
   → oui : skip (doublon URL)

2. Fetch la page via le Fetcher du site
   → CloudflareFetcher si Cloudflare, DefaultFetcher sinon
   → retries jusqu'a MAX_RETRIES
   → echec : skip

3. Extraire les donnees via l'Extracteur du site
   → LinkedInExtractor, LeHibouExtractor, ou GenericExtractor
   → echec : skip

4. Fingerprint deja dans registry.json ?
   → oui : skip (doublon inter-site)

5. Ecrire les fichiers :
   → OFFRES/{site}/{profile}/RECU/{date}_{entreprise}_{titre}/RAW.json
   → OFFRES/{site}/{profile}/RECU/{date}_{entreprise}_{titre}/DESCRIPTION.md

6. Ajouter l'entree dans registry.json
```

---

## Modeles de donnees

### QueueEntry (input)

```json
{
  "site": "lehibou",
  "profile": "php",
  "collected_at": "2026-03-27T23:50:46+01:00",
  "urls": [
    "https://www.lehibou.com/annonce/b5e03ecc-...",
    "https://www.lehibou.com/annonce/36b5d0e9-..."
  ]
}
```

### RawOffer (output — RAW.json)

| Champ              | Type         | Description                                          |
|--------------------|--------------|------------------------------------------------------|
| `source_site`      | `string`     | `"linkedin"`, `"lehibou"`, ...                       |
| `search_profile`   | `string`     | `"lead_dev"`, `"php"`, ...                           |
| `offer_url`        | `string`     | URL de l'offre                                       |
| `apply_url`        | `string?`    | URL de candidature                                   |
| `collected_at`     | `string`     | Timestamp ISO                                        |
| `fingerprint`      | `string`     | Hash SHA-256 16 hex                                  |
| `title`            | `string`     | Intitule du poste                                    |
| `company`          | `string?`    | Entreprise                                           |
| `requester`        | `string?`    | Donneur d'ordre                                      |
| `intermediary`     | `string?`    | Intermediaire / ESN                                  |
| `location`         | `string?`    | Localisation                                         |
| `remote_policy`    | `string`     | `"remote"`, `"hybrid"`, `"onsite"`, `"unknown"`      |
| `contract_type`    | `string`     | `"CDI"`, `"CDD"`, `"Freelance"`, `"Stage"`, `"Alternance"`, `"Unknown"` |
| `salary_min`       | `int?`       | Salaire annuel brut min (EUR)                        |
| `salary_max`       | `int?`       | Salaire annuel brut max (EUR)                        |
| `daily_rate`       | `int?`       | TJM en EUR (freelance)                               |
| `currency`         | `string`     | `"EUR"`                                              |
| `team_size`        | `string?`    | Taille d'equipe                                      |
| `experience_years` | `int?`       | Annees d'experience requises                         |
| `skills_required`  | `string[]`   | Competences requises                                 |
| `skills_optional`  | `string[]`   | Competences optionnelles                             |
| `description_raw`  | `string`     | Description complete nettoyee                        |

### RegistryEntry (dedup)

```json
{
  "fingerprint": "9bc54855bf00105d",
  "offer_url": "https://www.linkedin.com/jobs/view/4296420993/",
  "folder": "/data/OFFRES/linkedin/lead_dev/RECU/2026-03-27_Gorgias_Senior_Backend_Engineer",
  "site": "linkedin",
  "search_profile": "lead_dev",
  "collected_at": "2026-03-27T13:38:42+01:00"
}
```

---

## Ajouter un nouveau site

### 1. Config (`config/sites.py`)

```python
"malt": SiteConfig(name="malt", contract_type_default="Freelance"),
```

### 2. Extracteur (`extractors/malt.py`)

```python
class MaltExtractor(BaseExtractor):
    def extract(self, html, url, site, profile, collected_at) -> RawOffer | None:
        soup = BeautifulSoup(html, "lxml")
        title = ...  # selectors CSS specifiques a Malt
        # _detect_remote_policy(), _extract_experience_years(),
        # _clean_description() sont herites de BaseExtractor
        ...
```

### 3. Factory (`extractors/factory.py`)

```python
"malt": MaltExtractor,
```

### 4. Fetcher custom (si necessaire)

Si le site a un chargement particulier (Cloudflare, scroll, API...) :

```python
# crawler/fetchers/factory.py
"malt": ScrollFetcher,  # ou CloudflareFetcher, ApiFetcher...
```

Sinon le `DefaultFetcher` est utilise automatiquement.

### Resume

| Scenario                     | Fichiers a toucher                                    |
|------------------------------|-------------------------------------------------------|
| Site standard                | sites.py (+1), extractors/{site}.py, factory.py (+1)  |
| Site avec Cloudflare         | idem + fetchers/factory.py (+1)                       |
| Site avec chargement special | idem + nouveau fetcher dans crawler/fetchers/          |

---

## Usage

```bash
# Prerequis : lancer Brave avec CDP
brave.exe --remote-debugging-port=9222

# Build
docker compose --profile manual build

# Verifier CDP
docker compose run --rm job-collector --check-cdp

# Traiter un fichier queue specifique
docker compose run --rm job-collector --queue /data/OFFRES/queue/linkedin_lead_dev.json

# Traiter toutes les queues
docker compose run --rm job-collector

# Mode debug (concurrency=1, logs verbose)
docker compose run --rm job-collector --debug

# Stats du registre
docker compose run --rm job-collector --stats
```

---

## Stack technique

- **Python 3.11+** (async/await)
- **Playwright** — rendu des pages via CDP ou headless Chromium
- **BeautifulSoup4 + lxml** — parsing HTML
- **httpx** — requetes HTTP (health check CDP)
- **loguru** — logs structures
- **Docker** (image Playwright officielle) sous WSL2
