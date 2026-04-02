# Problemes identifies — Pipeline Autoapply

Ecarts entre le cahier des charges et l'implementation actuelle.

---

## 1. Notifications WhatsApp — CORRIGE

**Attendu** : 6 messages distincts aux moments cles :
1. Confirmation de demarrage
2. Fin du scraping + bilan intermediaire (nb scrapees, ignorees, retenues)
3. Demarrage de la phase 2
4. Fin de la generation des CV
5. Fin de la generation des PDF
6. Recapitulatif final

**Status** :
- Message 1 (demarrage) : ✅ fait par le container initial qui lance le scraping via IPC
- Message 2 (bilan scraping) : ✅ CORRIGE — `buildDigest()` affiche doublons, offres rejetees (hard-exclusion ou score insuffisant), retenues, deja traitees, en attente Tier 2
- Message 3 (demarrage phase 2) : ✅ CORRIGE — le host envoie "Phase 2 : scoring semantique de N offres en cours..." ou "Aucune offre en attente — pas de phase 2 necessaire."
- Message 3b (bilan scoring) : ✅ CORRIGE — le host envoie le bilan apres scoring (nb apply/maybe, nb CV a generer). Deterministe, lit les SCORING.json du filesystem.
- Message 4 (generation CV) : ✅ CORRIGE — le host envoie "Generation CV : N CV a adapter..." avant et "Generation CV terminee." apres. Si 0 CV a generer, le pipeline s'arrete avec un message explicite.
- Message 5 (generation PDF) : ✅ CORRIGE — le host envoie "N PDFs generes, M echecs" apres la generation.
- Message 6 (recap final) : ✅ CORRIGE — le host envoie un recapitulatif deterministe (offres en attente, candidatures, archivees, total).

Toutes les notifications sont desormais envoyees cote host, de maniere deterministe.

---

## 2. Tracabilite des rejets (cause.md) — CORRIGE

**Attendu** : un `cause.md` pour chaque offre rejetee, a chaque phase (pre-filtrage ET scoring semantique).

**Status** :
- **Phase 1 (Tier 1)** : les offres sous le seuil n'ont pas de dossier (acceptable). Le digest WhatsApp liste les offres rejetees avec leur raison (hard-exclusion ou score insuffisant).
- **Phase 2 (Tier 2)** : ✅ CORRIGE — le LLM ecrit uniquement SCORING.json (avec reasoning obligatoire). Le host lit SCORING.json via `processScoringResults()`, ecrit cause.md a partir du champ `reasoning`, puis deplace vers ARCHIVED. Entierement deterministe.
- **Host-side** (`archiveExpiredOffers`) : ✅ ecrit un `cause.md` — code deterministe.

**Architecture** :
1. Container : ecrit SCORING.json pour CHAQUE offre (apply, maybe, skip) avec reasoning
2. Host : lit SCORING.json → ecrit cause.md pour les skips → deplace vers ARCHIVED
3. Le LLM ne deplace plus de fichiers. Seul le host fait les operations filesystem.

---

## 3. Separation des phases — CORRIGE

**Attendu** : des phases clairement separees (scraping → filtrage → scoring → generation CV → generation PDF → notifications), chacune avec son bilan.

**Status** : ✅ CORRIGE — le pipeline est maintenant decoupe en etapes distinctes avec responsabilite unique :

| Etape | Responsable | Fichier | Role |
|-------|-------------|---------|------|
| Scraping + Tier 1 | Host (`autoapply_scraping`) | `orchestrator.ts` | Scrape, filtre, score par mots-cles, ecrit RAW.json |
| Scoring Tier 2 | Container (`autoapply_scoring`) | `orchestrator.ts` + prompt | Score semantique, ecrit SCORING.json, deplace skips |
| Generation CV | Container (`autoapply_cv_generation`) | `orchestrator.ts` + prompt | Genere CV pour offres apply/maybe sans CV |
| Generation PDF | Host (`autoapply_generate_pdfs`) | `orchestrator.ts` | Convertit CV.docx → PDF via docx2pdf |
| Cleanup | Host (`autoapply_cleanup`) | `orchestrator.ts` | Archive les offres expirees, purge les anciennes |

Le host orchestre la sequence dans `index.ts` : scoring → bilan → CV (si necessaire) → PDF → recap final.
Chaque etape est une host task independante, testable et relancable separement.

---

## 4. Offres deja traitees — CORRIGE

**Attendu** : ignorer les offres deja associees a un CV (ne pas retraiter).

**Status** : ✅ CORRIGE — trois fonctions dans `offer-store.ts` :
- `getUnscoredOffers()` : offres RECU/ sans SCORING.json (pour le scoring)
- `getScoredWithoutCV()` : offres RECU/ avec SCORING.json apply/maybe mais sans CV (pour la generation)
- `getPendingOffers()` : union des deux (pour le bilan)

Le prompt container filtre aussi explicitement les offres deja traitees.
Le host ne lance pas le container CV si `getScoredWithoutCV()` retourne 0.

---

## 5. Integration avec job-collector — partiellement corrige

**Attendu** : job-collector scrape les sites proteges (LinkedIn, LeHibou) et depose dans `freelance-radar/OFFRES/`. NanoClaw scrape les sites sans protection (Free-Work) et traite toutes les offres dans RECU/.

**Status** :
- ✅ NanoClaw scrape Free-Work et ecrit dans OFFRES/
- ✅ NanoClaw scanne tout RECU/ pour le Tier 2 (y compris LinkedIn/LeHibou deposes par job-collector)
- ✅ Le scoring ne se lance que sur les offres sans SCORING.json (pas de retraitement)
- ⚠️ Pas de detection automatique quand job-collector depose de nouvelles offres. Elles seront traitees au prochain run (cron ou WhatsApp).
- ✅ Le `registry.json` est partage entre les deux apps sans conflit.

**Restant** : detection en temps reel des nouvelles offres de job-collector (watchers filesystem ou webhook). Acceptable pour l'instant avec le cron quotidien.

---

## 6. Robustesse du container — CORRIGE

**Attendu** : un pipeline robuste, tracable, deterministe.

**Status** :
- ✅ Pipeline decoupe en etapes a responsabilite unique (scoring, CV, PDF)
- ✅ Notifications et decisions (lancer CV ou pas, archiver ou pas) sont cote host, deterministes
- ✅ Generation PDF host-side (docx2pdf)
- ✅ Le LLM ne deplace plus de fichiers — il ecrit uniquement SCORING.json. Le host fait les mv et ecrit les cause.md
- ✅ `processScoringResults()` verifie chaque offre apres le container et reporte les SCORING.json manquants dans le bilan
- ⚠️ Le LLM peut toujours ne pas ecrire SCORING.json pour certaines offres (reporté dans le bilan comme "non scorees")
- ⚠️ Timeout possible si trop d'offres dans un seul run container

---

## 7. Pre-filtrage vs Scoring — partiellement corrige

**Attendu** : un pre-filtrage (phase 1) qui elimine les offres clairement hors scope, puis un scoring semantique (phase 2) pour les offres restantes.

**Status** :
- ✅ Le Tier 1 fait le pre-filtrage (hard-exclusions) + scoring pondere dans la meme boucle, mais le digest liste maintenant les offres exclues et rejetees avec leur raison.
- ✅ Le Tier 2 ne traite que les offres sans SCORING.json (pas de retraitement).
- ❌ Les offres hard-exclues au Tier 1 n'ont pas de dossier ni de cause.md. Acceptable car elles sont listees dans le digest WhatsApp et dans le registry.

---

## Resume des ecarts

| Exigence | Status | Detail |
|----------|--------|--------|
| Notifications a chaque etape | ✅ Corrige | Toutes les notifications sont host-side et deterministes |
| cause.md pour chaque rejet | ✅ Corrige | Host ecrit cause.md a partir de SCORING.json. Deterministe. |
| Phases clairement separees | ✅ Corrige | 5 tasks distinctes, orchestration host-side |
| Ne pas retraiter les offres avec CV | ✅ Corrige | Filtre par SCORING.json et CV_*.docx |
| Coordination avec job-collector | ⚠️ Partiel | Fonctionne via filesystem partage, pas de detection temps reel |
| Robustesse | ✅ Corrige | LLM ecrit SCORING.json uniquement, host fait le reste |
| Bilan intermediaire avec nb ignorees | ✅ Corrige | Digest complet avec doublons, rejetees, retenues, deja traitees |
