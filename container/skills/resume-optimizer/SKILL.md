---
name: resume-optimizer
description: Optimize, adapt, and rewrite CVs/resumes for specific job offers. Use when the user asks to improve a CV, tailor it for an offer, or when Autoapply generates adapted CVs. Handles both French and English markets.
---

# Resume Optimizer

Adapte et optimise les CV pour des offres freelance, CDI, ou appels d'offre publics.

## Sources de données

- **Profil source de vérité** : `/workspace/group/data/freelance/profile.json`
- **CV template** : `/workspace/group/data/freelance/CV.docx`
- **CV générés** : `/workspace/group/data/freelance/cv-versions/`

## Workflow d'adaptation

### 1. Analyse de l'offre cible

Avant toute adaptation, extraire :
- **Compétences clés** : techniques explicites ET implicites dans la description
- **Niveau de séniorité** : junior, confirmé, senior, lead, architect
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

#### Freelance (ESN, plateformes)

- Style dynamique, orienté résultats
- Mettre en avant : autonomie, TJM, disponibilité
- Bullet points chiffrés : "Migration Symfony 4→6 pour 200K users"
- Compétences techniques en premier

#### Appels d'offre publics (BOAMP, PLACE)

- Style formel, vocabulaire administratif
- Mettre en avant : expériences secteur public, conformité, méthodologie
- Références aux normes : RGPD, RGS, accessibilité RGAA
- Mentionner : gestion de projet, pilotage, coordination
- Structurer en "compétences requises par le cahier des charges"

#### CDI / Recrutement (Michael Page, Externatic)

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

```bash
# Lire le template
# Modifier les sections via python-docx ou manipulation directe
# Sauvegarder dans cv-versions/

# Nommage : cv-{platform}-{titre-court}-{date}.docx
# Ex: cv-boamp-tma-education-2026-03-25.docx
# Ex: cv-free-work-lead-symfony-2026-03-25.docx
```

Chemin de sortie : `/workspace/group/data/freelance/cv-versions/`

### 6. Notes d'adaptation

Pour chaque CV généré, produire un résumé :

```
## Adaptations pour [titre offre] ([plateforme])

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
