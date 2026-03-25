# Notifications — Autoapply

## Stratégie

L'utilisateur reçoit des notifications via le canal de messagerie principal (WhatsApp/Telegram) configuré dans NanoClaw. Pas de candidature automatique — l'utilisateur valide avant toute action.

## Types de notifications

### 1. Digest nouvelles offres (après chaque scraping)

**Fréquence** : 1x/jour (20h, quand la machine tourne) — uniquement si nouvelles offres pertinentes

**Format** :

```
📋 *Nouvelles offres freelance* (25 mars, 8h)

*Top 5 par pertinence :*

1. 🟢 **Dev Full Stack PHP/React** — Free-Work
   📍 Remote | 💰 500-600€/j | Score: 0.85
   🏢 ESN confidentielle
   🔧 PHP, React, TypeScript, API REST
   📅 Publiée aujourd'hui
   🔗 https://free-work.com/...
   📄 CV adapté : cv-fullstack-react.docx

2. 🟡 **TMA Application Web** — BOAMP
   📍 Paris | Score: 0.72
   🏢 Ministère de l'Éducation
   🔧 PHP, Laravel, PostgreSQL, Docker
   ⏰ Deadline: 15 avril
   🔗 https://boamp.fr/...
   📄 CV adapté : cv-tma-education.docx

3. 🟡 **Lead Developer Python** — Marchés Online
   📍 Lyon / Remote partiel | Score: 0.68
   ...

───────────────────
📊 Résumé : 12 nouvelles offres scrapées, 5 pertinentes
💾 "montre toutes les offres" pour voir la liste complète
✅ "postule à [1]" pour marquer comme candidaté
```

**Règles de formatage** :
- 🟢 Score >= 0.8 (forte recommandation)
- 🟡 Score >= 0.6 (bonne correspondance)
- 🟠 Score >= 0.4 (correspondance partielle)
- Max 5 offres dans le digest (les meilleures)
- Lien vers l'offre toujours inclus
- CV adapté mentionné si généré

### 2. Digest quotidien récapitulatif (optionnel)

**Fréquence** : 1x/jour (19h) — résumé de la journée

```
📊 *Récap du jour* (25 mars)

• 28 offres scrapées (BOAMP: 15, Free-Work: 8, Autres: 5)
• 7 offres pertinentes (score moyen: 0.72)
• 3 CV adaptés générés
• 2 deadlines cette semaine :
  - TMA Éducation (BOAMP) → 28 mars
  - Portail web DGFIP (PLACE) → 30 mars

📈 Candidatures en cours : 4 pending, 1 entretien
```

### 3. Alerte deadline proche

**Fréquence** : Déclenchée quand une deadline est à J-3 ou J-1

```
⏰ *Deadline proche*

L'offre "TMA Application Web" (BOAMP) expire dans 3 jours (28 mars).
Score: 0.72 | CV adapté disponible

→ "postule à boamp_2026-123456" pour candidater
→ "ignore boamp_2026-123456" pour ignorer
```

### 4. Alerte auth expirée

**Fréquence** : Après échec de synchro profil

```
🔑 *Auth expirée — Free-Work*

La session Free-Work a expiré. Le profil ne peut plus être synchronisé.

Pour reconnecter : "reconnecte free-work"
(Le browser s'ouvrira pour que tu te reconnectes)
```

### 5. Rapport synchro profils (hebdo)

**Fréquence** : Lundi 9h (après synchro)

```
📊 *Synchro profils hebdomadaire*

✅ Free-Work : profil à jour
  → Compétences mises à jour, TJM actualisé
✅ Codeur.com : profil à jour
  → Bio mise à jour
❌ Freelance-Info : auth expirée
  → "reconnecte freelance-info" pour corriger
⏸️ Michael Page : désactivé

Prochaine synchro : lundi 31 mars
```

## Commandes chat

L'utilisateur interagit naturellement avec le bot. Le container agent comprend ces intentions :

### Consultation

| Commande (langage naturel) | Action |
|---------------------------|--------|
| "montre les nouvelles offres" | Liste offres status='new' triées par score |
| "offres de la semaine" | Offres des 7 derniers jours |
| "offres BOAMP" | Filtre par plateforme |
| "offres remote PHP" | Filtre par localisation + skill |
| "détail offre [id]" | Description complète d'une offre |
| "montre le CV pour [offre]" | Affiche les adaptations du CV |

### Actions

| Commande | Action |
|----------|--------|
| "postule à [offre]" | Crée entry applications, status='applied' |
| "ignore [offre]" | Status = 'rejected' |
| "entretien pour [offre]" | Application response = 'interview' |
| "accepté pour [offre]" | Application response = 'accepted' |
| "stats candidatures" | Résumé du pipeline |
| "combien d'offres cette semaine ?" | Count + breakdown |

### Configuration

| Commande | Action |
|----------|--------|
| "pause le scraping" | Pause tâche autoapply-scraping |
| "reprends le scraping" | Resume tâche |
| "mets à jour mes profils" | Déclenche synchro immédiate |
| "reconnecte [plateforme]" | Relance auth interactive |
| "change mon TJM à 650" | Met à jour profile.json |

## Routage des notifications

Les notifications passent par le système IPC standard NanoClaw :

```typescript
// Dans le container
await mcp__nanoclaw__send_message({
  chatJid: mainGroupJid,
  text: formatDigest(offers),
});
```

Le message est routé via `src/router.ts` → canal approprié (WhatsApp, Telegram, etc.).

## Préférences utilisateur (futur)

Paramètres ajustables dans `profile.json` :

```json
{
  "notifications": {
    "digestEnabled": true,
    "digestMaxOffers": 5,
    "deadlineAlertDays": [3, 1],
    "minScoreForNotification": 0.6,
    "quietHours": { "start": "22:00", "end": "07:00" },
    "channels": ["whatsapp"]
  }
}
```
