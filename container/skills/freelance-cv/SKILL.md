---
name: freelance-cv
description: Analyse les offres freelance pertinentes, effectue le scoring sémantique Tier 2, et génère des CV adaptés. Déclenché automatiquement après le scraping quotidien ou manuellement quand l'utilisateur demande "lance le scraping", "nouvelles offres", "scrape les offres", etc. Utilise le skill resume-optimizer pour la génération de CV.
---

# Freelance CV — Analyse & Adaptation

Tu gères le pipeline freelance. Tu es déclenché soit :
- **Automatiquement** après le scraping quotidien (20h)
- **Manuellement** quand l'utilisateur demande depuis le chat

## Déclenchement manuel (on-demand)

Si l'utilisateur demande de lancer le scraping ("lance le scraping", "scrape les offres", "nouvelles offres", "cherche des missions"), écris un fichier IPC pour déclencher le scraping host-side :

```bash
cat > /workspace/ipc/tasks/run_scraping_$(date +%s).json << 'EOF'
{
  "type": "run_host_task",
  "taskId": "autoapply_scraping"
}
EOF
```

Puis réponds : "🔄 Scraping lancé. Les résultats arriveront dans quelques secondes."

Le host exécutera le scraping, et si des offres pertinentes sont trouvées, un nouveau container sera déclenché avec les offres à analyser.

## Mode automatique (post-scraping)

Quand tu es déclenché après le scraping, ta mission :
1. Lire les offres pertinentes
2. Les scorer sémantiquement (Tier 2)
3. Générer un CV adapté pour les meilleures
4. Envoyer un digest à l'utilisateur

## Données disponibles

```
/workspace/ipc/input/autoapply_offers.json       — Offres à analyser (écrites par le host)
/workspace/project/data/freelance/profile.json   — Profil professionnel complet (read-only)
/workspace/project/data/freelance/CV.docx        — CV source (read-only)
```

Le champ `jobDir` dans le fichier d'offres indique le chemin du repo de tracking.
Chaque offre a déjà un dossier `{jobDir}/{platform}/{slug}/description.md` créé par le host.
Tu y places le CV adapté : `{jobDir}/{platform}/{slug}/CV.docx`

> Note : `/workspace/project/` est le projet NanoClaw monté en lecture seule (main group uniquement).

## Étape 1 — Lire les offres

```bash
cat /workspace/ipc/input/autoapply_offers.json
```

Le fichier contient :
```json
{
  "offers": [
    {
      "id": "boamp_26-29931",
      "platform": "boamp",
      "title": "TMA site institutionnel...",
      "description": "...",
      "buyer": "Département du Val de Marne",
      "skills": ["Informatique"],
      "url": "https://www.boamp.fr/...",
      "deadline": "2026-05-11",
      "tier1Score": 0.61
    }
  ],
  "profilePath": "/workspace/group/data/freelance/profile.json",
  "cvPath": "/workspace/group/data/freelance/CV.docx"
}
```

## Étape 2 — Scoring Tier 2 (sémantique)

Pour chaque offre, évalue la pertinence **au-delà des mots-clés** :

### Ce que tu évalues (que le Tier 1 ne capture pas)

- **Correspondances implicites** : "modernisation d'application legacy" = migration PHP/Symfony
- **Contexte métier** : une offre "maintenance applicative SI" pour un ministère implique probablement du PHP
- **Stack technique caché** : la description mentionne-t-elle des indices (framework, architecture, déploiement) ?
- **Adéquation de séniorité** : le profil est Tech Lead/Chef de projet, l'offre correspond-elle ?
- **Red flags** : stack incompatible malgré des mots-clés communs (ex: "maintenance applicative" mais sur SAP)

### Format de sortie Tier 2

Pour chaque offre, détermine :
```json
{
  "offerId": "boamp_26-29931",
  "tier2Score": 0.85,
  "recommendation": "apply",
  "reasoning": "TMA web pour un site institutionnel, forte probabilité de stack PHP/Symfony. Profil parfaitement adapté (13 ans PHP, expérience TMA IDGarages).",
  "matchedSkills": ["PHP", "Symfony", "TMA", "CI/CD"],
  "missingSkills": [],
  "redFlags": []
}
```

- `recommendation` : `"apply"` (score >= 0.7), `"maybe"` (0.5-0.7), `"skip"` (< 0.5)

## Étape 3 — Adaptation CV

Pour les offres avec recommendation `"apply"` ou `"maybe"` :

1. Lis le profil : `cat /workspace/project/data/freelance/profile.json`
2. Utilise le skill **resume-optimizer** pour adapter le CV
3. Sauvegarde le CV dans le dossier de l'offre : `{jobDir}/{platform}/{slug}/CV.docx`

### Structure des fichiers

Chaque offre a son dossier dans le repo `freelance-radar` :

```
freelance-radar/
  boamp/
    tma-site-institutionnel-val-de-marne/
      description.md    ← déjà créé par le host (offre + scoring Tier 1)
      CV.docx           ← toi tu ajoutes le CV adapté ici
  free-work/
    lead-dev-symfony-paris/
      description.md
      CV.docx
```

### Règles d'adaptation

- **Appels d'offre publics (BOAMP, PLACE)** :
  - Style formel, vocabulaire administratif
  - Mettre en avant : expériences secteur public, TMA, pilotage
  - Mentionner conformité (RGPD, RGS, RGAA si pertinent)
  - Structurer par compétences requises dans le marché

- **Freelance privé (Free-Work, etc.)** :
  - Style dynamique, résultats chiffrés
  - Mettre en avant autonomie et stack technique
  - TJM et disponibilité en accroche

## Étape 4 — Envoyer le digest

Utilise le MCP tool pour envoyer le résumé à l'utilisateur :

```
mcp__nanoclaw__send_message
```

### Format du digest

```
📋 *Nouvelles offres freelance* ({date})

*{N} offres analysées, {M} pertinentes :*

1. 🟢 **{titre}** — {plateforme}
   Score: {tier2Score} | {buyer}
   🔧 {matchedSkills}
   📅 Deadline: {deadline}
   🔗 {url}
   📄 CV adapté : {cvFileName}

2. 🟡 **{titre}** — {plateforme}
   Score: {tier2Score} | {buyer}
   ...

───────
💾 Réponds "détail offre {id}" pour voir l'analyse complète
✅ Réponds "postule à {id}" pour marquer comme candidaté
❌ Réponds "ignore {id}" pour ignorer
```

Légende des indicateurs :
- 🟢 recommendation = `apply` (score >= 0.7)
- 🟡 recommendation = `maybe` (score 0.5–0.7)
- Ne pas inclure les `skip`

### Si aucune offre pertinente

```
📋 *Scraping du {date}*

{N} offres analysées — aucune suffisamment pertinente pour ton profil.

Les filtres actuels cherchent : PHP, Symfony, TMA, DevOps, Chef de projet...
```

## Étape 5 — Nettoyage

Après traitement, supprime le fichier d'entrée :
```bash
rm /workspace/ipc/input/autoapply_offers.json
```

## Règles

- **Ne jamais inventer** des compétences ou expériences dans le CV
- **Ne pas postuler** automatiquement — l'utilisateur valide toujours
- **Toujours envoyer** un digest même si aucune offre n'est pertinente
- **Garder le CV** à 2 pages maximum
- Si le fichier d'offres n'existe pas, répondre qu'aucune nouvelle offre n'est disponible
