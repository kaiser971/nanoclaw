---
name: freelance-cv
description: Orchestre le pipeline freelance — scraping on-demand, scoring Tier 2, et délègue l'adaptation CV au skill resume-optimizer. Déclenché automatiquement après le scraping ou manuellement ("lance le scraping", "nouvelles offres", etc.).
---

# Freelance CV — Orchestration pipeline

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

## Mode automatique (post-scraping)

Quand tu es déclenché après le scraping, tu traites TOUTES les offres en attente.

## Données

```
/workspace/project/data/freelance/profile.json   — Profil professionnel (read-only)
/workspace/project/data/freelance/CV.docx        — CV source original (read-only)
/workspace/extra/freelance-radar/                — Repo des offres (read-write)
  {platform}/{slug}/
    description.md   — Détails de l'offre (créé par le host)
    context.md       — Contexte pour le traitement (status: pending/processed)
    CV.docx          — CV adapté (créé par resume-optimizer)
```

## Étape 1 — Trouver toutes les offres en attente

```bash
find /workspace/extra/freelance-radar -name context.md -exec grep -l "status: pending" {} +
```

Compte le nombre total (N) pour le suivi de progression.

Si aucune offre en attente, envoie via MCP :
> "Aucune nouvelle offre en attente de traitement."

Et arrête-toi.

## Étape 2 — Boucle de traitement

Pour CHAQUE offre pending (index i de 1 à N) :

### 2a. Progression

Envoie via `mcp__nanoclaw__send_message` :
> "⏳ Traitement offre {i}/{N} : {titre de l'offre}..."

### 2b. Lire le contexte

```bash
cat /workspace/extra/freelance-radar/{platform}/{slug}/context.md
```

### 2c. Scoring Tier 2 (sémantique)

Évalue la pertinence **au-delà des mots-clés** :

- **Correspondances implicites** : "modernisation d'application legacy" = migration PHP/Symfony
- **Contexte métier** : "maintenance applicative SI" pour un ministère = probablement PHP
- **Stack technique caché** : indices dans la description
- **Adéquation séniorité** : profil Tech Lead/Chef de projet, 13 ans XP
- **Red flags** : stack incompatible malgré des mots-clés communs (ex: TMA mais sur SAP/Oracle)

Détermine :
- `tier2Score` : 0.0 à 1.0
- `recommendation` : `apply` (>= 0.7), `maybe` (0.5–0.7), `skip` (< 0.5)
- `reasoning` : explication en 1-2 phrases
- `matchedSkills` / `missingSkills`

### 2d. Adapter le CV (si apply ou maybe)

**Délègue au skill `resume-optimizer`** en lui fournissant :
- Le chemin du context.md (contient l'offre et le scoring)
- Le chemin de destination du CV : `/workspace/extra/freelance-radar/{platform}/{slug}/CV.docx`

Le skill `resume-optimizer` s'occupe de copier le CV original, l'adapter et le sauvegarder.

### 2d-bis. Générer le PDF

Après génération du CV.docx, **toujours** produire une copie PDF :

```bash
libreoffice --headless --convert-to pdf --outdir /workspace/extra/freelance-radar/{platform}/{slug}/ /workspace/extra/freelance-radar/{platform}/{slug}/CV.docx
```

Le dossier de chaque offre retenue doit contenir **CV.docx ET CV.pdf**.

### 2e. Mettre à jour le context.md

Remplace le contenu avec les résultats :

```markdown
---
status: processed
platform: {platform}
slug: {slug}
tier1Score: {score}
tier2Score: {tier2Score}
recommendation: {apply|maybe|skip}
processedAt: {date ISO}
cvGenerated: {true|false}
---

# Analyse Tier 2

## Recommendation : {apply|maybe|skip}

{reasoning}

## Compétences matchées
{matchedSkills}

## Compétences manquantes
{missingSkills}

## Adaptations CV
{ce qui a été modifié dans le CV et pourquoi — rempli par resume-optimizer}
```

## Étape 3 — Nettoyage du repo

Le repo freelance-radar ne doit contenir **QUE les offres pour lesquelles un CV a été généré**.

Après avoir traité toutes les offres :

1. **Supprimer les dossiers des offres "skip"** (celles sans CV généré) :

```bash
# Pour chaque offre ayant reçu recommendation: skip
rm -rf /workspace/extra/freelance-radar/{platform}/{slug}/
```

2. **Commit git** (les offres retenues s'accumulent dans le repo) :

```bash
cd /workspace/extra/freelance-radar
git add -A
git commit -m "feat: nouvelles offres — $(date +%Y-%m-%d)" || true
```

## Étape 4 — Digest final

Après le nettoyage et le commit, envoie via `mcp__nanoclaw__send_message` :

```
📋 *Traitement terminé* ({date})

{N} offres analysées, {nb_cv} CV générés :

🟢 *{titre}* — {plateforme}
   Score Tier 2: {score} | CV généré ✅
   {reasoning court}

🟡 *{titre}* — {plateforme}
   Score Tier 2: {score} | CV généré ✅

🔴 *{titre}* — {plateforme}
   Score Tier 2: {score} | Ignorée (skip) — supprimée du repo

───────
📂 CV et analyses dans freelance-radar
✅ Traitement terminé — plus aucune tâche en cours.
```

## Règles

- **TOUJOURS traiter TOUTES les offres pending** — ne jamais s'arrêter après une seule
- **Envoyer la progression** à chaque offre (i/N) via MCP
- **Déléguer la génération CV** au skill resume-optimizer
- **Ne pas postuler** automatiquement — l'utilisateur valide
- **Supprimer du repo** les offres "skip" — seules les offres avec CV restent
- **Git commit** après le nettoyage — les offres s'accumulent entre les runs
