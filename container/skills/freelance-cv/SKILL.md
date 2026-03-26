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
  {platform}/
    {slug}/              — Offre active
      description.md     — Détails de l'offre (créé par le host)
      context.md         — Contexte pour le traitement (status: pending/processed)
      CV.docx            — CV adapté (créé par resume-optimizer)
      CV.pdf             — PDF du CV adapté
  applied/
    {platform}/
      {slug}/            — Offre pour laquelle une candidature a été envoyée
  archived/
    {platform}/
      {slug}/            — Offre expirée (publiée > 6 mois) ou abandonnée
```

Les dossiers `applied/` et `archived/` sont à la racine du repo et ne sont **jamais scannés** par le pipeline.

## Étape 1 — Construire la liste de travail

Deux modes selon le déclenchement :

### Mode normal (post-scraping automatique)

Les chemins des nouvelles offres sont fournis directement par le scraper dans le payload IPC. Écris-les dans `/tmp/work_list.txt` sans scanner le repo.

### Mode scan complet (recovery)

Déclenché si l'utilisateur dit : "scan complet", "récupère les offres en attente", "rattrapage", "check les pending", ou équivalent.

Scanne l'intégralité du repo pour trouver **tous** les `status: pending` (ajouts manuels, offres ratées suite à un rate limit ou arrêt du process), en excluant explicitement `applied/` et `archived/` :

```bash
grep -rl "status: pending" /workspace/extra/freelance-radar/*/*/context.md \
  | grep -v '^/workspace/extra/freelance-radar/applied/' \
  | grep -v '^/workspace/extra/freelance-radar/archived/' \
  | sed 's|/context.md||' \
  | sort > /tmp/work_list.txt
```

---

Compte le nombre de lignes (N) :

```bash
N=$(wc -l < /tmp/work_list.txt)
echo "Offres à traiter : $N"
```

Si N=0, envoie via MCP :
> "Aucune nouvelle offre en attente de traitement."

Supprime `/tmp/work_list.txt` et arrête-toi.

## Étape 2 — Boucle de traitement

**Input exclusif : `/tmp/work_list.txt`** — ne pas rescanner le repo.

Pour CHAQUE chemin dans `/tmp/work_list.txt` (index i de 1 à N) :

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
- Le chemin de destination du CV : `/workspace/extra/freelance-radar/{platform}/{slug}/CV_{ACHETEUR}.docx` (le nom exact est déterminé par resume-optimizer à partir du champ Acheteur de description.md)

Le skill `resume-optimizer` s'occupe de copier le CV original, l'adapter et le sauvegarder.

**Ajoute le chemin du dossier à la liste de session** (pour la génération PDF en batch) :

```bash
echo "/workspace/extra/freelance-radar/{platform}/{slug}" >> /tmp/cv_session_paths.txt
```

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

## Étape 3 — Génération PDF en batch

Après avoir traité **toutes** les offres de la session, génère les PDFs en une seule passe pour les CVs créés durant cette session uniquement (pas les CVs déjà présents dans le repo d'une session précédente).

La génération PDF s'effectue **côté host** via une tâche IPC (le container agent n'a pas accès à Docker).

Écris le fichier IPC suivant pour déclencher la génération :

```bash
cat > /workspace/ipc/tasks/generate_pdfs_$(date +%s).json << 'EOF'
{
  "type": "run_host_task",
  "taskId": "autoapply_generate_pdfs"
}
EOF
```

Le host détecte automatiquement tous les `CV.docx` sans `CV.pdf` correspondant dans `freelance-radar/` (hors `applied/` et `archived/`) et génère les PDFs via le container `docx2pdf`.

# Nettoyage des fichiers temporaires de session
```bash
rm -f /tmp/cv_session_paths.txt /tmp/work_list.txt
```

## Étape 5 — Nettoyage du repo

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

## Étape 6 — Digest final

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

## Archivage des offres

### Déclenchement

Déclenché si l'utilisateur dit : "j'ai postulé", "archive les expirées", "marque comme postulé {slug}", "nettoie les vieilles offres", ou équivalent.

### Candidature envoyée (manuel ou sur demande)

Déplace le dossier de l'offre dans `applied/{platform}/` à la racine du repo :

```bash
mkdir -p /workspace/extra/freelance-radar/applied/{platform}/
mv /workspace/extra/freelance-radar/{platform}/{slug}/ \
   /workspace/extra/freelance-radar/applied/{platform}/{slug}/
```

### Archivage automatique des offres expirées

Une offre est expirée si : **date de publication + 6 mois < aujourd'hui**.

La date de publication est dans `description.md`, champ `**Publiée**` :

```bash
python3 << 'EOF'
import re, shutil
from datetime import datetime, timedelta
from pathlib import Path

radar = Path("/workspace/extra/freelance-radar")
today = datetime.today()
threshold = timedelta(days=183)  # ~6 mois
archived = []

# Ne scanner que {platform}/{slug}/ — exclure applied/ et archived/
excluded = {"applied", "archived"}

for context in radar.glob("*/*/context.md"):
    platform = context.parts[-3]
    slug = context.parts[-2]
    if platform in excluded:
        continue

    desc = context.parent / "description.md"
    if not desc.exists():
        continue

    match = re.search(r'\|\s*\*\*Publiée\*\*\s*\|\s*(\d{4}-\d{2}-\d{2})', desc.read_text())
    if not match:
        continue

    pub_date = datetime.strptime(match.group(1), "%Y-%m-%d")
    if today - pub_date > threshold:
        dest = radar / "archived" / platform / slug
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(context.parent), str(dest))
        archived.append(f"{platform}/{slug}")

print(f"Archivées : {len(archived)}")
for a in archived:
    print(f"  {a}")
EOF
```

Après déplacement, commit :

```bash
cd /workspace/extra/freelance-radar
git add -A
git commit -m "chore: archive offres expirées / postulées — $(date +%Y-%m-%d)" || true
```

## Règles

- **TOUJOURS traiter TOUTES les offres pending** — ne jamais s'arrêter après une seule
- **Envoyer la progression** à chaque offre (i/N) via MCP
- **Déléguer la génération CV** au skill resume-optimizer
- **Ne pas postuler** automatiquement — l'utilisateur valide
- **Supprimer du repo** les offres "skip" — seules les offres avec CV restent
- **Ne jamais scanner** `applied/` et `archived/` — ces dossiers sont hors scope
- **Git commit** après le nettoyage ou l'archivage — les offres s'accumulent entre les runs
