# Base de données — Autoapply

## Stratégie

Extension de la DB SQLite existante (`store/nanoclaw.db`) avec 4 nouvelles tables préfixées `freelance_`. Suit le pattern de migration de `src/db.ts` : ALTER TABLE avec try-catch pour rétrocompatibilité.

## Schéma

### Table `freelance_offers`

Stocke toutes les offres scrappées, toutes plateformes confondues.

```sql
CREATE TABLE IF NOT EXISTS freelance_offers (
  id TEXT PRIMARY KEY,                    -- platform_slug + '_' + platform_id
  platform TEXT NOT NULL,                 -- 'boamp', 'free-work', 'codeur', etc.
  platform_id TEXT NOT NULL,              -- ID unique sur la plateforme source
  title TEXT NOT NULL,                    -- Titre de l'offre
  description TEXT,                       -- Description complète (HTML nettoyé)
  buyer TEXT,                             -- Entreprise / organisme acheteur
  location TEXT,                          -- Localisation (ville, département, remote)
  tjm_min REAL,                           -- TJM minimum (NULL si non renseigné)
  tjm_max REAL,                           -- TJM maximum
  skills TEXT,                            -- JSON array de compétences requises
  offer_type TEXT NOT NULL DEFAULT 'freelance', -- 'freelance', 'cdi', 'appel-offre'
  url TEXT,                               -- Lien direct vers l'offre
  deadline TEXT,                          -- Date limite ISO 8601
  date_published TEXT,                    -- Date de publication ISO 8601
  date_scraped TEXT NOT NULL,             -- Date de scraping ISO 8601
  raw_data TEXT,                          -- JSON brut complet de l'offre
  relevance_score REAL DEFAULT 0,         -- Score Tier 1 (0.0 - 1.0)
  relevance_score_t2 REAL,               -- Score Tier 2 Claude (NULL si pas encore scoré)
  status TEXT NOT NULL DEFAULT 'new',     -- 'new', 'analyzed', 'applied', 'rejected', 'expired'
  UNIQUE(platform, platform_id)
);

-- Index pour les requêtes fréquentes
CREATE INDEX IF NOT EXISTS idx_offers_status ON freelance_offers(status);
CREATE INDEX IF NOT EXISTS idx_offers_platform ON freelance_offers(platform);
CREATE INDEX IF NOT EXISTS idx_offers_score ON freelance_offers(relevance_score DESC);
CREATE INDEX IF NOT EXISTS idx_offers_date ON freelance_offers(date_scraped DESC);
CREATE INDEX IF NOT EXISTS idx_offers_deadline ON freelance_offers(deadline);
```

### Table `freelance_cv_versions`

Versions de CV adaptées par offre.

```sql
CREATE TABLE IF NOT EXISTS freelance_cv_versions (
  id TEXT PRIMARY KEY,                    -- UUID v4
  offer_id TEXT NOT NULL,                 -- FK → freelance_offers.id
  cv_path TEXT NOT NULL,                  -- Chemin relatif vers le .docx généré
  adaptation_notes TEXT,                  -- Ce qui a été modifié et pourquoi (Markdown)
  created_at TEXT NOT NULL,               -- ISO 8601
  FOREIGN KEY (offer_id) REFERENCES freelance_offers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cv_offer ON freelance_cv_versions(offer_id);
```

### Table `freelance_profiles`

État des profils sur chaque plateforme.

```sql
CREATE TABLE IF NOT EXISTS freelance_profiles (
  id TEXT PRIMARY KEY,                    -- UUID v4
  platform TEXT NOT NULL UNIQUE,          -- Nom de la plateforme
  username TEXT,                          -- Identifiant sur la plateforme
  profile_url TEXT,                       -- URL du profil public
  last_synced TEXT,                       -- Dernière synchro réussie ISO 8601
  auth_state_path TEXT,                   -- Chemin vers l'état d'auth Playwright
  status TEXT NOT NULL DEFAULT 'needs-auth' -- 'active', 'needs-auth', 'disabled'
);
```

### Table `freelance_applications`

Suivi des candidatures.

```sql
CREATE TABLE IF NOT EXISTS freelance_applications (
  id TEXT PRIMARY KEY,                    -- UUID v4
  offer_id TEXT NOT NULL,                 -- FK → freelance_offers.id
  cv_version_id TEXT,                     -- FK → freelance_cv_versions.id (NULL si postulé sans CV adapté)
  platform TEXT NOT NULL,                 -- Plateforme de candidature
  applied_at TEXT NOT NULL,               -- Date de candidature ISO 8601
  response TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'interview', 'rejected', 'accepted'
  notes TEXT,                             -- Notes libres
  FOREIGN KEY (offer_id) REFERENCES freelance_offers(id) ON DELETE CASCADE,
  FOREIGN KEY (cv_version_id) REFERENCES freelance_cv_versions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_app_offer ON freelance_applications(offer_id);
CREATE INDEX IF NOT EXISTS idx_app_response ON freelance_applications(response);
```

## Migration

Fichier : `src/freelance-db.ts`

```typescript
// Pattern NanoClaw : try-catch par ALTER TABLE
function migrateFreelanceSchema(db: Database) {
  // Création initiale
  db.exec(`CREATE TABLE IF NOT EXISTS freelance_offers (...)`);
  db.exec(`CREATE TABLE IF NOT EXISTS freelance_cv_versions (...)`);
  db.exec(`CREATE TABLE IF NOT EXISTS freelance_profiles (...)`);
  db.exec(`CREATE TABLE IF NOT EXISTS freelance_applications (...)`);

  // Migrations futures (ajout colonnes)
  try {
    db.exec(`ALTER TABLE freelance_offers ADD COLUMN relevance_score_t2 REAL`);
  } catch { /* column already exists */ }
}
```

Appeler `migrateFreelanceSchema()` depuis `src/db.ts` dans la fonction d'init existante.

## CRUD Patterns

### Offers

```typescript
// Create
insertOffer(offer: FreelanceOffer): void
// Read
getOfferById(id: string): FreelanceOffer | undefined
getNewOffers(): FreelanceOffer[]                    // status = 'new'
getOffersByPlatform(platform: string): FreelanceOffer[]
getTopOffers(limit: number): FreelanceOffer[]       // ORDER BY relevance_score DESC
getOffersNearDeadline(days: number): FreelanceOffer[]
// Update
updateOfferStatus(id: string, status: OfferStatus): void
updateOfferScore(id: string, score: number, tier: 1 | 2): void
// Bulk
upsertOffers(offers: FreelanceOffer[]): number      // INSERT OR IGNORE, retourne nb insérés
markExpiredOffers(): number                          // deadline < now → status = 'expired'
purgeOldOffers(daysOld: number): number              // DELETE WHERE date_scraped < now - N days
```

### CV Versions

```typescript
insertCvVersion(cv: CvVersion): void
getCvVersionsForOffer(offerId: string): CvVersion[]
getLatestCvVersion(offerId: string): CvVersion | undefined
```

### Applications

```typescript
insertApplication(app: Application): void
getApplicationsForOffer(offerId: string): Application[]
getPendingApplications(): Application[]
updateApplicationResponse(id: string, response: AppResponse): void
getApplicationStats(): { total: number, pending: number, interview: number, accepted: number, rejected: number }
```

### Profiles

```typescript
upsertProfile(profile: FreelanceProfile): void
getProfile(platform: string): FreelanceProfile | undefined
getAllProfiles(): FreelanceProfile[]
getProfilesNeedingAuth(): FreelanceProfile[]
updateProfileSyncDate(platform: string): void
```

## Requêtes fréquentes

```sql
-- Digest quotidien : nouvelles offres pertinentes
SELECT * FROM freelance_offers
WHERE status = 'new' AND relevance_score >= 0.3
ORDER BY relevance_score DESC
LIMIT 10;

-- Deadlines proches (7 jours)
SELECT * FROM freelance_offers
WHERE deadline IS NOT NULL
  AND deadline > date('now')
  AND deadline <= date('now', '+7 days')
  AND status NOT IN ('expired', 'rejected')
ORDER BY deadline ASC;

-- Stats par plateforme
SELECT platform, COUNT(*) as total,
  SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_count,
  AVG(relevance_score) as avg_score
FROM freelance_offers
GROUP BY platform;

-- Nettoyage : expirer les offres dépassées
UPDATE freelance_offers
SET status = 'expired'
WHERE deadline < date('now') AND status NOT IN ('applied', 'expired');

-- Purge : supprimer les offres > 90 jours
DELETE FROM freelance_offers
WHERE date_scraped < date('now', '-90 days')
  AND status NOT IN ('applied', 'interview');
```
