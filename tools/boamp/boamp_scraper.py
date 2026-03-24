#!/usr/bin/env python3
"""BOAMP Scraper — Services Web (TMA, Dev, Formation, IA).

Récupère les dernières offres de marchés publics liées aux services web
(TMA, développement, formation, intelligence artificielle)
via l'API OpenDataSoft du BOAMP.

Pour chaque offre :
  - Crée un dossier dédié avec un fichier Markdown décrivant l'offre
  - Télécharge la synthèse HTML et le contenu complet
  - Génère les templates de réponse nécessaires
  - Classifie l'offre par type (TMA, Dev, Formation, IA)

Déduplication via un registre JSON local.
"""

from __future__ import annotations

import json
import logging
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import requests

from config import (
    ALL_SEARCH_TERMS,
    BASE_URL,
    BOAMP_NOTICE_URL,
    DATA_DIR,
    DATASET_BOAMP,
    DATASET_HTML,
    DEV_TERMS,
    FORMATION_TERMS,
    IA_TERMS,
    MAX_RESULTS,
    NOTICE_TYPES,
    OFFRES_DIR,
    OfferType,
    REGISTRY_FILE,
    TMA_TERMS,
)
from ae_generator import generate_ae
from dc1_generator import generate_dc1
from dc2_generator import generate_dc2
from dpgf_generator import generate_dpgf
from entreprise import ENTREPRISE as E
from memoire_generator import generate_memoire
from place_client import PlaceClient, fetch_dce_for_notice

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Registry (deduplication)
# ---------------------------------------------------------------------------


def load_registry() -> dict[str, Any]:
    """Load the deduplication registry from disk."""
    if REGISTRY_FILE.exists():
        return json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))
    return {"seen": {}}


def save_registry(registry: dict[str, Any]) -> None:
    """Persist the deduplication registry."""
    REGISTRY_FILE.write_text(
        json.dumps(registry, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def is_seen(registry: dict[str, Any], idweb: str) -> bool:
    """Check whether a notice has already been processed."""
    return idweb in registry.get("seen", {})


def mark_seen(registry: dict[str, Any], idweb: str, title: str, offer_type: str = "") -> None:
    """Mark a notice as processed."""
    registry.setdefault("seen", {})[idweb] = {
        "title": title,
        "offer_type": offer_type,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# BOAMP API helpers
# ---------------------------------------------------------------------------


def _build_where_clause() -> str:
    """Build the ODSQL WHERE clause for web services.

    Filters to only include notices with a future response deadline.
    """
    all_parts = " OR ".join(f'search(objet,"{t}")' for t in ALL_SEARCH_TERMS)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    where = f"({all_parts})" f' AND datelimitereponse >= "{today}"'
    return where


def classify_offer(notice: dict[str, Any]) -> str:
    """Classify a notice into an offer type based on keywords.
    Priority: IA > FORMATION > DEVELOPPEMENT > TMA (default).
    """
    objet = (notice.get("objet") or "").lower()
    descripteurs = notice.get("descripteur_libelle", "")
    if isinstance(descripteurs, list):
        descripteurs = " ".join(descripteurs).lower()
    else:
        descripteurs = (descripteurs or "").lower()
    text = f"{objet} {descripteurs}"

    for term in IA_TERMS:
        if term.lower() in text:
            return OfferType.IA
    for term in FORMATION_TERMS:
        if term.lower() in text:
            return OfferType.FORMATION
    for term in DEV_TERMS:
        if term.lower() in text:
            return OfferType.DEVELOPPEMENT
    return OfferType.TMA


def search_notices(limit: int = MAX_RESULTS) -> list[dict[str, Any]]:
    """Search BOAMP for web services notices, newest first."""
    url = f"{BASE_URL}/{DATASET_BOAMP}/records"
    params = {
        "where": _build_where_clause(),
        "select": (
            "idweb,objet,nomacheteur,dateparution,datelimitereponse,"
            "nature_categorise_libelle,type_marche,procedure_categorise,"
            "descripteur_libelle,url_avis,donnees,gestion"
        ),
        "order_by": "dateparution desc",
        "limit": limit,
    }
    log.info("Recherche BOAMP: %s", params["where"][:120] + "…")
    resp = requests.get(url, params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    total = data.get("total_count", 0)
    results = data.get("results", [])
    log.info("Trouvé %d résultats (affichés: %d)", total, len(results))
    return results


def fetch_notice_html(idweb: str) -> tuple[Optional[str], Optional[str]]:
    """Fetch the full HTML and synthesis HTML for a notice."""
    url = f"{BASE_URL}/{DATASET_HTML}/records"
    params = {
        "where": f'idweb="{idweb}"',
        "select": "html,htmlsynthese",
        "limit": 1,
    }
    resp = requests.get(url, params=params, timeout=30)
    resp.raise_for_status()
    results = resp.json().get("results", [])
    if not results:
        return None, None
    record = results[0]
    return record.get("html"), record.get("htmlsynthese")


# ---------------------------------------------------------------------------
# XML / données parsing
# ---------------------------------------------------------------------------


def parse_donnees_xml(donnees_raw: Optional[str]) -> dict[str, Any]:
    """Extract structured info from the eForms/legacy XML in 'donnees'."""
    info: dict[str, Any] = {
        "lots": [],
        "cpv_codes": [],
        "lieu_execution": "",
        "duree": "",
        "valeur_estimee": "",
        "criteres": [],
        "profil_acheteur": "",
        "contact": {},
    }
    if not donnees_raw:
        return info

    try:
        root = ET.fromstring(donnees_raw)
    except ET.ParseError:
        return info

    # Namespace-agnostic search helper
    def find_all_tags(tag: str) -> list[ET.Element]:
        found = []
        for el in root.iter():
            local = el.tag.split("}")[-1] if "}" in el.tag else el.tag
            if local == tag:
                found.append(el)
        return found

    def find_text(tag: str) -> str:
        elems = find_all_tags(tag)
        if elems and elems[0].text:
            return elems[0].text.strip()
        return ""

    # Buyer profile URL
    for tag_name in ("URL_PROFIL_ACHETEUR", "BuyerProfileURL", "URLProfilAcheteur"):
        val = find_text(tag_name)
        if val:
            info["profil_acheteur"] = val
            break

    # CPV codes
    for el in find_all_tags("CPV_PRINCIPAL") + find_all_tags("CpvMain"):
        code_el = list(el)
        if code_el and code_el[0].text:
            info["cpv_codes"].append(code_el[0].text.strip())
    for el in find_all_tags("CPV_CODE"):
        code = el.get("CODE", el.text or "")
        if code:
            info["cpv_codes"].append(code.strip())

    # Duration
    for tag_name in ("DUREE_MOIS", "DurationMonths", "DureeMois"):
        val = find_text(tag_name)
        if val:
            info["duree"] = f"{val} mois"
            break

    # Estimated value
    for tag_name in ("VALEUR_ESTIMEE", "EstimatedValue"):
        val = find_text(tag_name)
        if val:
            info["valeur_estimee"] = f"{val} €"
            break

    info["cpv_codes"] = list(set(info["cpv_codes"]))
    return info


# ---------------------------------------------------------------------------
# Directory & file generation
# ---------------------------------------------------------------------------


def sanitize_dirname(name: str) -> str:
    """Create a filesystem-safe directory name."""
    safe = name.replace("/", "-").replace("\\", "-").replace(":", "-")
    safe = "".join(c for c in safe if c.isalnum() or c in " -_.()")
    return safe.strip()[:80]


def create_offer_markdown(notice: dict[str, Any], parsed: dict[str, Any]) -> str:
    """Generate a comprehensive Markdown file for a notice."""
    idweb = notice.get("idweb", "N/A")
    objet = notice.get("objet", "Sans titre")
    acheteur = notice.get("nomacheteur", "Non renseigné")
    date_pub = notice.get("dateparution", "N/A")
    date_limite = notice.get("datelimitereponse", "N/A")
    nature = notice.get("nature_categorise_libelle", "N/A")
    type_marche = notice.get("type_marche", "N/A")
    procedure = notice.get("procedure_categorise", "N/A")
    descripteurs = notice.get("descripteur_libelle", "")
    url_avis = notice.get("url_avis", "")
    boamp_url = BOAMP_NOTICE_URL.format(idweb=idweb)

    if isinstance(descripteurs, list):
        descripteurs = ", ".join(descripteurs)

    lines = [
        f"# {objet}",
        "",
        f"**ID BOAMP:** {idweb}  ",
        f"**Acheteur:** {acheteur}  ",
        f"**Date de publication:** {date_pub}  ",
        f"**Date limite de réponse:** {date_limite}  ",
        f"**Nature:** {nature}  ",
        f"**Type de marché:** {type_marche}  ",
        f"**Procédure:** {procedure}  ",
        "",
    ]

    if descripteurs:
        lines += [f"**Descripteurs:** {descripteurs}  ", ""]

    if parsed.get("cpv_codes"):
        lines += [f"**Codes CPV:** {', '.join(parsed['cpv_codes'])}  ", ""]

    if parsed.get("duree"):
        lines += [f"**Durée:** {parsed['duree']}  ", ""]

    if parsed.get("valeur_estimee"):
        lines += [f"**Valeur estimée:** {parsed['valeur_estimee']}  ", ""]

    lines += [
        "---",
        "",
        "## Liens",
        "",
        f"- [Voir l'avis sur BOAMP]({boamp_url})",
    ]

    if url_avis:
        lines += [f"- [Lien direct avis]({url_avis})"]

    if parsed.get("profil_acheteur"):
        lines += [
            f"- [Profil acheteur (DCE)]({parsed['profil_acheteur']})",
            "  > **C'est ici que se trouvent les documents de consultation (DCE)**",
        ]

    lines += [
        "",
        "---",
        "",
        "## Structure du dossier",
        "",
        "```",
        f"{idweb}/",
        "├── offre.md                  ← Ce fichier",
        "├── avis_complet.html         ← Avis HTML complet",
        "├── synthese.html             ← Synthèse HTML",
        "├── documents/                ← Documents téléchargés du DCE",
        "│   └── README.md             ← Instructions de téléchargement",
        "└── reponse/                  ← Dossier de réponse",
        "    ├── 01_lettre_candidature_DC1.md",
        "    ├── 02_declaration_candidat_DC2.md",
        "    ├── 03_memoire_technique.md",
        "    ├── 04_acte_engagement.md",
        "    ├── 05_bordereau_prix.md",
        "    ├── 06_planning_execution.md",
        "    └── 07_references_clients.md",
        "```",
        "",
    ]

    return "\n".join(lines)


def create_documents_readme(notice: dict[str, Any], parsed: dict[str, Any]) -> str:
    """Generate a README for the documents directory with download instructions."""
    idweb = notice.get("idweb", "N/A")
    acheteur = notice.get("nomacheteur", "Non renseigné")
    profil = parsed.get("profil_acheteur", "")

    lines = [
        "# Documents de consultation (DCE)",
        "",
        f"## Offre : {notice.get('objet', 'N/A')} ({idweb})",
        f"**Acheteur :** {acheteur}",
        "",
        "---",
        "",
        "## Comment obtenir les documents",
        "",
        "Le BOAMP ne distribue pas directement les documents de consultation.",
        "Ils sont disponibles sur la plateforme de l'acheteur.",
        "",
    ]

    if profil:
        lines += [
            f"### Lien vers le profil acheteur",
            "",
            f"**→ [{profil}]({profil})**",
            "",
            "### Étapes :",
            "",
            "1. Accédez au lien ci-dessus",
            "2. Recherchez l'offre par son objet ou numéro de référence",
            "3. Créez un compte si nécessaire (gratuit)",
            "4. Téléchargez le DCE (Dossier de Consultation des Entreprises)",
            "",
        ]
    else:
        lines += [
            "### Profil acheteur non renseigné",
            "",
            "Le lien vers le profil acheteur n'a pas été trouvé dans l'avis.",
            "Recherchez l'offre sur les plateformes courantes :",
            "",
            "- [PLACE (marchés de l'État)](https://www.marches-publics.gouv.fr/)",
            "- [Mégalis Bretagne](https://www.megalisbretagne.org/)",
            "- [AWS (achatpublic.com)](https://www.achatpublic.com/)",
            "- [Maximilien (Île-de-France)](https://www.maximilien.fr/)",
            "- [e-Marchespublics](https://www.e-marchespublics.com/)",
            "",
        ]

    lines += [
        "### Documents typiques du DCE :",
        "",
        "- [ ] Règlement de consultation (RC)",
        "- [ ] Cahier des Clauses Administratives Particulières (CCAP)",
        "- [ ] Cahier des Clauses Techniques Particulières (CCTP)",
        "- [ ] Bordereau des Prix Unitaires (BPU) / DPGF",
        "- [ ] Acte d'Engagement (AE)",
        "- [ ] Formulaires DC1, DC2, DC4",
        "- [ ] Annexes techniques",
        "",
        "**Placez les documents téléchargés dans ce dossier.**",
    ]

    return "\n".join(lines)


def create_response_template_dc1(notice: dict[str, Any]) -> str:
    """Template DC1 — Lettre de candidature."""
    objet = notice.get("objet", "[OBJET DU MARCHÉ]")
    acheteur = notice.get("nomacheteur", "[ACHETEUR]")
    idweb = notice.get("idweb", "[REF]")

    return f"""# DC1 — Lettre de Candidature

> Formulaire de candidature — Habilitation du mandataire par ses cotraitants

---

## 1. Objet du marché

| Champ | Valeur |
|-------|--------|
| **Référence BOAMP** | {idweb} |
| **Objet** | {objet} |
| **Pouvoir adjudicateur** | {acheteur} |

## 2. Identification du candidat

| Champ | Valeur |
|-------|-------|
| **Raison sociale** | {E['raison_sociale']} |
| **Forme juridique** | {E['forme_juridique']} |
| **SIRET** | {E['siret']} |
| **N° TVA** | {E['tva_intra']} |
| **Capital social** | {E['capital_social']} |
| **Adresse** | {E['adresse']}, {E['code_postal']} {E['ville']} |
| **Téléphone** | {E['telephone']} |
| **Email** | {E['email']} |
| **Représentant légal** | {E['representant_prenom']} {E['representant_nom']}, {E['representant_qualite']} |

## 3. Type de candidature

- [x] Candidature individuelle
- [ ] Candidature groupée (cotraitance)
  - [ ] Groupement conjoint
  - [ ] Groupement solidaire

## 4. Sous-traitance

- [ ] Le candidat ne prévoit pas de sous-traiter
- [ ] Le candidat prévoit de sous-traiter :

| Sous-traitant | Prestations | Montant estimé |
|---------------|-------------|----------------|
| [NOM] | [DESCRIPTION] | [MONTANT] € HT |

## 5. Déclaration sur l'honneur

Le candidat déclare sur l'honneur :

- [x] Ne pas être en état de liquidation judiciaire
- [x] Être en règle au regard des articles L. 5212-1 à L. 5212-11 du code du travail (emploi des travailleurs handicapés)
- [x] Ne pas avoir fait l'objet d'une exclusion des marchés publics

## 6. Signature

| | |
|---|---|
| **Fait à** | {E['ville']}, le [DATE] |
| **Signature** | {E['representant_prenom']} {E['representant_nom']}, {E['representant_qualite']} |
"""


def create_response_template_dc2(notice: dict[str, Any]) -> str:
    """Template DC2 — Déclaration du candidat."""
    objet = notice.get("objet", "[OBJET DU MARCHÉ]")
    acheteur = notice.get("nomacheteur", "[ACHETEUR]")

    return f"""# DC2 — Déclaration du Candidat Individuel ou Membre du Groupement

---

## 1. Identification du marché

| Champ | Valeur |
|-------|--------|
| **Objet** | {objet} |
| **Pouvoir adjudicateur** | {acheteur} |

## 2. Identification du candidat

| Champ | Valeur |
|-------|-------|
| **Raison sociale** | {E['raison_sociale']} |
| **N° SIREN** | {E['siren']} |
| **N° SIRET** | {E['siret']} |
| **N° TVA intracommunautaire** | {E['tva_intra']} |
| **Code APE/NAF** | {E['code_naf']} — {E['libelle_naf']} |
| **Forme juridique** | {E['forme_juridique']} |
| **Capital social** | {E['capital_social']} |
| **Date de création** | {E['date_creation']} |
| **Adresse** | {E['adresse']}, {E['code_postal']} {E['ville']} |
| **Convention collective** | {E['convention_collective']} |

## 3. Capacités économiques et financières

### Chiffre d'affaires des 3 derniers exercices

| Exercice | CA global (€ HT) | CA lié au domaine (€ HT) |
|----------|-------------------|--------------------------|
| {datetime.now().year - 3} | [MONTANT] | [MONTANT] |
| {datetime.now().year - 2} | [MONTANT] | [MONTANT] |
| {datetime.now().year - 1} | [MONTANT] | [MONTANT] |

### Assurances

| Type | Compagnie | N° Police | Montant garanti |
|------|-----------|-----------|-----------------|
| RC Professionnelle | [ASSUREUR] | [N°] | [MONTANT] € |
| RC Exploitation | [ASSUREUR] | [N°] | [MONTANT] € |

## 4. Capacités techniques et professionnelles

### Moyens humains

| Profil | Nombre | Certifications |
|--------|--------|----------------|
| Chef de projet / Gérant | 1 | [CERTIFICATIONS] |
| Développeur senior | [N] | [CERTIFICATIONS] |
| Développeur | [N] | [CERTIFICATIONS] |
| Analyste / QA | [N] | [CERTIFICATIONS] |

### Moyens techniques

- **Outils de gestion de projet :** [JIRA / Azure DevOps / ...]
- **Outils de suivi :** [ITSM / ServiceNow / ...]
- **Environnements techniques :** [TECHNOLOGIES MAÎTRISÉES]
- **Certifications entreprise :** [ISO / AUTRES]

## 5. Pièces justificatives à joindre

- [ ] Extrait Kbis de moins de 3 mois
- [ ] Attestations fiscales et sociales
- [ ] Attestation d'assurance RC professionnelle
- [ ] Certificats de qualification (si applicable)
- [ ] Bilans et comptes de résultat (3 dernières années)
"""


def create_response_template_memoire(notice: dict[str, Any]) -> str:
    """Template Mémoire Technique — cœur de la réponse TMA."""
    objet = notice.get("objet", "[OBJET DU MARCHÉ]")
    acheteur = notice.get("nomacheteur", "[ACHETEUR]")
    idweb = notice.get("idweb", "[REF]")

    return f"""# Mémoire Technique

## {objet}

**Pouvoir adjudicateur :** {acheteur}
**Référence BOAMP :** {idweb}

---

## Table des matières

1. [Présentation de la société](#1-présentation-de-la-société)
2. [Compréhension du besoin](#2-compréhension-du-besoin)
3. [Méthodologie TMA proposée](#3-méthodologie-tma-proposée)
4. [Organisation et gouvernance](#4-organisation-et-gouvernance)
5. [Équipe dédiée](#5-équipe-dédiée)
6. [Outillage et environnement technique](#6-outillage-et-environnement-technique)
7. [Engagements de service (SLA)](#7-engagements-de-service-sla)
8. [Gestion de la transition / réversibilité](#8-gestion-de-la-transition--réversibilité)
9. [Références clients similaires](#9-références-clients-similaires)
10. [Démarche qualité et amélioration continue](#10-démarche-qualité-et-amélioration-continue)
11. [Annexes](#11-annexes)

---

## 1. Présentation de la société

### 1.1 Identité
| | |
|---|---|
| **Raison sociale** | {E['raison_sociale']} |
| **Forme juridique** | {E['forme_juridique']} |
| **SIRET** | {E['siret']} |
| **Date de création** | {E['date_creation']} |
| **Capital social** | {E['capital_social']} |
| **Activité** | {E['libelle_naf']} ({E['code_naf']}) |
| **Siège social** | {E['adresse']}, {E['code_postal']} {E['ville']} |
| **Dirigeant** | {E['representant_prenom']} {E['representant_nom']}, {E['representant_qualite']} |

### 1.2 Positionnement et expertise
> [Décrire l'expertise de {E['raison_sociale']} en prestations de services web :
> TMA, développement, formation, intelligence artificielle]

### 1.3 Certifications et labels
- [ ] ISO 9001 — Management de la qualité
- [ ] ISO 27001 — Sécurité de l'information
- [ ] Autres : [PRÉCISER]

---

## 2. Compréhension du besoin

### 2.1 Contexte
> [Reformuler le contexte de l'acheteur : enjeux, périmètre applicatif,
> contraintes spécifiques au secteur concerné]

### 2.2 Périmètre applicatif
| Application | Technologies | Criticité | Utilisateurs |
|-------------|-------------|-----------|-------------|
| [APP 1] | [TECH] | [HAUTE/MOYENNE/BASSE] | [NOMBRE] |
| [APP 2] | [TECH] | [HAUTE/MOYENNE/BASSE] | [NOMBRE] |

### 2.3 Enjeux identifiés
1. [Enjeu 1 — ex: continuité de service, haute disponibilité]
2. [Enjeu 2 — ex: conformité RGPD / sécurité des données]
3. [Enjeu 3 — ex: interopérabilité avec les SI existants]

---

## 3. Méthodologie TMA proposée

### 3.1 Types d'interventions

#### Maintenance corrective
> [Décrire le processus de prise en charge des incidents et bugs]

| Priorité | Description | Délai de prise en charge | Délai de résolution |
|----------|-------------|--------------------------|---------------------|
| P1 — Critique | Blocage complet | [DÉLAI] | [DÉLAI] |
| P2 — Majeure | Fonctionnalité dégradée | [DÉLAI] | [DÉLAI] |
| P3 — Mineure | Anomalie non bloquante | [DÉLAI] | [DÉLAI] |
| P4 — Évolution | Demande d'amélioration | [DÉLAI] | [DÉLAI] |

#### Maintenance évolutive
> [Décrire le processus de gestion des évolutions fonctionnelles]

1. Recueil et analyse du besoin
2. Chiffrage et proposition de solution
3. Spécification détaillée
4. Développement
5. Tests (unitaires, intégration, recette)
6. Mise en production
7. Vérification de service régulier (VSR)

#### Maintenance préventive
> [Décrire les actions proactives : veille technologique, mise à jour
> de sécurité, optimisation des performances]

### 3.2 Processus de gestion des demandes
```
Demande → Qualification → Analyse → Chiffrage → Validation
    → Réalisation → Tests → Livraison → Recette → MEP
```

---

## 4. Organisation et gouvernance

### 4.1 Instances de pilotage

| Instance | Fréquence | Participants | Objectif |
|----------|-----------|-------------|----------|
| Comité de pilotage | Trimestriel | Direction + DSI | Bilan, orientations |
| Comité de suivi | Mensuel | CP + Référents | Suivi activité, KPI |
| Point opérationnel | Hebdomadaire | Équipe projet | Suivi tickets, planning |

### 4.2 Reporting
> [Décrire les tableaux de bord et indicateurs fournis]

---

## 5. Équipe dédiée

### 5.1 Organigramme projet

```
        Directeur de projet
              │
        Chef de projet TMA
         ┌────┼────┐
    Dev Senior  Dev   QA/Recette
```

### 5.2 Profils proposés

| Rôle | Nom | Expérience | Taux occupation |
|------|-----|-----------|-----------------|
| Directeur de projet | [NOM] | [N] ans | [N]% |
| Chef de projet TMA | [NOM] | [N] ans | [N]% |
| Développeur senior | [NOM] | [N] ans | [N]% |
| Développeur | [NOM] | [N] ans | [N]% |
| Testeur / QA | [NOM] | [N] ans | [N]% |

> [Joindre les CV en annexe]

---

## 6. Outillage et environnement technique

| Fonction | Outil proposé |
|----------|---------------|
| Gestion des tickets | [JIRA / ServiceNow / Redmine] |
| Gestion de code source | [Git / GitLab / GitHub] |
| CI/CD | [Jenkins / GitLab CI / GitHub Actions] |
| Gestion documentaire | [Confluence / SharePoint] |
| Supervision | [Grafana / Datadog / Zabbix] |
| Communication | [Teams / Slack] |

---

## 7. Engagements de service (SLA)

| Indicateur | Cible | Pénalité |
|------------|-------|----------|
| Disponibilité applicative | [99.X]% | [MONTANT/FORMULE] |
| Taux de résolution P1 dans les délais | [N]% | [MONTANT/FORMULE] |
| Taux de résolution P2 dans les délais | [N]% | [MONTANT/FORMULE] |
| Délai moyen de prise en charge | < [N]h | [MONTANT/FORMULE] |

---

## 8. Gestion de la transition / réversibilité

### 8.1 Phase de transition (prise en charge)
> [Décrire le plan de transition : reprise documentaire, transfert de
> connaissances, montée en compétence, période de tuilage]

| Phase | Durée | Activités |
|-------|-------|-----------|
| Cadrage | [N] semaines | Kick-off, documentation |
| Montée en compétence | [N] semaines | Shadowing, analyse code |
| Run accompagné | [N] semaines | Co-traitement avec sortant |
| Autonomie | Continu | TMA en régime établi |

### 8.2 Plan de réversibilité
> [Décrire les modalités de transfert en fin de contrat]

---

## 9. Références clients similaires

| Client | Secteur | Objet | Durée | Montant |
|--------|---------|-------|-------|---------|
| [CLIENT 1] | [SECTEUR] | [DESCRIPTION] | [DURÉE] | [MONTANT] € |
| [CLIENT 2] | [SECTEUR] | [DESCRIPTION] | [DURÉE] | [MONTANT] € |
| [CLIENT 3] | [SECTEUR] | [DESCRIPTION] | [DURÉE] | [MONTANT] € |

> [Joindre les attestations de bonne exécution si disponibles]

---

## 10. Démarche qualité et amélioration continue

> [Décrire votre démarche qualité : revues de code, tests automatisés,
> retrospectives, veille sécuritaire, plan d'amélioration continue]

---

## 11. Annexes

- [ ] CV des intervenants proposés
- [ ] Attestations de bonne exécution
- [ ] Certifications (ISO, etc.)
- [ ] Exemples de livrables (reporting, PV de recette)
"""


def create_response_template_acte_engagement(notice: dict[str, Any]) -> str:
    """Template Acte d'Engagement."""
    objet = notice.get("objet", "[OBJET DU MARCHÉ]")
    acheteur = notice.get("nomacheteur", "[ACHETEUR]")
    idweb = notice.get("idweb", "[REF]")

    return f"""# Acte d'Engagement

---

## Marché public de services — TMA

| Champ | Valeur |
|-------|--------|
| **Objet** | {objet} |
| **Référence BOAMP** | {idweb} |
| **Pouvoir adjudicateur** | {acheteur} |

---

## 1. Identification du titulaire

| Champ | Valeur |
|-------|-------|
| **Raison sociale** | {E['raison_sociale']} |
| **SIRET** | {E['siret']} |
| **N° TVA** | {E['tva_intra']} |
| **Adresse du siège** | {E['adresse']}, {E['code_postal']} {E['ville']} |
| **Représentant légal** | {E['representant_prenom']} {E['representant_nom']}, {E['representant_qualite']} |
| **Téléphone** | {E['telephone']} |
| **Email** | {E['email']} |

## 2. Objet de l'engagement

Le titulaire s'engage à exécuter les prestations définies dans le
Cahier des Clauses Techniques Particulières (CCTP) et le Cahier des
Clauses Administratives Particulières (CCAP).

### Lot(s) concerné(s)

| Lot | Intitulé | Montant HT | TVA | Montant TTC |
|-----|----------|-----------|-----|-------------|
| [N°] | [INTITULÉ] | [MONTANT] € | [TAUX]% | [MONTANT] € |

### Montant total

| | Montant |
|---|---------|
| **Total HT** | [MONTANT] € |
| **TVA** | [MONTANT] € |
| **Total TTC** | [MONTANT] € |

## 3. Durée du marché

| | |
|---|---|
| **Durée initiale** | [DURÉE] |
| **Reconductions** | [NOMBRE] reconduction(s) de [DURÉE] |
| **Durée maximale** | [DURÉE TOTALE] |

## 4. Conditions d'exécution

- **Délai de démarrage :** [DÉLAI] après notification
- **Lieu d'exécution :** [LIEU]
- **Modalités de paiement :** [30/45/60] jours à compter de la réception de la facture
- **Avance :** [OUI/NON — montant si applicable]

## 5. Compte bancaire

| Champ | Valeur |
|-------|-------|
| **Titulaire du compte** | {E['raison_sociale']} |
| **Banque** | {E['banque_etablissement']} |
| **IBAN** | {E['banque_iban']} |
| **BIC** | {E['banque_bic']} |

## 6. Signature

Le titulaire affirme que les renseignements fournis sont exacts et
s'engage à exécuter les prestations conformément aux pièces du marché.

| | |
|---|---|
| **Fait à** | {E['ville']}, le [DATE] |
| **Le représentant légal** | {E['representant_prenom']} {E['representant_nom']}, {E['representant_qualite']} |
| **Signature et cachet** | |
"""


def create_response_template_bordereau(notice: dict[str, Any]) -> str:
    """Template Bordereau des Prix / DPGF."""
    objet = notice.get("objet", "[OBJET DU MARCHÉ]")

    return f"""# Bordereau des Prix — DPGF

## {objet}

---

> **Note :** Ce bordereau est un template générique pour une prestation TMA.
> Adaptez-le au BPU/DPGF fourni dans le DCE si un modèle est imposé.

## 1. Forfait de base — Maintenance courante

| Réf. | Désignation | Unité | Qté estimée | PU HT (€) | Total HT (€) |
|------|-------------|-------|-------------|-----------|--------------|
| F01 | Maintenance corrective | Forfait/mois | 12 | [PU] | [TOTAL] |
| F02 | Maintenance évolutive | Jours/homme | [QTÉ] | [PU] | [TOTAL] |
| F03 | Maintenance préventive | Forfait/mois | 12 | [PU] | [TOTAL] |
| F04 | Support utilisateur N2/N3 | Forfait/mois | 12 | [PU] | [TOTAL] |

## 2. Prestations unitaires

| Réf. | Désignation | Profil | PU HT (€/jour) |
|------|-------------|--------|-----------------|
| P01 | Directeur de projet | Senior | [PU] |
| P02 | Chef de projet TMA | Confirmé | [PU] |
| P03 | Architecte technique | Senior | [PU] |
| P04 | Développeur senior | Senior | [PU] |
| P05 | Développeur | Confirmé | [PU] |
| P06 | Développeur junior | Junior | [PU] |
| P07 | Testeur / QA | Confirmé | [PU] |
| P08 | Analyste fonctionnel | Confirmé | [PU] |

## 3. Prestations complémentaires

| Réf. | Désignation | Unité | PU HT (€) |
|------|-------------|-------|-----------|
| C01 | Astreinte heures ouvrées | Forfait/mois | [PU] |
| C02 | Astreinte heures non ouvrées (HNO) | Forfait/mois | [PU] |
| C03 | Intervention urgente HNO | Heure | [PU] |
| C04 | Formation / transfert de compétences | Jour | [PU] |
| C05 | Audit de code / sécurité | Forfait | [PU] |

## 4. Phase de transition

| Réf. | Désignation | Unité | Qté | PU HT (€) | Total HT (€) |
|------|-------------|-------|-----|-----------|--------------|
| T01 | Reprise documentaire | Jour | [QTÉ] | [PU] | [TOTAL] |
| T02 | Transfert de connaissances | Jour | [QTÉ] | [PU] | [TOTAL] |
| T03 | Tuilage avec prestataire sortant | Jour | [QTÉ] | [PU] | [TOTAL] |

## 5. Récapitulatif

| Poste | Montant HT (€) |
|-------|----------------|
| Forfait de base (annuel) | [TOTAL] |
| Prestations unitaires (estimé) | [TOTAL] |
| Prestations complémentaires | [TOTAL] |
| Phase de transition | [TOTAL] |
| **TOTAL GÉNÉRAL HT** | **[TOTAL]** |
| TVA (20%) | [TVA] |
| **TOTAL TTC** | **[TOTAL]** |
"""


def create_response_template_planning(notice: dict[str, Any]) -> str:
    """Template Planning d'exécution."""
    return """# Planning Prévisionnel d'Exécution

---

## 1. Phase de transition (Mois 1 à 3)

| Semaine | Activité | Livrables |
|---------|----------|-----------|
| S1-S2 | Kick-off, cadrage, accès environnements | PV de kick-off, plan de transition |
| S3-S4 | Reprise documentaire, analyse du patrimoine | Cartographie applicative |
| S5-S8 | Shadowing avec prestataire sortant | Fiches de transfert |
| S9-S10 | Montée en compétence autonome | Tests de validation |
| S11-S12 | Run accompagné, traitement premiers tickets | Rapport de transition |

## 2. Phase de run (TMA régulière)

### Cycle mensuel type

| Période | Activité |
|---------|----------|
| Semaine 1 | Comité de suivi mensuel, bilan M-1, priorisation |
| Semaine 1-4 | Traitement tickets correctifs (continu) |
| Semaine 1-3 | Développement évolutions planifiées |
| Semaine 3-4 | Tests, recette, préparation MEP |
| Semaine 4 | Mise en production, VSR |

### Cycle trimestriel

| Mois | Activité |
|------|----------|
| M+3, M+6, M+9, M+12 | Comité de pilotage trimestriel |
| M+6 | Revue mi-parcours, ajustement SLA |
| M+12 | Bilan annuel, proposition d'amélioration |

## 3. Jalons clés

| Jalon | Date prévisionnelle | Condition de validation |
|-------|--------------------|-----------------------|
| Notification du marché | [DATE] | Signature AE |
| Kick-off | [DATE] | PV signé |
| Fin de transition | [DATE] | PV de réception transition |
| Première MEP autonome | [DATE] | VSR validée |
| Comité pilotage T1 | [DATE] | Rapport d'activité |
| Revue annuelle | [DATE] | Bilan + plan amélioration |

"""


def create_response_template_references(notice: dict[str, Any]) -> str:
    """Template références clients."""
    return """# Références Clients

---

> Présentez 3 à 5 références de marchés similaires (TMA, développement, formation, IA).

## Référence 1

| Champ | Détail |
|-------|--------|
| **Client** | [NOM DE L'ORGANISME] |
| **Secteur** | [SECTEUR] |
| **Objet du marché** | [DESCRIPTION DE LA PRESTATION] |
| **Période** | [DATE DÉBUT] — [DATE FIN ou en cours] |
| **Montant** | [MONTANT] € HT |
| **Périmètre applicatif** | [APPLICATIONS MAINTENUES] |
| **Technologies** | [STACK TECHNIQUE] |
| **Taille de l'équipe** | [NOMBRE] personnes |

### Description de la mission
> [Décrire le contexte, les enjeux, et les résultats obtenus.
> Insister sur la similitude avec le marché visé.]

### Résultats / indicateurs
- [Taux de disponibilité atteint : XX%]
- [Nombre de tickets traités / an : XXX]
- [Satisfaction client : X/5]

### Contact référent
| | |
|---|---|
| **Nom** | [NOM, PRÉNOM] |
| **Fonction** | [FONCTION] |
| **Email** | [EMAIL] |
| **Téléphone** | [TÉLÉPHONE] |

---

## Référence 2

| Champ | Détail |
|-------|--------|
| **Client** | [NOM] |
| **Secteur** | [SECTEUR] |
| **Objet** | [DESCRIPTION] |
| **Période** | [DATES] |
| **Montant** | [MONTANT] € HT |

### Description
> [...]

---

## Référence 3

| Champ | Détail |
|-------|--------|
| **Client** | [NOM] |
| **Secteur** | [SECTEUR] |
| **Objet** | [DESCRIPTION] |
| **Période** | [DATES] |
| **Montant** | [MONTANT] € HT |

### Description
> [...]

---

> **Conseil :** Joignez les attestations de bonne exécution signées
> par les clients lorsqu'elles sont disponibles.
"""


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------


def process_notice(
    notice: dict[str, Any],
    place_client: Optional[PlaceClient] = None,
) -> Path:
    """Process a single notice: create directory structure and all files."""
    idweb = notice.get("idweb", "unknown")
    objet = notice.get("objet", "Sans titre")
    dirname = f"{sanitize_dirname(idweb)}_{sanitize_dirname(objet)}"
    offer_dir = OFFRES_DIR / dirname

    offer_dir.mkdir(parents=True, exist_ok=True)
    offer_type = classify_offer(notice)
    log.info("  Type d'offre: %s", offer_type)
    (offer_dir / "documents").mkdir(exist_ok=True)
    (offer_dir / "reponse").mkdir(exist_ok=True)

    # Parse structured data from XML
    parsed = parse_donnees_xml(notice.get("donnees"))

    # 1. Main offer markdown
    md_content = create_offer_markdown(notice, parsed)
    (offer_dir / "offre.md").write_text(md_content, encoding="utf-8")

    # 2. Fetch and save HTML content
    try:
        html_full, html_synthese = fetch_notice_html(idweb)
        if html_full:
            (offer_dir / "avis_complet.html").write_text(html_full, encoding="utf-8")
        if html_synthese:
            (offer_dir / "synthese.html").write_text(html_synthese, encoding="utf-8")
    except requests.RequestException as exc:
        log.warning("Impossible de récupérer le HTML pour %s: %s", idweb, exc)

    # 3. Try to fetch DCE from PLACE
    docs_dir = offer_dir / "documents"
    if place_client:
        try:
            fetch_dce_for_notice(place_client, notice, docs_dir)
        except Exception as exc:
            log.warning("Erreur récupération DCE pour %s: %s", idweb, exc)

    # 4. Documents directory with download instructions (fallback README)
    docs_readme = create_documents_readme(notice, parsed)
    (docs_dir / "README.md").write_text(docs_readme, encoding="utf-8")

    # 5. Generate Word/Excel documents (official formats)
    docx_generators = {
        "01_DC1_Fenrir_IT.docx": lambda n, p: generate_dc1(n, p),
        "02_DC2_Fenrir_IT.docx": lambda n, p: generate_dc2(n, p),
        "03_Memoire_Technique_Fenrir_IT.docx": lambda n, p: generate_memoire(n, p, offer_type),
        "04_Acte_Engagement_Fenrir_IT.docx": lambda n, p: generate_ae(n, p),
        "05_DPGF_Fenrir_IT.xlsx": lambda n, p: generate_dpgf(n, p, offer_type),
    }
    for filename, generator in docx_generators.items():
        try:
            generator(notice, offer_dir / "reponse" / filename)
        except Exception as exc:
            log.warning("Erreur génération %s pour %s: %s", filename, idweb, exc)

    # 6. Response templates (markdown — planning & références)
    templates = {
        "06_planning_execution.md": create_response_template_planning,
        "07_references_clients.md": create_response_template_references,
    }
    for filename, generator in templates.items():
        content = generator(notice)
        (offer_dir / "reponse" / filename).write_text(content, encoding="utf-8")

    # 6. Save raw donnees for reference
    donnees = notice.get("donnees")
    if donnees:
        (offer_dir / "donnees_brutes.xml").write_text(donnees, encoding="utf-8")

    log.info("✓ %s — %s", idweb, objet[:60])
    return offer_dir


def run() -> None:
    """Main entry point: search, deduplicate, process."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    OFFRES_DIR.mkdir(parents=True, exist_ok=True)

    registry = load_registry()

    # Initialize PLACE client for DCE download
    place = PlaceClient()
    place.authenticate()  # Will log warning if credentials missing

    # Initialize Google Drive client (optional)
    # Initialize GitHub publisher
    try:
        from git_publisher import init_repo, publish_offer
        init_repo()
        github_enabled = True
        log.info("GitHub connecté — publication activée")
    except Exception as exc:
        github_enabled = False
        log.info("GitHub non disponible — publication désactivée (%s)", exc)

    log.info("=== BOAMP Scraper — Services Web (TMA, Dev, Formation, IA) ===")
    try:
        notices = search_notices(limit=MAX_RESULTS + 10)  # fetch extra to handle dedup
    except requests.RequestException as exc:
        log.error("Erreur API BOAMP: %s", exc)
        sys.exit(1)

    processed = 0
    for notice in notices:
        if processed >= MAX_RESULTS:
            break

        idweb = notice.get("idweb")
        if not idweb:
            continue

        if is_seen(registry, idweb):
            log.info("⏭ Déjà traité: %s", idweb)
            continue

        try:
            offer_dir = process_notice(notice, place_client=place)

            # Publish to GitHub
            if github_enabled:
                try:
                    publish_offer(offer_dir)
                except Exception as exc:
                    log.warning("Échec publication GitHub pour %s: %s", idweb, exc)

            mark_seen(registry, idweb, notice.get("objet", ""), classify_offer(notice))
            save_registry(registry)
            processed += 1
        except Exception:
            log.exception("Erreur lors du traitement de %s", idweb)

    log.info("=== Terminé: %d nouvelles offres traitées ===", processed)


if __name__ == "__main__":
    run()
