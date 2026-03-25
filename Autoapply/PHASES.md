# Phases d'implémentation — Autoapply

## Vue d'ensemble

5 phases, ~10-13 jours de développement. Chaque phase est autonome et testable.

---

## Phase 1 — MVP : Scraping + Stockage (2 jours)

**Objectif** : Scraper BOAMP et Free-Work, stocker en SQLite, interroger via chat.

### Tâches

| # | Tâche | Fichier(s) | Critère d'acceptation |
|---|-------|-----------|----------------------|
| 1.1 | Interfaces TypeScript | `src/scrapers/types.ts` | `ScrapedOffer`, `Scraper`, `ScraperRunConfig` compilent |
| 1.2 | Configuration | `src/scrapers/config.ts` | Termes de recherche portés depuis Python, rate limits, URLs |
| 1.3 | Scraper BOAMP | `src/scrapers/platforms/boamp.ts` | Retourne des `ScrapedOffer[]` depuis l'API JSON. `test()` passe. |
| 1.4 | Scraper Free-Work | `src/scrapers/platforms/free-work.ts` | Parse HTML SSR + JSON-LD. `test()` passe. |
| 1.5 | DB freelance | `src/freelance-db.ts` | Tables créées, CRUD fonctionne, migration intégrée à `src/db.ts` |
| 1.6 | Orchestrateur | `src/scrapers/orchestrator.ts` | Exécute scrapers, déduplique, stocke. Retourne le nb de nouvelles offres. |
| 1.7 | Task scheduler | `src/task-scheduler.ts` (mod) | Tâche `autoapply-scraping` créée, cron `0 8,12,18 * * *` |
| 1.8 | Dépendance cheerio | `package.json` | `npm install cheerio` |
| 1.9 | Test E2E | Manuel | Scrape → stocke → "montre les offres" via chat retourne des résultats |

### Dépendances entre tâches
```
1.1 → 1.3, 1.4 (interfaces nécessaires pour les scrapers)
1.2 → 1.3, 1.4, 1.6 (config nécessaire partout)
1.5 → 1.6 (DB nécessaire pour l'orchestrateur)
1.3, 1.4 → 1.6 (scrapers nécessaires pour l'orchestrateur)
1.6 → 1.7 (orchestrateur nécessaire pour le scheduling)
1.8 → 1.4 (cheerio nécessaire pour Free-Work)
```

### Livrables
- 2 scrapers fonctionnels (BOAMP + Free-Work)
- DB avec table `freelance_offers` remplie
- Scraping automatique 3x/jour
- Consultation via chat basique

---

## Phase 2 — Scrapers restants (2-3 jours)

**Objectif** : Couvrir les 10 sites Priorité 1.

### Tâches

| # | Tâche | Sites | Effort |
|---|-------|-------|--------|
| 2.1 | Freelance simples | Freelance-Informatique, Codeur.com, 404Works | 1 jour |
| 2.2 | Appels d'offre publics | Marchés Online, PLACE, Maximilien | 1 jour |
| 2.3 | Recrutement IT | Externatic, Michael Page | 0.5 jour |
| 2.4 | Tests unitaires | Tous les scrapers | 0.5 jour |
| 2.5 | Validation structurelle | Méthode `test()` par scraper | Intégré aux tests |

### Critères d'acceptation par scraper

Chaque scraper doit :
- [ ] Retourner au moins 1 offre avec `title` et `url` remplis
- [ ] Gérer la pagination (ou justifier son absence)
- [ ] Respecter les rate limits (2s entre requêtes)
- [ ] Avoir un `test()` qui vérifie la structure HTML
- [ ] Gérer les erreurs HTTP gracieusement (log + skip)

### Note sur PLACE/Maximilien
PLACE et Maximilien partagent le même code plateforme. Implémenter `PlaceScraper` avec `baseUrl` configurable :

```typescript
export const placeScraper = createPlaceScraper('https://www.marches-publics.gouv.fr');
export const maximilienScraper = createPlaceScraper('https://marches.maximilien.fr');
```

---

## Phase 3 — Scoring + Adaptation CV (2-3 jours)

**Objectif** : Filtrer les offres pertinentes, générer des CV adaptés.

### Tâches

| # | Tâche | Fichier(s) | Critère d'acceptation |
|---|-------|-----------|----------------------|
| 3.1 | Profile.json | `data/freelance/profile.json` | Profil structuré généré depuis le CV existant de l'utilisateur |
| 3.2 | Scoring Tier 1 | `src/scrapers/relevance.ts` | Score 0-1 calculé en <5ms/offre. Offres SAP/COBOL reçoivent <0.2 |
| 3.3 | Skill freelance-cv | `container/skills/freelance-cv/SKILL.md` | Instructions Claude pour Tier 2 + adaptation CV |
| 3.4 | Flux IPC offres | `src/scrapers/orchestrator.ts` (mod) | Offres score>=0.3 écrites en IPC, container déclenché |
| 3.5 | Manipulation .docx | Container | CV .docx généré lisible, 2 pages max |
| 3.6 | Stockage CV versions | `src/freelance-db.ts` (mod) | Table `freelance_cv_versions` remplie, lien offer_id |
| 3.7 | Notification digest | IPC + router | Utilisateur reçoit top offres + chemin CV adapté |

### Prérequis utilisateur
- [ ] Fournir le CV .docx existant → générer `cv-base.docx` (template)
- [ ] Valider le `profile.json` généré (compétences, TJM, localisation)

### Scoring Tier 1 vs Tier 2

| Aspect | Tier 1 (host) | Tier 2 (container) |
|--------|---------------|-------------------|
| Vitesse | ~1ms/offre | ~2-5s/offre |
| Coût | Gratuit | Tokens Claude |
| Ce qu'il capture | Keywords, TJM, location | Sémantique, contexte métier |
| Seuil | >= 0.3 | >= 0.6 |
| Volume traité | Toutes les offres | Top 20 du Tier 1 |

---

## Phase 4 — Gestion des profils (2-3 jours)

**Objectif** : Synchroniser les profils sur les plateformes automatiquement.

### Tâches

| # | Tâche | Fichier(s) | Critère d'acceptation |
|---|-------|-----------|----------------------|
| 4.1 | Skill freelance-profiles | `container/skills/freelance-profiles/SKILL.md` | Instructions navigation par plateforme |
| 4.2 | Auth interactive | Container + chat | L'utilisateur peut se connecter via le browser containerisé |
| 4.3 | Test Free-Work | Container | Profil Free-Work mis à jour, screenshot de confirmation |
| 4.4 | Autres plateformes | Container | Au moins 2 plateformes supplémentaires |
| 4.5 | Synchro hebdo | Task scheduler | Tâche cron `0 9 * * 1` fonctionnelle |

### Processus d'auth (première fois)

```
1. Utilisateur : "configure mon profil Free-Work"
2. Container ouvre Playwright → page login Free-Work
3. Container (via chat) : "Connecte-toi sur Free-Work : [screenshot login]"
4. Utilisateur se connecte dans le browser partagé
5. Container détecte la connexion réussie
6. Auth-state sauvegardé
7. Container : "✅ Free-Work configuré. Synchro auto activée."
```

**Décision** : noVNC dans le container (Xvfb + x11vnc + websockify). L'utilisateur ouvre `http://localhost:6080/vnc.html` pour interagir avec le browser. Fallback : screenshots + instructions chat.

---

## Phase 5 — Suivi des candidatures + polish (1-2 jours)

**Objectif** : Tracking complet du pipeline, reporting.

### Tâches

| # | Tâche | Fichier(s) | Critère d'acceptation |
|---|-------|-----------|----------------------|
| 5.1 | Table applications | `src/freelance-db.ts` (mod) | CRUD `freelance_applications` |
| 5.2 | Commandes chat | Container skill | "postule à X", "entretien X", etc. fonctionnent |
| 5.3 | Digest quotidien | Notification | Envoyé à 19h si activité du jour |
| 5.4 | Nettoyage auto | Task scheduler | Offres expirées marquées, données >90j purgées |
| 5.5 | Reporting | Container skill | "stats", "combien d'offres", "quelle plateforme" |

### Commandes chat supportées

```
"j'ai postulé à [offre]"     → creates application entry
"entretien pour [offre]"      → response = 'interview'
"accepté [offre]"             → response = 'accepted'
"refusé [offre]"              → response = 'rejected'
"stats candidatures"          → summary table
"combien d'offres cette semaine ?" → count + breakdown
"quelle plateforme a le plus ?"    → ranking by platform
"offres qui expirent bientôt"      → deadline < now + 7 days
```

---

## Résumé des phases

```
Phase 1 (2j)  ████████████░░░░░░░░░░░░░░  MVP : BOAMP + Free-Work + DB
Phase 2 (3j)  ████████████████████░░░░░░  8 scrapers supplémentaires
Phase 3 (3j)  ████████████████████░░░░░░  Scoring + CV adapté
Phase 4 (3j)  ████████████████████░░░░░░  Profils plateformes
Phase 5 (2j)  ████████████░░░░░░░░░░░░░░  Candidatures + polish
              ──────────────────────────
              Total : ~13 jours
```

## Ordre de priorité

Si le temps est contraint :
1. **Phase 1** est non-négociable (fondation)
2. **Phase 3** apporte le plus de valeur (scoring + CV)
3. **Phase 2** étend la couverture (plus d'offres)
4. **Phase 5** améliore le suivi
5. **Phase 4** est la moins urgente (profils manuels OK au début)
