# IPC Flows — Autoapply

## Vue d'ensemble

La communication entre le host et les containers suit les patterns IPC NanoClaw existants. Autoapply ajoute 2 flux spécifiques.

## Flux 1 : Scraping → Container (offres pertinentes)

### Direction : Host → Container

Le host écrit les offres pertinentes dans le répertoire IPC du groupe, que le container lit au démarrage.

**Fichier IPC** : `/data/ipc/{groupFolder}/tasks/new_offers.json`

```json
{
  "type": "autoapply_offers",
  "timestamp": "2026-03-25T08:05:00Z",
  "offers": [
    {
      "id": "boamp_2026-123456",
      "platform": "boamp",
      "title": "TMA application web - Ministère de l'Éducation",
      "description": "Maintenance applicative d'un portail web...",
      "buyer": "Ministère de l'Éducation Nationale",
      "location": "Paris / Remote",
      "skills": ["PHP", "Laravel", "PostgreSQL", "Docker"],
      "offerType": "appel-offre",
      "url": "https://www.boamp.fr/pages/avis/?q=idweb:2026-123456",
      "deadline": "2026-04-15",
      "datePublished": "2026-03-24",
      "tier1Score": 0.72
    },
    {
      "id": "free-work_98765",
      "platform": "free-work",
      "title": "Développeur Full Stack PHP/React",
      "description": "Mission de 6 mois...",
      "buyer": "ESN confidentielle",
      "location": "Remote",
      "tjmMin": 500,
      "tjmMax": 600,
      "skills": ["PHP", "React", "TypeScript", "API REST"],
      "offerType": "freelance",
      "url": "https://www.free-work.com/fr/tech-it/jobs/98765",
      "datePublished": "2026-03-25",
      "tier1Score": 0.85
    }
  ],
  "profile": {
    "path": "/workspace/group/data/freelance/profile.json"
  },
  "cvTemplate": {
    "path": "/workspace/group/data/freelance/cv-base.docx"
  }
}
```

### Direction : Container → Host

Le container renvoie les résultats via IPC messages.

**Fichier IPC** : `/data/ipc/{groupFolder}/messages/{timestamp}.json`

#### Message 1 : Résultats Tier 2

```json
{
  "type": "message",
  "chatJid": "whatsapp:main-group-jid",
  "text": "🔍 *3 nouvelles offres pertinentes*\n\n1. **TMA application web** (BOAMP)\n   Score: 0.85 — PHP/Laravel/Docker\n   Deadline: 15 avril\n   → https://boamp.fr/...\n\n2. **Dev Full Stack PHP/React** (Free-Work)\n   Score: 0.78 — 500-600€/j, Remote\n   → https://free-work.com/...\n\nCV adaptés générés dans /workspace/group/cv-versions/",
  "groupFolder": "main"
}
```

#### Message 2 : CV générés

```json
{
  "type": "message",
  "chatJid": "whatsapp:main-group-jid",
  "text": "📄 *CV adaptés*\n\n• boamp_2026-123456 → cv-tma-education.docx\n  Adaptations: mis en avant TMA, Laravel, expérience secteur public\n\n• free-work_98765 → cv-fullstack-react.docx\n  Adaptations: mis en avant React, TypeScript, API REST\n\nRéponds \"postule [offre]\" pour marquer comme candidaté.",
  "groupFolder": "main"
}
```

## Flux 2 : Profile Sync (container → host)

### Direction : Container → Host

**Rapport de synchro** :

```json
{
  "type": "message",
  "chatJid": "whatsapp:main-group-jid",
  "text": "📊 *Synchro profils hebdomadaire*\n\n✅ Free-Work : profil mis à jour\n✅ Codeur.com : profil mis à jour\n❌ Freelance-Informatique : auth expirée, reconnexion nécessaire\n\nPour reconnecter : \"reconnecte freelance-informatique\"",
  "groupFolder": "main"
}
```

### Direction : Container → Host (task IPC)

Si l'auth échoue, le container peut mettre à jour le statut du profil :

```json
{
  "type": "update_profile_status",
  "platform": "freelance-informatique",
  "status": "needs-auth",
  "error": "Session expired, login page returned"
}
```

> **Note** : Ce type de message IPC n'existe pas encore dans NanoClaw. Options :
> 1. Ajouter un nouveau type IPC `update_profile_status`
> 2. Ou le container écrit dans un fichier JSON que le host poll
> 3. Ou le container met à jour directement la DB via MCP tool

## Flux 3 : Commandes utilisateur (chat → container)

L'utilisateur interagit via le chat normal NanoClaw. Les commandes freelance sont traitées par le container agent qui a accès au skill `freelance-cv`.

### Exemples de commandes

```
User: "montre-moi les nouvelles offres"
→ Container lit freelance_offers WHERE status = 'new' ORDER BY relevance_score DESC

User: "postule à l'offre boamp_2026-123456"
→ Container marque l'offre comme 'applied' + crée une entry dans freelance_applications

User: "adapte mon CV pour l'offre free-work_98765"
→ Container génère un CV adapté et le stocke

User: "stats candidatures"
→ Container retourne les stats depuis freelance_applications

User: "combien d'offres cette semaine ?"
→ Container query freelance_offers WHERE date_scraped >= date('now', '-7 days')
```

## Accès aux données dans le container

Le container agent accède aux données freelance via :

1. **SQLite** (lecture directe si montée en volume, ou via MCP tool)
2. **Fichiers IPC** pour les offres fraîchement scrappées
3. **Fichiers workspace** pour profile.json et cv-base.docx

### Mounts nécessaires

```typescript
// Dans container-runner.ts, ajouter aux mounts du groupe main :
{
  source: path.join(DATA_DIR, 'freelance'),
  target: '/workspace/group/data/freelance',
  readOnly: false,  // Le container génère des CV ici
}
```

## Sécurité IPC

- Le scraping IPC ne contient que des données publiques (offres)
- Les auth-states des profils ne transitent PAS par IPC (montés directement dans le container)
- Le container ne peut envoyer de messages qu'au JID autorisé (vérifié par `src/ipc.ts`)
- Les fichiers IPC sont supprimés après traitement
