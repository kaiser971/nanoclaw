---
name: resume-optimizer
description: Optimize, adapt, and rewrite CVs/resumes for specific job offers. Use when the user asks to improve a CV, tailor it for an offer, or when Autoapply generates adapted CVs. Handles both French and English markets.
---

# Resume Optimizer

Adapte et optimise les CV pour des offres freelance, CDI, ou appels d'offre publics.

## Sources de données

- **Profil source de vérité** : `/workspace/project/data/freelance/profile.json`
- **CV original** : `/workspace/project/data/freelance/CV.docx`
- **Offres** : `/workspace/extra/freelance-radar/OFFRES/{site}/{profile}/RECU/{folder}/RAW.json`
- **CV générés** : `/workspace/extra/freelance-radar/OFFRES/{site}/{profile}/RECU/{folder}/CV_{COMPANY}.docx`

## Règle critique

**TOUJOURS copier le CV original avant de le modifier** :
```bash
cp /workspace/project/data/freelance/CV.docx {offer_dir}/CV_{COMPANY}.docx
```
Puis modifier la copie avec python-docx. Ne jamais générer un document from scratch — le formatage, les polices, les marges et la mise en page du Word original doivent être intégralement préservés.

## Workflow d'adaptation

### 1. Analyse de l'offre cible

Lire les données structurées depuis `RAW.json` :
```bash
cat {offer_dir}/RAW.json
```

Extraire :
- **Compétences clés** : `skills_required` + compétences implicites dans `description_raw`
- **Niveau de séniorité** : depuis `experience_years` et indices dans le titre/description
- **Contexte métier** : secteur (public/privé), taille (startup/grand groupe), méthodologie
- **Mots-clés récurrents** : termes que l'ATS ou le recruteur cherchera
- **Red flags** : incompatibilités évidentes avec le profil

### 2. Adaptation du CV

#### Ce qui DOIT être adapté

| Section | Adaptation |
|---------|------------|
| **Titre/Accroche** | Reformuler pour coller exactement au poste. Ex: "Chef de Projet / Tech Lead PHP" → "Tech Lead Symfony / Chef de Projet Digital" si l'offre met Symfony en avant |
| **Compétences** | Réordonner : les compétences demandées en premier. Regrouper par pertinence pour l'offre. |
| **Expériences** | Réordonner par pertinence (pas forcément chronologique). Mettre en avant les missions qui matchent le contexte. |
| **Bullet points** | Reformuler avec le framework STAR (Situation, Task, Action, Result). Quantifier quand possible. |
| **Mots-clés** | Aligner le vocabulaire avec celui de l'offre (ex: "intégration continue" si l'offre dit ça, pas "CI/CD") |

#### Ce qui ne change JAMAIS

- Les **faits** : dates, entreprises, diplômes, certifications
- Les **compétences** : ne jamais inventer une compétence non présente dans `profile.json`
- Le **format** : rester sur 2 pages max, garder la structure du template
- Les **coordonnées** : ne pas modifier sauf si demandé

### 3. Règles par type d'offre

Le type de contrat est dans `RAW.json > contract_type`.

#### Freelance (`contract_type: "Freelance"`)

- Style dynamique, orienté résultats
- Mettre en avant : autonomie, TJM, disponibilité
- Bullet points chiffrés : "Migration Symfony 4→6 pour 200K users"
- Compétences techniques en premier

#### Appels d'offre publics (source_site: "boamp")

- Style formel, vocabulaire administratif
- Mettre en avant : expériences secteur public, conformité, méthodologie
- Références aux normes : RGPD, RGS, accessibilité RGAA
- Mentionner : gestion de projet, pilotage, coordination
- Structurer en "compétences requises par le cahier des charges"

#### CDI / Recrutement (`contract_type: "CDI"`)

- Style équilibré entre technique et soft skills
- Mettre en avant : stabilité, évolution, leadership
- Adapter au secteur de l'entreprise

### 4. Optimisation ATS

Les CV passent souvent par un ATS (Applicant Tracking System). Optimiser :

- **Mots-clés exacts** de l'offre dans le CV (pas de synonymes créatifs)
- **Format simple** : pas de tableaux complexes, pas d'images, pas de colonnes
- **Sections standard** : Expériences, Compétences, Formation, Langues
- **Noms de technologies** : écrire "Symfony" pas "SF", "Kubernetes" pas "K8s"

### 5. Génération du fichier

**Nom du fichier : `CV_{COMPANY}.docx`**

Extraire le nom de l'entreprise depuis `RAW.json` (champ `company`).
Sanitizer pour le nom de fichier : espaces → `_`, garder uniquement `[A-Za-z0-9_\-]`.
Si `company` est `null` ou vide → utiliser `CV.docx` comme fallback.

Exemples : `"Gorgias"` → `CV_Gorgias.docx` | `"France Télévisions"` → `CV_France_Televisions.docx`

**OBLIGATOIRE — Suivre ces 2 étapes EXACTEMENT dans cet ordre :**

**Étape A** — Copier l'original (OBLIGATOIRE, ne jamais sauter cette étape) :
```bash
cp /workspace/project/data/freelance/CV.docx {offer_dir}/CV_{COMPANY}.docx
```

**Étape B** — Modifier UNIQUEMENT le texte de la copie avec python-docx :
```bash
python3 << 'PYSCRIPT'
from docx import Document

cv_path = "{offer_dir}/CV_{COMPANY}.docx"
doc = Document(cv_path)

# Parcourir les cellules des tableaux existants
for table in doc.tables:
    for row in table.rows:
        for cell in row.cells:
            for para in cell.paragraphs:
                for run in para.runs:
                    # Remplacer le texte dans les runs EXISTANTS
                    if "ancien texte" in run.text:
                        run.text = run.text.replace("ancien texte", "nouveau texte")

doc.save(cv_path)
PYSCRIPT
```

**INTERDIT :**
- `Document()` sans argument (crée un doc vide au lieu d'ouvrir la copie)
- `doc.add_paragraph()`, `doc.add_table()` (ajoute des éléments qui n'existent pas dans l'original)
- Supprimer des paragraphes ou des runs
- Générer un nouveau document from scratch de quelque manière que ce soit

**Le fichier de sortie DOIT être visuellement identique à l'original** (même mise en page, polices, couleurs, marges). Seul le contenu textuel change.

### 6. Message de réponse

Après avoir généré le CV, **ajouter une section "Message de réponse"** à la fin du `DESCRIPTION.md` de l'offre.

Ce message est la prise de contact initiale (email, formulaire, message direct) que Jean-Luc enverra au recruteur. Il doit :

- Être **strictement inférieur à 2000 caractères** (espaces compris)
- Être **personnalisé** : utiliser le nom de l'entreprise (depuis `RAW.json > company`), mentionner 2-3 éléments spécifiques de l'offre
- Mettre en avant **les points forts du profil qui matchent cette offre précisément**
- Mentionner la disponibilité et le TJM si pertinent
- Ton professionnel, direct, sans formules creuses
- **Ne jamais citer mot pour mot l'intitulé du poste** — utiliser des formulations naturelles

Ajoute la section en fin de `DESCRIPTION.md` :

```bash
cat >> {offer_dir}/DESCRIPTION.md << 'MSGEOF'

## Message de réponse

{message généré ici}

---
*Généré automatiquement — à relire avant envoi.*
MSGEOF
```

**Contrainte stricte** : compter les caractères avant d'écrire. Si le message dépasse 2000 caractères, le raccourcir en conservant l'essentiel.

### 7. Notes d'adaptation

Pour chaque CV généré, produire un résumé :

```
## Adaptations pour [titre offre] ([site])

**Score de pertinence** : 0.82
**Recommandation** : apply

### Modifications effectuées
- Titre changé : "Chef de Projet / Tech Lead PHP" → "Tech Lead Symfony / DevOps"
- Expérience IDGarages mise en 1ère position (Symfony + Kubernetes)
- Compétences réordonnées : Symfony, Docker, CI/CD en tête
- Ajout mots-clés : "migration", "API REST", "microservices"

### Compétences matchées
PHP, Symfony, Docker, CI/CD, API REST, Agile

### Compétences manquantes (mentionnées dans l'offre)
Terraform (non possédée → non ajoutée)

### Points forts du profil pour cette offre
- 8 ans Symfony, migration v4→v6 (expérience directe)
- Lead Dev + Chef de projet (double casquette demandée)
- Expérience CI/CD Jenkins + GitLab CI
```

## Commandes utilisateur

| Intention | Action |
|-----------|--------|
| "adapte mon CV pour l'offre [X]" | Génère un CV adapté + notes |
| "optimise mon CV" | Améliore le CV de base (sans offre cible) |
| "CV en anglais pour [offre]" | Traduit et adapte pour le marché anglophone |
| "compare mon CV avec l'offre [X]" | Analyse de correspondance sans générer de CV |
| "montre les adaptations du CV [X]" | Affiche les notes d'adaptation |

## Langues

- **Français** : par défaut pour les offres françaises
- **Anglais** : si l'offre est en anglais ou si l'utilisateur le demande
- Adapter le style et les conventions (ex: "Références disponibles sur demande" en français, pas en anglais)
