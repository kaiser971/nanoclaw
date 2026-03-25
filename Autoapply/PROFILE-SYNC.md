# Profile Sync — Skill Container

## Vue d'ensemble

Le skill `freelance-profiles` gère la mise à jour automatique des profils sur les plateformes freelance. Exécuté dans le container agent avec accès à Playwright (Chromium).

## Workflow

```
1. Task scheduler déclenche le lundi 9h (cron hebdo)
2. Container lance avec le skill freelance-profiles
3. Lit profile.json (source de vérité)
4. Query freelance_profiles WHERE status = 'active'
5. Pour chaque plateforme active :
   a. Charge l'auth-state Playwright
   b. Navigue vers la page de profil
   c. Compare les données affichées vs profile.json
   d. Met à jour ce qui diffère
   e. Capture screenshot de confirmation
6. Rapport de synchro via IPC
```

## Fichier skill : `container/skills/freelance-profiles/SKILL.md`

```markdown
---
name: freelance-profiles
description: Synchronise les profils freelance sur les plateformes
allowed-tools: ["mcp__nanoclaw__send_message"]
---

# Freelance Profile Sync

Tu synchronises le profil du freelance sur les plateformes où il est inscrit.

## Sources de données

- **Profil source de vérité** : `/workspace/group/data/freelance/profile.json`
- **Auth states** : `/workspace/group/data/freelance-auth/{platform}/`
- **DB profils** : accessible via MCP tools (ou fichier snapshot)

## Plateformes supportées

### Free-Work (free-work.com)
1. Charger l'auth-state depuis `/workspace/group/data/freelance-auth/free-work/`
2. Naviguer vers https://www.free-work.com/fr/profil/edit
3. Mettre à jour :
   - Titre professionnel
   - Description / bio
   - Compétences techniques (tags)
   - TJM souhaité
   - Disponibilité
   - CV attaché (upload du dernier cv-base.docx)
4. Sauvegarder

### Codeur.com
1. Charger l'auth-state
2. Naviguer vers le profil
3. Mettre à jour les champs modifiables
4. Sauvegarder

### Freelance-Informatique
1. Charger l'auth-state
2. Naviguer vers la gestion de profil
3. Mettre à jour
4. Sauvegarder

## Gestion de l'authentification

### Première connexion (setup)
L'utilisateur doit se connecter manuellement la première fois :
1. Container ouvre le browser via agent-browser
2. Navigue vers la page de login
3. Demande à l'utilisateur de se connecter (via notification chat)
4. Une fois connecté, sauvegarde l'auth-state Playwright
5. Crée l'entrée dans freelance_profiles avec status = 'active'

### Reconnexion
Si l'auth-state a expiré :
1. Tente de charger l'auth-state existant
2. Si la session est expirée (redirection vers login) :
   - Marque le profil comme 'needs-auth'
   - Notifie l'utilisateur
   - Passe à la plateforme suivante

## Format de rapport

Pour chaque plateforme, rapporter :
- ✅ Succès : ce qui a été mis à jour
- ⚠️ Warning : champs non modifiables ou différences détectées
- ❌ Échec : raison (auth expirée, structure HTML changée, etc.)

## Règles

- Ne jamais modifier les données de facturation ou paiement
- Ne pas changer le mot de passe
- Prendre un screenshot après chaque mise à jour
- Si un champ ne correspond pas au format attendu, le noter mais ne pas forcer
- Timeout par plateforme : 5 minutes max
```

## Auth-state Playwright

Chaque plateforme a son propre état d'authentification :

```
data/freelance-auth/
  free-work/
    auth-state.json      # Cookies + localStorage Playwright
    last-login.txt       # Date de dernière connexion
  codeur/
    auth-state.json
    last-login.txt
  freelance-info/
    auth-state.json
    last-login.txt
```

### Format auth-state.json (Playwright)

```json
{
  "cookies": [...],
  "origins": [
    {
      "origin": "https://www.free-work.com",
      "localStorage": [...]
    }
  ]
}
```

### Sauvegarde

```typescript
// Dans le container, via Playwright
const context = await browser.newContext({ storageState: authStatePath });
// ... navigation, login ...
await context.storageState({ path: authStatePath });
```

## Table freelance_profiles

```sql
-- Exemple d'état après setup
INSERT INTO freelance_profiles VALUES
  ('uuid1', 'free-work', 'john.doe', 'https://free-work.com/fr/profil/john-doe',
   '2026-03-24T09:00:00Z', 'data/freelance-auth/free-work/auth-state.json', 'active'),
  ('uuid2', 'codeur', 'johndoe', 'https://codeur.com/u/johndoe',
   '2026-03-24T09:00:00Z', 'data/freelance-auth/codeur/auth-state.json', 'active'),
  ('uuid3', 'freelance-info', 'john-doe', NULL,
   NULL, NULL, 'needs-auth');
```

## Phases de déploiement

### Phase 4.1 — Setup initial
- Commande chat : "configure mon profil Free-Work"
- Le container ouvre le browser, l'utilisateur se connecte
- Auth-state sauvegardé

### Phase 4.2 — Synchro manuelle
- Commande chat : "mets à jour mes profils"
- Le container synchronise toutes les plateformes actives

### Phase 4.3 — Synchro automatique
- Tâche cron hebdomadaire
- Rapport envoyé sans intervention utilisateur
- Alertes uniquement en cas de problème

## Risques et mitigations

| Risque | Mitigation |
|--------|------------|
| Auth expirée sans détection | Vérification systématique au début de chaque synchro |
| Structure HTML changée | Les sélecteurs sont dans le SKILL.md, Claude s'adapte |
| Rate limiting plateforme | 1 plateforme à la fois, délais entre actions |
| Données incohérentes | profile.json est la source de vérité unique |
| CAPTCHA sur login | Notification utilisateur pour résolution manuelle |
