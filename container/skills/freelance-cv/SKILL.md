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
/workspace/extra/freelance-radar/OFFRES/                         — Repo des offres (read-write)
  {site}/
    {profile}/
      RECU/
        {date}_{company}_{title}/   — Offre fraîchement collectée
          RAW.json                  — Données structurées (source de vérité)
          DESCRIPTION.md            — Version lisible
          CV_{COMPANY}.docx         — CV adapté (créé par resume-optimizer)
          CV_{COMPANY}.pdf          — PDF du CV adapté
      APPLIED/
        {date}_{company}_{title}/   — Candidature envoyée
      ARCHIVED/
        {date}_{company}_{title}/   — Offre classée (skip, expirée, refusée)
  registry.json                     — Index de déduplication
  queue/                            — Files d'attente scraper
```

Le cycle de vie d'une offre est un **déplacement de dossier** :
```
RECU/  ──>  APPLIED/  ──>  ARCHIVED/
               │
               └──────────> ARCHIVED/
```

## Étape 1 — Construire la liste de travail

Deux modes selon le déclenchement :

### Mode normal (post-scraping automatique)

Les chemins des nouvelles offres sont fournis directement par le scraper dans le payload IPC. Écris-les dans `/tmp/work_list.txt` sans scanner le repo.

### Mode scan complet (recovery)

Déclenché si l'utilisateur dit : "scan complet", "récupère les offres en attente", "rattrapage", ou équivalent.

Scanne le repo pour trouver les dossiers dans `RECU/` **qui n'ont pas encore de CV** :

```bash
find /workspace/extra/freelance-radar/OFFRES -path "*/RECU/*/RAW.json" | while read f; do
  d=$(dirname "$f")
  ls "$d"/CV*.docx 2>/dev/null | grep -q . || echo "$d"
done | sort > /tmp/work_list.txt
```

Les offres dans RECU/ qui ont déjà un `CV_*.docx` ou `CV.docx` sont considérées comme déjà traitées et **ignorées**.

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

### 2b. Lire les données de l'offre

```bash
cat {offer_dir}/RAW.json
```

Le RAW.json contient toutes les données structurées : `title`, `company`, `location`, `contract_type`, `daily_rate`, `skills_required`, `description_raw`, etc.

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
- Le chemin du RAW.json (contient l'offre structurée)
- Le chemin de destination du CV : `{offer_dir}/CV_{COMPANY}.docx` (le nom est déterminé à partir du champ `company` de RAW.json)

Le skill `resume-optimizer` s'occupe de copier le CV original, l'adapter et le sauvegarder.

**Ajoute le chemin du dossier à la liste de session** (pour la génération PDF en batch) :

```bash
echo "{offer_dir}" >> /tmp/cv_session_paths.txt
```

### 2e. Si skip — écrire cause.md puis déplacer vers ARCHIVED

Pour les offres avec recommendation `skip`, **d'abord** écrire un fichier `cause.md` expliquant précisément pourquoi l'offre est écartée, **puis** déplacer vers ARCHIVED :

```bash
cat > {offer_dir}/cause.md << 'CAUSEEOF'
# Cause d'archivage

**Type** : skip (scoring Tier 2)
**Score Tier 2** : {tier2Score}
**Date** : {date ISO}

## Raison détaillée

{reasoning détaillé et précis — les éléments exacts qui ont conduit au rejet :
stack incompatible, séniorité inadéquate, localisation hors scope, TJM insuffisant, etc.}

## Compétences matchées
{matchedSkills ou "Aucune"}

## Compétences manquantes
{missingSkills}
CAUSEEOF
```

Ensuite déplacer vers ARCHIVED :

```bash
# Déterminer le chemin ARCHIVED (même {site}/{profile}/, juste remplacer RECU par ARCHIVED)
ARCHIVED_DIR=$(echo "{offer_dir}" | sed 's|/RECU/|/ARCHIVED/|')
mkdir -p "$(dirname "$ARCHIVED_DIR")"
mv "{offer_dir}" "$ARCHIVED_DIR"
```

## Étape 3 — Génération PDF en batch

Après avoir traité **toutes** les offres de la session, génère les PDFs en une seule passe.

La génération PDF s'effectue **côté host** via une tâche IPC :

```bash
cat > /workspace/ipc/tasks/generate_pdfs_$(date +%s).json << 'EOF'
{
  "type": "run_host_task",
  "taskId": "autoapply_generate_pdfs"
}
EOF
```

Le host détecte automatiquement tous les `CV_*.docx` sans PDF correspondant dans RECU/ et APPLIED/ et génère les PDFs via le container `docx2pdf`.

## Nettoyage des fichiers temporaires de session

```bash
rm -f /tmp/cv_session_paths.txt /tmp/work_list.txt
```

## Étape 5 — Commit git

Après avoir traité toutes les offres (les skips sont déjà déplacés vers ARCHIVED) :

```bash
cd /workspace/extra/freelance-radar
git add -A
git commit -m "feat: nouvelles offres — $(date +%Y-%m-%d)" || true
```

## Étape 6 — Digest final

Après le commit, envoie via `mcp__nanoclaw__send_message` :

```
📋 *Traitement terminé* ({date})

{N} offres analysées, {nb_cv} CV générés :

🟢 *{titre}* — {site}/{profile}
   Score Tier 2: {score} | CV généré ✅
   {reasoning court}

🟡 *{titre}* — {site}/{profile}
   Score Tier 2: {score} | CV généré ✅

🔴 *{titre}* — {site}/{profile}
   Score Tier 2: {score} | Ignorée (skip) — déplacée vers ARCHIVED

───────
📂 CV et analyses dans OFFRES/
✅ Traitement terminé — plus aucune tâche en cours.
```

## Archivage des offres

### Déclenchement

Déclenché si l'utilisateur dit : "j'ai postulé", "marque comme postulé {offre}", "archive les expirées", "nettoie les vieilles offres", ou équivalent.

### Candidature envoyée (manuel ou sur demande)

Déplace le dossier de l'offre de RECU/ vers APPLIED/ :

```bash
# offer_dir = /workspace/extra/freelance-radar/OFFRES/{site}/{profile}/RECU/{folder}
APPLIED_DIR=$(echo "{offer_dir}" | sed 's|/RECU/|/APPLIED/|')
mkdir -p "$(dirname "$APPLIED_DIR")"
mv "{offer_dir}" "$APPLIED_DIR"
```

### Archivage automatique des offres expirées

Une offre est expirée si : `collected_at` + 6 mois < aujourd'hui.

La date de collecte est dans `RAW.json`, champ `collected_at` :

```bash
python3 << 'EOF'
import json, shutil
from datetime import datetime, timedelta
from pathlib import Path

offres = Path("/workspace/extra/freelance-radar/OFFRES")
today = datetime.today()
threshold = timedelta(days=183)  # ~6 mois
archived = []

for raw_file in offres.glob("*/*/RECU/*/RAW.json"):
    offer_dir = raw_file.parent
    try:
        data = json.loads(raw_file.read_text())
        collected = datetime.fromisoformat(data["collected_at"].replace("Z", "+00:00")).replace(tzinfo=None)
        if today - collected > threshold:
            # Écrire cause.md avant de déplacer
            cause = f"""# Cause d'archivage

**Type** : expiration automatique
**Date** : {today.isoformat()}

## Raison détaillée

Offre collectée le {collected.strftime('%Y-%m-%d')}, soit plus de 6 mois.
Archivée automatiquement car dépassant le seuil de rétention (183 jours).
"""
            (offer_dir / "cause.md").write_text(cause)

            archived_dir = str(offer_dir).replace("/RECU/", "/ARCHIVED/")
            Path(archived_dir).parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(offer_dir), archived_dir)
            archived.append(offer_dir.name)
    except (json.JSONDecodeError, KeyError, ValueError):
        continue

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

- **TOUJOURS traiter TOUTES les offres dans RECU/** — ne jamais s'arrêter après une seule
- **Envoyer la progression** à chaque offre (i/N) via MCP
- **Déléguer la génération CV** au skill resume-optimizer
- **Ne pas postuler** automatiquement — l'utilisateur valide
- **Ne jamais deplacer** une offre qui n'as pas de fichier d'explication lié cause.md 
- **Déplacer vers ARCHIVED** les offres "skip" — seules les offres avec CV restent dans RECU
- **Ne jamais scanner** `ARCHIVED/` — ce dossier est hors scope du pipeline
- **Git commit** après le traitement — les offres s'accumulent entre les runs
