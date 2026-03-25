# Scoring de pertinence — Autoapply

## Architecture à 2 niveaux

Le scoring fonctionne en entonnoir : le Tier 1 (rapide, host-side) élimine le bruit, le Tier 2 (Claude, container) affine la sélection.

```
Toutes les offres scrappées
        │
        ▼ Tier 1 (host, ~1ms/offre)
   Score >= 0.3 ?
    ├── Non → status = 'analyzed', score stocké, ignoré
    └── Oui → envoyé au container
              │
              ▼ Tier 2 (Claude, ~2s/offre)
         Score >= 0.6 ?
          ├── Non → status = 'analyzed'
          └── Oui → notification + CV adapté
```

## Tier 1 — Matching keywords (Host)

**Fichier** : `src/scrapers/relevance.ts`

Scoring déterministe basé sur le profil professionnel (`profile.json`).

### Critères et poids

| Critère | Poids | Description |
|---------|-------|-------------|
| `skillMatch` | 0.40 | % de compétences de l'offre qui matchent le profil |
| `experienceMatch` | 0.20 | Adéquation niveau d'XP demandé vs profil |
| `locationMatch` | 0.15 | Localisation compatible (remote, ville, département) |
| `tjmMatch` | 0.15 | TJM dans la fourchette acceptable du profil |
| `freshnessBonus` | 0.10 | Bonus décroissant selon l'âge de l'offre |

### Algorithme skillMatch

```typescript
function scoreSkillMatch(offerSkills: string[], profileSkills: ProfileSkill[]): number {
  if (offerSkills.length === 0) return 0.5; // pas de skills listées → neutre

  const profileSkillNames = profileSkills.map(s => s.name.toLowerCase());
  const profileAliases = buildAliasMap(profileSkills); // PHP → [php, php8, php7]

  let matches = 0;
  let negativeMatches = 0;

  for (const skill of offerSkills) {
    const normalized = skill.toLowerCase().trim();

    // Match direct ou alias
    if (profileSkillNames.includes(normalized) || profileAliases.has(normalized)) {
      matches++;
    }

    // Pénalité pour skills exclus (ex: SAP, COBOL si profil web)
    if (EXCLUDED_SKILLS.includes(normalized)) {
      negativeMatches++;
    }
  }

  const matchRatio = matches / offerSkills.length;
  const penalty = negativeMatches > 0 ? 0.3 : 0;

  return Math.max(0, matchRatio - penalty);
}
```

### Algorithme locationMatch

```typescript
function scoreLocationMatch(offerLocation: string | undefined, profile: Profile): number {
  if (!offerLocation) return 0.5; // pas de localisation → neutre

  const loc = offerLocation.toLowerCase();

  // Remote = match parfait
  if (loc.includes('remote') || loc.includes('télétravail') || loc.includes('full remote')) {
    return 1.0;
  }

  // Même ville
  if (profile.preferredLocations.some(l => loc.includes(l.toLowerCase()))) {
    return 1.0;
  }

  // Même département/région
  if (profile.preferredRegions.some(r => loc.includes(r.toLowerCase()))) {
    return 0.7;
  }

  // France mais autre région
  if (loc.includes('france') || loc.includes('île-de-france')) {
    return 0.4;
  }

  return 0.2; // étranger ou inconnu
}
```

### Algorithme tjmMatch

```typescript
function scoreTjmMatch(tjmMin: number | undefined, tjmMax: number | undefined, profile: Profile): number {
  if (!tjmMin && !tjmMax) return 0.5; // pas de TJM → neutre

  const profileMin = profile.tjm.minimum;
  const profileTarget = profile.tjm.target;

  const offerTjm = tjmMax || tjmMin || 0;

  if (offerTjm >= profileTarget) return 1.0;      // au-dessus du target
  if (offerTjm >= profileMin) return 0.7;          // dans la fourchette acceptable
  if (offerTjm >= profileMin * 0.8) return 0.3;    // légèrement en dessous
  return 0.0;                                       // trop bas
}
```

### Algorithme freshnessBonus

```typescript
function scoreFreshness(datePublished: string | undefined): number {
  if (!datePublished) return 0.5;

  const ageInDays = (Date.now() - new Date(datePublished).getTime()) / (1000 * 60 * 60 * 24);

  if (ageInDays <= 1) return 1.0;   // aujourd'hui
  if (ageInDays <= 3) return 0.8;   // 2-3 jours
  if (ageInDays <= 7) return 0.6;   // cette semaine
  if (ageInDays <= 14) return 0.4;  // 2 semaines
  if (ageInDays <= 30) return 0.2;  // ce mois
  return 0.1;                        // plus vieux
}
```

### Score final Tier 1

```typescript
function computeTier1Score(offer: ScrapedOffer, profile: Profile): number {
  const weights = SCORING_CONFIG.TIER1_WEIGHTS;

  const scores = {
    skillMatch: scoreSkillMatch(offer.skills || [], profile.skills),
    experienceMatch: scoreExperienceMatch(offer, profile),
    locationMatch: scoreLocationMatch(offer.location, profile),
    tjmMatch: scoreTjmMatch(offer.tjmMin, offer.tjmMax, profile),
    freshnessBonus: scoreFreshness(offer.datePublished),
  };

  return Object.entries(weights).reduce(
    (total, [key, weight]) => total + scores[key as keyof typeof scores] * weight,
    0
  );
}
```

## Tier 2 — Analyse sémantique (Claude)

**Fichier** : `container/skills/freelance-cv/SKILL.md` (intégré au prompt)

Le Tier 2 est exécuté par Claude dans le container pour les offres ayant passé le Tier 1 (score >= 0.3).

### Ce que Claude évalue (que le keyword matching ne capture pas)

1. **Correspondances sémantiques** : "modernisation d'application legacy" = migration PHP
2. **Contexte métier** : une offre "data pipeline" qui nécessite en fait du Python backend
3. **Signaux cachés** : stack technique implicite dans la description du projet
4. **Adéquation culturelle** : startup vs grand groupe, méthodologie (agile, waterfall)
5. **Potentiel de match** : même si les compétences listées ne matchent pas parfaitement, le projet correspond au profil

### Prompt Tier 2

```
Tu reçois une offre et le profil professionnel du freelance.
Évalue la pertinence de cette offre sur une échelle de 0.0 à 1.0.

Critères :
- Adéquation compétences techniques (explicites ET implicites)
- Niveau d'expérience demandé vs disponible
- Type de mission (dev, conseil, management) vs préférences
- Potentiel d'intérêt (technos intéressantes, projet stimulant)
- Red flags (stack incompatible, durée trop courte/longue)

Retourne un JSON :
{
  "score": 0.75,
  "reasoning": "Bonne adéquation...",
  "matchedSkills": ["PHP", "Laravel", "Docker"],
  "missingSkills": ["Kubernetes"],
  "recommendation": "apply" | "maybe" | "skip"
}
```

## Profile.json — Structure

```json
{
  "name": "...",
  "title": "Tech Lead / Full Stack Developer",
  "experience_years": 10,
  "skills": [
    {
      "name": "PHP",
      "level": "expert",
      "years": 8,
      "aliases": ["php8", "php7", "php5"],
      "frameworks": ["Laravel", "Symfony"]
    },
    {
      "name": "Python",
      "level": "advanced",
      "years": 5,
      "frameworks": ["Django", "FastAPI", "Flask"]
    }
    // ...
  ],
  "excludedSkills": ["SAP", "COBOL", "Mainframe", "ABAP", "Salesforce"],
  "preferredLocations": ["Paris", "Remote"],
  "preferredRegions": ["Île-de-France"],
  "acceptsRemote": true,
  "tjm": {
    "minimum": 450,
    "target": 600,
    "currency": "EUR"
  },
  "preferredDuration": {
    "minMonths": 3,
    "maxMonths": 24
  },
  "preferredOfferTypes": ["freelance", "appel-offre"],
  "languages": ["Français", "Anglais"],
  "certifications": [],
  "bio": "..."
}
```

## Skills exclus (filtre négatif)

Offres contenant ces termes reçoivent une pénalité significative :

```typescript
const EXCLUDED_SKILLS = [
  'SAP', 'ABAP', 'COBOL', 'Mainframe', 'RPG',
  'Salesforce', 'ServiceNow',
  '.NET', 'C#', 'VB.NET',       // à adapter selon le profil
  'Oracle DBA', 'PL/SQL',
  'SharePoint', 'Dynamics',
];
```

> **Note** : cette liste est générée à partir du `profile.json` (champ `excludedSkills`) et peut être ajustée par l'utilisateur.
