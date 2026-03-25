# Suivi Parsing Sites Freelance & Appels d'Offre

> Dernière mise à jour : 2026-03-24

## Légende

| Statut | Signification |
|--------|---------------|
| OK | Parsing faisable, données publiques accessibles |
| API | API publique disponible (meilleur cas) |
| JS | Nécessite un navigateur headless (Puppeteer/Playwright) |
| AUTH | Requiert authentification / inscription |
| BLOQUÉ | Anti-bot actif (403, Cloudflare, captcha) |
| MORT | Site hors ligne, domaine en vente, ou redirigé |
| N/A | Pas un marketplace freelance / hors scope |

---

## 1. Plateformes Freelance France

| # | Site | URL | Statut | Volume | Format | Notes |
|---|------|-----|--------|--------|--------|-------|
| 1 | **Free-Work** | free-work.com/fr/tech-it/jobs | OK | 10 700+ | HTML SSR + JSON-LD | Meilleure source. Nuxt.js SSR, données structurées, sitemap dispo. Pas d'auth pour consulter. |
| 2 | **Freelance-Informatique** | freelance-informatique.fr/offres-freelance | OK | 1 111+ | HTML SSR | HTML classique, URL patterns clairs, sitemap dispo. Pas d'auth. |
| 3 | **Codeur.com** | codeur.com/projects | OK | 15+/page | HTML + JSON-LD | IDs séquentiels, budget + skills visibles, pagination. Pas d'auth. |
| 4 | **404Works** | 404works.com/fr/projects | OK | 3 356 | HTML | 168 pages, aucun anti-bot, métadonnées complètes. |
| 5 | **Espace Freelance** | espace-freelance.fr/missions-disponibles | OK | ~20 | HTML | Faible volume. reCAPTCHA v3 + Cloudflare présents mais non bloquants. TJM masqué ("selon profil"). |
| 6 | **Kicklox** | app.kicklox.com/missions | JS | ? | SPA JavaScript | Aucun contenu sans JS. Nécessite Puppeteer/Playwright. Wordfence sur le site marketing. |
| 7 | **Turnover-IT** | turnover-it.com | JS | ? | SPA JavaScript | Retourne uniquement CSS/JS. Navigateur headless requis. |
| 8 | **Mindquest** | mindquest.io/missions | JS | 0 affiché | Next.js SPA | Page charge mais "0 offres". Cloudflare CDN. Données chargées côté client. |
| 9 | **Comet** | comet.co | AUTH | — | — | Pas de job board public. Matching interne curated. Missions derrière login. |
| 10 | **Crème de la Crème** | cremedelacreme.io | AUTH | — | Webflow | Pas de listings publics. Portails séparés freelancer/client derrière auth. |
| 11 | **FreelanceRepublik** | freelancerepublik.com | AUTH | — | Webflow | Pas de board public. Matching via "Talent Advocate". App derrière auth. |
| 12 | **LittleBig Connection** | littlebigconnection.com | AUTH | — | Next.js SPA | Plateforme B2B grands comptes (CAC40). Abonnement requis. |
| 13 | **Beager** | beager.com | AUTH | — | HTML + JS | Inscription requise sur app.beager.com. Pas de feed public. |
| 14 | **Freelance.com** | freelance.com | AUTH | — | Vue.js SPA | Plateforme B2B. A absorbé XXE.fr. Missions derrière login. |
| 15 | **Malt** | malt.fr | BLOQUÉ | ? | ? | HTTP 403 systématique. Anti-bot agressif. Nécessiterait proxy résidentiel + headless. |
| 16 | **LeHibou** | lehibou.com | BLOQUÉ | ? | ? | HTTP 403 systématique. Même protection que Malt. |
| 17 | **ComeUp** | comeup.com | BLOQUÉ | ? | ? | HTTP 403. Anti-bot actif. |
| 18 | **Talent.io** | talent.io | BLOQUÉ | ? | ? | Erreur certificat TLS + timeout. Inaccessible. |
| 19 | **XXE** | xxe.fr | MORT | — | — | Redirige vers plateforme.freelance.com. N'existe plus. |
| 20 | **Propulse IT** | propulse-it.com | MORT | — | — | ECONNREFUSED. Serveur hors ligne. |
| 21 | **Skillex** | skillex.fr | MORT | — | — | ECONNREFUSED. Serveur hors ligne. |
| 22 | **Weem** | weem.fr | MORT | — | — | Domaine en vente sur Afternic. |
| 23 | **Wipeo** | wipeo.com | MORT | — | — | Domaine en vente sur Afternic. |
| 24 | **Missioneo** | missioneo.com | MORT | — | — | Timeout. Probablement hors ligne. |
| 25 | **Iziday** | iziday.com | N/A | — | — | Cabinet de conseil data. Pas un marketplace freelance. |

---

## 2. Appels d'Offre Publics

| # | Site | URL | Statut | Volume | Format | Notes |
|---|------|-----|--------|--------|--------|-------|
| 1 | **BOAMP** | boamp.fr | API | 15 800+ | JSON (Opendatasoft) | API publique : boamp-datadila.opendatasoft.com. Aussi dispo sur data.gouv.fr en XML. Licence ouverte. **Meilleur cas possible.** |
| 2 | **Marchés Online** | marchesonline.com/appels-offres/en-cours | OK | 13 800+ | HTML SSR | HTML bien structuré, pagination standard, aucun anti-bot. Excellent. |
| 3 | **PLACE** | marches-publics.gouv.fr | OK | 1 999 | HTML SSR (jQuery) | HTML classique, 10-20 résultats/page, Matomo uniquement. Même plateforme que Maximilien. |
| 4 | **Maximilien** | marches.maximilien.fr | OK | ? | HTML SSR | Même plateforme/code que PLACE. Focus Île-de-France. |
| 5 | **Marchés Sécurisés** | marches-securises.fr | OK | ? | HTML SSR (MooTools) | Partiellement public. Inscription gratuite peut être nécessaire pour données complètes. |
| 6 | **e-Marchés Publics** | e-marchespublics.com | OK | ? | HTML SSR | Agrégateur. Endpoint de recherche : /search/appel-offre/{query}. Freemium. |
| 7 | **Achat Public** | achatpublic.com | N/A | — | — | Simple portail/passerelle. Redirige vers marchesonline.com. |
| 8 | **France Marchés** | francemarches.com | BLOQUÉ | ? | ? | HTTP 403. Anti-bot agressif. Service payant. |

---

## 3. ESN / Cabinets de Recrutement IT

| # | Site | URL | Statut | Volume | Format | Notes |
|---|------|-----|--------|--------|--------|-------|
| 1 | **Externatic** | externatic.fr/offres | OK | 200 | HTML SSR | Le plus simple à parser. Salaires visibles, pagination ?pg=N, Matomo uniquement. |
| 2 | **Michael Page** | michaelpage.fr/jobs/technology | OK | 266 | HTML SSR | HTML propre, données structurées en JS. Pattern URL : /job-detail/[slug]/ref/[id]. |
| 3 | **Randstad Digital** | randstaddigital.fr | JS | 189 | SPA | Full SPA. Filtre freelance dispo mais chargement client-side. Headless requis. |
| 4 | **Silkhom** | silkhom.com/offres-emploi | JS | ? | SPA | JS-rendered + reCAPTCHA caché. Headless + anti-captcha requis. |
| 5 | **Hays** | hays.fr/travailleurs-independants | JS | ~3 freelance | HTML + Liferay | Portail Liferay avec CSRF. Très peu d'offres freelance publiées en ligne. Pas rentable. |

---

## Résumé par priorité d'implémentation

### Priorité 1 — Prêt à parser (HTML/API, pas d'auth, bon volume)

| Site | Type | Volume | Effort |
|------|------|--------|--------|
| BOAMP | Appels d'offre | 15 800+ | Faible (API JSON) |
| Free-Work | Freelance | 10 700+ | Faible (HTML SSR + JSON-LD) |
| Marchés Online | Appels d'offre | 13 800+ | Faible (HTML SSR) |
| 404Works | Freelance | 3 356 | Faible (HTML simple) |
| PLACE | Appels d'offre | 1 999 | Faible (HTML SSR) |
| Freelance-Informatique | Freelance | 1 111+ | Faible (HTML SSR) |
| Codeur.com | Freelance | Pagination | Faible (HTML + JSON-LD) |
| Michael Page | Recrutement IT | 266 | Faible (HTML SSR) |
| Externatic | Recrutement IT | 200 | Très faible (HTML simple) |
| Maximilien | Appels d'offre IDF | ? | Faible (même code que PLACE) |

### Priorité 2 — Faisable avec navigateur headless (Puppeteer/Playwright)

| Site | Type | Manque |
|------|------|--------|
| Kicklox | Freelance | Puppeteer + contournement Wordfence |
| Turnover-IT | Freelance | Puppeteer (SPA pure) |
| Randstad Digital | Recrutement | Puppeteer (SPA) |
| Silkhom | Recrutement | Puppeteer + résolution reCAPTCHA |
| Mindquest | Freelance | Puppeteer + investigation (0 résultats suspect) |

### Priorité 3 — Nécessite authentification (compte à créer)

| Site | Type | Manque |
|------|------|--------|
| Comet | Freelance | Compte + vetting technique |
| Crème de la Crème | Freelance | Compte + entretien de sélection |
| FreelanceRepublik | Freelance | Compte app.freelancerepublik.com |
| LittleBig Connection | Freelance B2B | Abonnement payant |
| Beager | Consulting | Inscription app.beager.com |
| Freelance.com | Freelance B2B | Login plateforme |
| Marchés Sécurisés | Appels d'offre | Inscription gratuite |

### Priorité 4 — Bloqué (anti-bot, proxy nécessaire)

| Site | Type | Manque |
|------|------|--------|
| Malt | Freelance | Proxy résidentiel + headless + anti-détection |
| LeHibou | Freelance | Proxy résidentiel + headless + anti-détection |
| ComeUp | Freelance | Proxy + headless |
| France Marchés | Appels d'offre | Proxy + headless (service payant) |
| Talent.io | Freelance | Fix TLS / proxy |

### Hors scope — À retirer de la liste

| Site | Raison |
|------|--------|
| XXE | Absorbé par Freelance.com |
| Propulse IT | Serveur hors ligne |
| Skillex | Serveur hors ligne |
| Weem | Domaine en vente |
| Wipeo | Domaine en vente |
| Missioneo | Timeout / hors ligne |
| Iziday | Pas un marketplace |
| Achat Public | Simple passerelle vers marchesonline |
| Hays | Trop peu d'offres freelance (<5) |
