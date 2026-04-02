# Architecture du dossier OFFRES

## Arborescence

```
OFFRES/
├── registry.json                          # Index global de deduplication
├── RAPPORT.log                            # Rapport du dernier run
├── queue/                                 # Files d'attente (input)
│   ├── linkedin_lead_dev_2026-03-27T13-38-42.json
│   ├── lehibou_php_2026-03-27T23-50-46.json
│   └── ...
│
├── linkedin/                              # Un dossier par site source
│   └── lead_dev/                          # Un dossier par profil de recherche
│       ├── RECU/                          # Offres fraichement collectees
│       │   ├── 2026-03-27_Gorgias_Senior_Backend_Engineer/
│       │   │   ├── RAW.json               # Donnees structurees
│       │   │   └── DESCRIPTION.md         # Version lisible
│       │   └── ...
│       ├── APPLIED/                       # Offres auxquelles on a postule
│       │   ├── 2026-03-27_Criteo_Senior_Backend_Software_Engine/
│       │   │   ├── RAW.json
│       │   │   └── DESCRIPTION.md
│       │   └── ...
│       └── ARCHIVED/                      # Offres classees (refusees, expirees, non pertinentes)
│           ├── 2026-03-27_Inconnu_Sign_Up_LinkedIn/
│           │   ├── RAW.json
│           │   └── DESCRIPTION.md
│           └── ...
│
└── lehibou/                               # Autre site source
    └── php/                               # Autre profil de recherche
        ├── RECU/
        │   └── 2026-03-28_ClientXYZ_Dev_PHP_Senior/
        │       ├── RAW.json
        │       └── DESCRIPTION.md
        ├── APPLIED/
        └── ARCHIVED/
```

## Cycle de vie d'une offre

Chaque offre est un dossier qui se deplace entre 3 etats :

```
RECU/  ──>  APPLIED/  ──>  ARCHIVED/
               │
               └──────────> ARCHIVED/
```

| Dossier      | Signification                                              |
|--------------|------------------------------------------------------------|
| `RECU/`      | Offre fraichement collectee, pas encore traitee            |
| `APPLIED/`   | Candidature envoyee, en attente de reponse                 |
| `ARCHIVED/`  | Offre classee : refusee, expiree, non pertinente, ou terminee |

Le dossier de l'offre (avec RAW.json et DESCRIPTION.md) est **deplace tel quel** d'un etat a l'autre. Le contenu ne change pas, seul le dossier parent change.

---

## Convention de nommage des dossiers d'offres

```
{DATE}_{ENTREPRISE}_{INTITULE_COURT}/
```

- **DATE** : `YYYY-MM-DD` (date de collecte)
- **ENTREPRISE** : slugifie, max 20 caracteres. `Inconnu` si non trouve
- **INTITULE_COURT** : slugifie, max 30 caracteres

Exemples :
- `2026-03-27_Gorgias_Senior_Backend_Engineer/`
- `2026-03-27_France_Televisions_Developpeur_BOARD_F-H/`
- `2026-03-27_Inconnu_Opteamis_hiring_Tech_Lead_Symf/`

---

## Fichiers de reference

### queue/{site}_{profile}_{timestamp}.json

Fichier d'entree produit par le collecteur. Contient les URLs a traiter.

```json
{
  "site": "lehibou",
  "profile": "php",
  "collected_at": "2026-03-27T23:50:46.187045+01:00",
  "total_found": 2,
  "total_new": 2,
  "total_duplicates": 0,
  "urls": [
    "https://www.lehibou.com/annonce/b5e03ecc-beaa-4fa6-904f-e1ba2f6b497a",
    "https://www.lehibou.com/annonce/36b5d0e9-1cfd-45fa-97f8-03d5bf885836"
  ]
}
```

### RAW.json

Donnees structurees extraites d'une offre. Un fichier par offre.

```json
{
  "source_site": "linkedin",
  "search_profile": "lead_dev",
  "offer_url": "https://www.linkedin.com/jobs/view/4296420993/",
  "apply_url": "https://www.linkedin.com/jobs/view/4296420993/",
  "collected_at": "2026-03-27T13:38:42.242135+01:00",
  "fingerprint": "9bc54855bf00105d",
  "title": "Senior Backend Engineer",
  "company": "Gorgias",
  "requester": null,
  "intermediary": null,
  "location": "Paris, Ile-de-France, France",
  "remote_policy": "unknown",
  "contract_type": "CDI",
  "salary_min": null,
  "salary_max": null,
  "daily_rate": null,
  "currency": "EUR",
  "team_size": null,
  "experience_years": 6,
  "skills_required": [],
  "skills_optional": [],
  "description_raw": "Texte complet de l'offre..."
}
```

| Champ              | Type         | Valeurs possibles                                    |
|--------------------|--------------|------------------------------------------------------|
| `source_site`      | `string`     | `"linkedin"`, `"lehibou"`, `"malt"`, ...             |
| `search_profile`   | `string`     | `"lead_dev"`, `"php"`, `"data"`, ...                 |
| `remote_policy`    | `string`     | `"remote"`, `"hybrid"`, `"onsite"`, `"unknown"`      |
| `contract_type`    | `string`     | `"CDI"`, `"CDD"`, `"Freelance"`, `"Portage"`, `"Stage"`, `"Alternance"`, `"Unknown"` |
| `daily_rate`       | `int\|null`  | TJM en euros (pertinent pour Freelance)              |
| `salary_min/max`   | `int\|null`  | Salaire annuel brut en euros                         |
| `currency`         | `string`     | `"EUR"`                                              |
| `fingerprint`      | `string`     | Hash SHA-256 tronque a 16 hex (titre+entreprise+lieu+contrat) |

### DESCRIPTION.md

Version lisible de l'offre, generee automatiquement depuis RAW.json.

```markdown
# Senior Backend Engineer

**Entreprise** : Gorgias
**Localisation** : Paris, Ile-de-France, France
**Politique remote** : unknown
**Type de contrat** : CDI

**Experience** : 6 an(s)

## Description

Texte complet de l'offre...

---
Source : [linkedin](https://www.linkedin.com/jobs/view/4296420993/)
Postuler : [lien](https://www.linkedin.com/jobs/view/4296420993/)
Collecte le : 2026-03-27T13:38:42.242135+01:00
Fingerprint : `9bc54855bf00105d`
```

### registry.json

Index global de deduplication. Un tableau JSON avec une entree par offre traitee.

```json
[
  {
    "fingerprint": "9bc54855bf00105d",
    "offer_url": "https://www.linkedin.com/jobs/view/4296420993/",
    "folder": "/data/OFFRES/linkedin/lead_dev/RECU/2026-03-27_Gorgias_Senior_Backend_Engineer",
    "site": "linkedin",
    "search_profile": "lead_dev",
    "collected_at": "2026-03-27T13:38:42.242135+01:00"
  }
]
```

Sert a deux niveaux de deduplication :
1. **Par URL** : une meme URL n'est jamais traitee deux fois
2. **Par fingerprint** : une meme offre (titre + entreprise + lieu + contrat) provenant de sites differents est detectee comme doublon inter-site
