# Task Scheduler — Intégration Autoapply

## Tâches planifiées

Autoapply crée 3 tâches récurrentes dans le task scheduler NanoClaw existant.

### 1. Scraping des offres

| Attribut | Valeur |
|----------|--------|
| ID | `autoapply-scraping` |
| Cron | `0 20 * * *` (1x/jour, 20h — machine allumée le soir) |
| Context Mode | `isolated` |
| Description | Scrape toutes les plateformes, stocke, score, notifie |

**Flux d'exécution** :
1. Task scheduler déclenche à 20h (ajustable)
2. Appel `orchestrator.runAllScrapers()` côté host (pas de container)
3. Nouvelles offres stockées en DB
4. Scoring Tier 1 sur les nouvelles offres
5. Si offres pertinentes (score >= 0.3) → lance container pour Tier 2 + CV
6. Container envoie digest via IPC `send_message`

**Particularité** : Le scraping lui-même tourne côté host (pas dans un container). Le task scheduler déclenche une fonction TypeScript, pas un prompt Claude.

**Décision** : Extension du scheduler avec type `host_function`. Le scraping tourne sur la machine de l'utilisateur (pas de container = pas de tokens Claude, exécution rapide, accès direct SQLite).

```typescript
// Tâche host-side : le scheduler appelle directement une fonction TS
async function runScrapingTask(): Promise<void> {
  const newOffers = await orchestrator.run();
  if (newOffers.length > 0) {
    // Écrire les offres pertinentes en IPC pour le container
    await writeIpcOffers(newOffers.filter(o => o.relevanceScore >= TIER1_THRESHOLD));
    // Déclencher le container pour Tier 2 + notification
    await runContainerAgent({
      prompt: `Analyse les ${newOffers.length} nouvelles offres freelance et génère un digest.`,
      groupFolder: 'main',
      isScheduledTask: true,
    });
  }
}
```

### 2. Synchronisation des profils

| Attribut | Valeur |
|----------|--------|
| ID | `autoapply-profile-sync` |
| Cron | `0 9 * * 1` (lundi 9h) |
| Context Mode | `isolated` |
| Description | Met à jour les profils sur toutes les plateformes actives |

**Flux d'exécution** :
1. Task scheduler déclenche le lundi à 9h
2. Lance un container avec le skill `freelance-profiles`
3. Le container lit `profile.json` + `freelance_profiles` (DB)
4. Pour chaque plateforme `status = 'active'` :
   - Charge l'auth-state Playwright
   - Navigue vers le profil
   - Met à jour les champs qui diffèrent
5. Rapport via IPC : succès/échecs par plateforme
6. Si auth échoue → notification utilisateur + `status = 'needs-auth'`

**Prompt container** :
```
Met à jour les profils freelance sur toutes les plateformes actives.
Utilise le skill freelance-profiles.
Lis le profil depuis /workspace/group/data/freelance/profile.json.
Pour chaque plateforme dans la DB avec status 'active', connecte-toi et synchronise.
Rapporte les résultats.
```

### 3. Nettoyage

| Attribut | Valeur |
|----------|--------|
| ID | `autoapply-cleanup` |
| Cron | `0 2 * * *` (quotidien 2h) |
| Context Mode | `isolated` |
| Description | Expire les offres dépassées, purge les données anciennes |

**Flux d'exécution** :
1. Task scheduler déclenche à 2h
2. Exécute côté host (pas de container nécessaire)
3. `markExpiredOffers()` : deadline < now → status = 'expired'
4. `purgeOldOffers(90)` : supprime offres > 90 jours (sauf 'applied')
5. Log le nombre d'offres expirées et purgées

```typescript
async function runCleanupTask(): Promise<void> {
  const expired = markExpiredOffers();
  const purged = purgeOldOffers(SCHEDULE_CONFIG.OFFER_RETENTION_DAYS);
  log.info(`Cleanup: ${expired} expired, ${purged} purged`);
}
```

## Enregistrement des tâches

Les tâches sont créées au premier démarrage du module Autoapply :

```typescript
function registerAutoapplyTasks(db: Database): void {
  const tasks = [
    {
      id: 'autoapply-scraping',
      group_folder: 'main',
      prompt: 'AUTOAPPLY_SCRAPING', // Identifiant interne, pas un prompt Claude
      schedule_type: 'cron',
      schedule_value: SCHEDULE_CONFIG.SCRAPING_CRON,
      status: 'active',
      context_mode: 'isolated',
    },
    {
      id: 'autoapply-profile-sync',
      group_folder: 'main',
      prompt: 'Met à jour les profils freelance sur toutes les plateformes actives.',
      schedule_type: 'cron',
      schedule_value: SCHEDULE_CONFIG.PROFILE_SYNC_CRON,
      status: 'active',
      context_mode: 'isolated',
    },
    {
      id: 'autoapply-cleanup',
      group_folder: 'main',
      prompt: 'AUTOAPPLY_CLEANUP',
      schedule_type: 'cron',
      schedule_value: SCHEDULE_CONFIG.CLEANUP_CRON,
      status: 'active',
      context_mode: 'isolated',
    },
  ];

  for (const task of tasks) {
    const existing = getTaskById(task.id);
    if (!existing) {
      createTask({ ...task, next_run: computeNextRun(task) });
    }
  }
}
```

## Extension du scheduler : tâches host-side

Le task scheduler NanoClaw supporte actuellement uniquement des tâches qui lancent un container. Autoapply nécessite des tâches qui exécutent du code TypeScript directement dans le process host.

### Modification de `src/task-scheduler.ts`

Ajouter un registry de fonctions host-side :

```typescript
// Nouveau : registry des fonctions host
type HostTaskFn = () => Promise<{ result: string; triggerContainer?: { prompt: string } }>;

const hostTaskRegistry = new Map<string, HostTaskFn>();

export function registerHostTask(name: string, fn: HostTaskFn): void {
  hostTaskRegistry.set(name, fn);
}

// Dans runTask(), ajouter la branche host-side :
async function runTask(task: ScheduledTask, deps: TaskDeps): Promise<void> {
  const startTime = Date.now();

  try {
    if (task.prompt.startsWith('HOST:')) {
      // ─── Host-side execution ───
      const fnName = task.prompt.slice(5); // "HOST:autoapply_scraping" → "autoapply_scraping"
      const fn = hostTaskRegistry.get(fnName);
      if (!fn) throw new Error(`Unknown host task: ${fnName}`);

      const { result, triggerContainer } = await fn();

      // Log l'exécution
      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        status: 'success',
        result,
      });

      // Optionnel : lancer un container après (pour Tier 2 + notifications)
      if (triggerContainer) {
        await runContainerAgent({
          prompt: triggerContainer.prompt,
          groupFolder: task.group_folder,
          isScheduledTask: true,
        });
      }
    } else {
      // ─── Container execution (existant) ───
      await runContainerAgent({ prompt: task.prompt, ... });
    }
  } catch (error) {
    logTaskRun({ task_id: task.id, status: 'error', error: String(error), ... });
  }
}
```

### Enregistrement des fonctions Autoapply

```typescript
// Dans src/scrapers/orchestrator.ts (au démarrage)
import { registerHostTask } from '../task-scheduler';

registerHostTask('autoapply_scraping', async () => {
  const newOffers = await runAllScrapers();
  const pertinent = newOffers.filter(o => o.relevanceScore >= TIER1_THRESHOLD);

  return {
    result: `${newOffers.length} scraped, ${pertinent.length} pertinent`,
    // Déclencher le container uniquement si offres pertinentes
    triggerContainer: pertinent.length > 0
      ? { prompt: `Analyse ${pertinent.length} nouvelles offres freelance. Tier 2 scoring + CV adapté + digest.` }
      : undefined,
  };
});

registerHostTask('autoapply_cleanup', async () => {
  const expired = markExpiredOffers();
  const purged = purgeOldOffers(90);
  return { result: `${expired} expired, ${purged} purged` };
});
```

### Format des tâches dans la DB

```sql
-- Tâche host-side : prompt préfixé par "HOST:"
INSERT INTO scheduled_tasks (id, group_folder, prompt, schedule_type, schedule_value, status)
VALUES
  ('autoapply-scraping', 'main', 'HOST:autoapply_scraping', 'cron', '0 20 * * *', 'active'),
  ('autoapply-cleanup', 'main', 'HOST:autoapply_cleanup', 'cron', '0 2 * * *', 'active'),
  -- La synchro profils reste en container (besoin de Playwright)
  ('autoapply-profile-sync', 'main', 'Synchronise les profils freelance...', 'cron', '0 9 * * 1', 'active');
```

> **Convention** : Les tâches host-side ont un prompt préfixé `HOST:`. Le scheduler détecte le préfixe et route vers le registry au lieu de spawner un container.

## Diagramme temporel

```
00h  02h       08h       09h       12h       18h       00h
 │    │         │         │         │         │         │
 │    ▼         ▼         │         ▼         ▼         │
 │  Cleanup   Scrape      │       Scrape    Scrape      │
 │  (host)    (host+      │       (host+    (host+      │
 │            container)   │       container) container)  │
 │                         │                              │
 │                         ▼ (lundi uniquement)           │
 │                    Profile Sync                        │
 │                    (container + Playwright)            │
```
