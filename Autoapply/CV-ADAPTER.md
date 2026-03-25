# CV Adapter — Skill Container

## Vue d'ensemble

Le skill `freelance-cv` est exécuté dans le container agent Claude. Il analyse les offres pertinentes et génère des CV adaptés à chaque opportunité.

## Workflow

```
1. Container reçoit les offres (via IPC new_offers.json)
2. Pour chaque offre avec score >= seuil :
   a. Lit profile.json (profil complet)
   b. Lit cv-base.docx (template)
   c. Analyse sémantique de l'offre (Tier 2 scoring)
   d. Détermine les adaptations nécessaires
   e. Génère le CV adapté (.docx)
   f. Stocke notes d'adaptation en DB
3. Envoie le digest via IPC send_message
```

## Fichier skill : `container/skills/freelance-cv/SKILL.md`

```markdown
---
name: freelance-cv
description: Adapte le CV du freelance aux offres pertinentes
---

# Freelance CV Adapter

Tu es un expert en rédaction de CV pour freelances IT.

## Contexte

Le profil complet du freelance est dans `/workspace/group/data/freelance/profile.json`.
Le template CV est dans `/workspace/group/data/freelance/cv-base.docx`.
Les offres à traiter sont dans `/workspace/ipc/new_offers.json`.

## Processus d'adaptation

Pour chaque offre pertinente :

### 1. Analyse de l'offre
- Identifie les compétences clés demandées
- Identifie le contexte métier (secteur, taille, méthodologie)
- Identifie les mots-clés récurrents dans la description
- Évalue le niveau de séniorité recherché

### 2. Scoring Tier 2
Évalue la pertinence sémantique (pas juste les mots-clés) :
- Correspondances implicites (ex: "modernisation legacy" = migration PHP)
- Adéquation culturelle (startup vs grand compte)
- Signaux positifs/négatifs cachés

Retourne le score (0.0-1.0) et la recommandation (apply/maybe/skip).

### 3. Adaptation du CV
Pour les offres avec recommandation "apply" ou "maybe" :

**Ce qui change** :
- Titre/accroche → adapté au poste exact
- Ordre des compétences → les plus pertinentes en premier
- Expériences → réordonnées, les plus pertinentes mises en avant
- Mots-clés → alignés avec la description de l'offre
- Résumé → reformulé pour matcher le contexte

**Ce qui ne change JAMAIS** :
- Les faits (dates, entreprises, diplômes)
- Les compétences non possédées (pas d'invention)
- Le format/mise en page du template

### 4. Génération .docx
- Utilise le template cv-base.docx comme base
- Remplace les sections adaptées
- Sauvegarde dans `/workspace/group/cv-versions/{offer_id}.docx`
- Nomme le fichier : `cv-{platform}-{short-title}.docx`

### 5. Notes d'adaptation
Pour chaque CV généré, documente :
- Ce qui a été modifié et pourquoi
- Score Tier 2 et reasoning
- Compétences matchées / manquantes
- Recommandation finale

## Format de sortie

Pour chaque offre traitée, retourne :
```json
{
  "offerId": "boamp_2026-123456",
  "tier2Score": 0.85,
  "recommendation": "apply",
  "reasoning": "Excellente adéquation...",
  "matchedSkills": ["PHP", "Laravel", "Docker"],
  "missingSkills": ["Kubernetes"],
  "cvPath": "/workspace/group/cv-versions/cv-boamp-tma-education.docx",
  "adaptationNotes": "Mis en avant : expérience TMA 3 ans, Laravel, secteur public..."
}
```

## Règles

- Ne jamais inventer des compétences ou expériences
- Garder le CV à 2 pages max
- Adapter le vocabulaire au secteur (public vs privé)
- Pour les appels d'offre publics : style formel, références secteur public
- Pour le freelance privé : style dynamique, résultats chiffrés
```

## Manipulation .docx

### Option 1 : npm docx (côté container Node.js)

```typescript
import { Document, Packer, Paragraph, TextRun } from 'docx';

// Lire le template, modifier les sections, sauvegarder
```

### Option 2 : python-docx (disponible dans le container)

```python
from docx import Document

doc = Document('/workspace/group/data/freelance/cv-base.docx')
# Modifier les paragraphes par section
# Sauvegarder
doc.save(f'/workspace/group/cv-versions/cv-{offer_id}.docx')
```

### Option 3 : Template avec placeholders

Le `cv-base.docx` contient des placeholders que Claude remplace :

```
{{TITRE}}           → "Tech Lead Full Stack PHP/Laravel"
{{ACCROCHE}}        → "10 ans d'expérience en développement..."
{{COMPETENCES_1}}   → "PHP 8, Laravel 10, Symfony 6"
{{COMPETENCES_2}}   → "React, TypeScript, Next.js"
{{EXPERIENCE_1}}    → Expérience la plus pertinente
{{EXPERIENCE_2}}    → 2ème expérience
...
```

> **Recommandation** : Option 3 (template avec placeholders). Plus simple, plus fiable, et Claude peut se concentrer sur le contenu plutôt que la manipulation du format.

## Stockage des CV générés

```
data/freelance/cv-versions/
  cv-boamp-tma-education-2026-03-25.docx
  cv-free-work-fullstack-react-2026-03-25.docx
  ...
```

Chaque CV est aussi référencé dans la table `freelance_cv_versions` :

```sql
INSERT INTO freelance_cv_versions (id, offer_id, cv_path, adaptation_notes, created_at)
VALUES ('uuid', 'boamp_2026-123456', 'cv-versions/cv-boamp-tma-education.docx',
        'Mis en avant TMA, Laravel, secteur public', '2026-03-25T08:10:00Z');
```

## Flux de validation utilisateur

Le CV n'est PAS envoyé automatiquement. Le workflow est :

```
1. Offre scrappée + scorée
2. CV adapté généré
3. Notification à l'utilisateur avec résumé + lien CV
4. L'utilisateur review le CV (via chat : "montre le CV pour offre X")
5. L'utilisateur valide : "postule à l'offre X" → status = 'applied'
   ou rejette : "ignore l'offre X" → status = 'rejected'
```
