"""Client pour la plateforme PLACE (marches-publics.gouv.fr).

Recherche les consultations correspondant aux avis BOAMP et télécharge
les documents de consultation (DCE) via l'API REST v2 + session web.

L'API v2 sert à chercher et lister les fichiers.
La session web (login + cookies) sert à télécharger les pièces
accessibles directement (RC, annexes). Le DCE complet (ZIP) passe
par le système Utah (applet Java) qui ne peut pas être automatisé ;
dans ce cas, le lien direct vers la consultation est fourni.

Authentification :
    Variables d'environnement PLACE_LOGIN et PLACE_PASSWORD.
    Compte gratuit à créer sur https://www.marches-publics.gouv.fr
"""

from __future__ import annotations

import base64
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Optional

import requests

log = logging.getLogger(__name__)

PLACE_BASE = "https://www.marches-publics.gouv.fr"
API_BASE = f"{PLACE_BASE}/api/v2"


class PlaceClient:
    """Client pour PLACE — combine API v2 (recherche) et session web (download)."""

    def __init__(self) -> None:
        # API session (for search + file listing)
        self._api = requests.Session()
        self._api.headers["Accept"] = "application/ld+json"

        # Web session (for downloads)
        self._web = requests.Session()

        self._login = os.environ.get("PLACE_LOGIN", "")
        self._password = os.environ.get("PLACE_PASSWORD", "")
        self._web_logged_in = False

    @property
    def authenticated(self) -> bool:
        return self._web_logged_in

    def authenticate(self) -> bool:
        """Login via web form (cookie-based). Returns True on success."""
        if not self._login or not self._password:
            log.warning(
                "PLACE_LOGIN / PLACE_PASSWORD non définis — "
                "téléchargement DCE désactivé. "
                "Créez un compte gratuit sur %s",
                PLACE_BASE,
            )
            return False

        try:
            # Get CSRF token
            r = self._web.get(
                f"{PLACE_BASE}/index.php/entreprise/login", timeout=15
            )
            csrf_match = re.search(
                r'name="_csrf_token"[^>]*value="([^"]+)"', r.text
            )
            csrf = csrf_match.group(1) if csrf_match else ""

            # Submit login form
            r2 = self._web.post(
                f"{PLACE_BASE}/index.php/entreprise/login",
                data={
                    "_username": self._login,
                    "_password": self._password,
                    "_csrf_token": csrf,
                },
                timeout=15,
                allow_redirects=True,
            )

            # Check if login succeeded (redirects to /entreprise, not back to login)
            if "login" not in r2.url and r2.status_code == 200:
                self._web_logged_in = True
                log.info("Authentification PLACE réussie (session web)")
                return True

            log.error("Échec login PLACE — vérifiez vos identifiants")
            return False
        except requests.RequestException as exc:
            log.error("Échec authentification PLACE: %s", exc)
            return False

    # -----------------------------------------------------------------
    # Search (API v2 — no auth required)
    # -----------------------------------------------------------------

    def search_consultation(
        self,
        objet: str,
        acheteur: str = "",
    ) -> Optional[dict[str, Any]]:
        """Find a consultation matching a BOAMP notice."""
        skip = {
            "de", "du", "des", "la", "le", "les", "et", "en", "à", "au",
            "aux", "un", "une", "pour", "sur", "par", "dans", "d", "l",
        }
        words = [w for w in re.findall(r"\w{2,}", objet) if w.lower() not in skip]
        key_terms = " ".join(words[:6])

        candidates = self._search(key_terms)

        if not candidates and len(words) > 3:
            candidates = self._search(" ".join(words[:3]))

        if not candidates and acheteur:
            buyer_words = [
                w for w in re.findall(r"\w{3,}", acheteur)
                if w.lower() not in skip
            ][:2]
            candidates = self._search(" ".join(words[:3] + buyer_words))

        if not candidates:
            return None

        return self._best_match(candidates, objet)

    def _search(self, query: str) -> list[dict[str, Any]]:
        """Search PLACE API (works without auth)."""
        try:
            resp = self._api.get(
                f"{API_BASE}/consultations",
                params={"search_full[]": query, "page": 1, "itemsPerPage": 10},
                timeout=15,
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("hydra:member", [])
        except requests.RequestException as exc:
            log.debug("Recherche PLACE échouée pour '%s': %s", query[:40], exc)
            return []

    @staticmethod
    def _best_match(
        candidates: list[dict[str, Any]],
        objet: str,
    ) -> Optional[dict[str, Any]]:
        """Pick the best candidate by word-overlap score (threshold ≥ 4)."""
        objet_words = set(re.findall(r"\w{4,}", objet.lower()))
        best_score = 0
        best = None

        for c in candidates:
            place_text = " ".join(
                (c.get(k) or "") for k in ("objet", "intitule", "reference")
            ).lower()
            place_words = set(re.findall(r"\w{4,}", place_text))
            score = len(objet_words & place_words)
            if score > best_score:
                best_score = score
                best = c

        return best if best_score >= 4 else None

    # -----------------------------------------------------------------
    # DCE listing (API v2) & download (web session)
    # -----------------------------------------------------------------

    def list_dce_files(self, consultation_id: str) -> list[dict[str, Any]]:
        """List DCE files for a consultation (no auth needed)."""
        try:
            resp = self._api.get(
                f"{API_BASE}/consultations/{consultation_id}/dce",
                timeout=15,
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("hydra:member", [])
        except requests.RequestException as exc:
            log.debug("Impossible de lister DCE pour %s: %s", consultation_id, exc)
            return []

    def _get_org_acronyme(self, consultation_id: str) -> str:
        """Resolve the organisme acronyme for a consultation."""
        try:
            resp = self._api.get(
                f"{API_BASE}/consultations/{consultation_id}",
                timeout=15,
            )
            resp.raise_for_status()
            data = resp.json()
            org_ref = data.get("organisme", "")
            if isinstance(org_ref, str) and "/" in org_ref:
                return org_ref.rstrip("/").split("/")[-1]
        except requests.RequestException:
            pass
        return ""

    def download_dce_for_consultation(
        self,
        consultation_id: str,
        dest_dir: Path,
    ) -> list[str]:
        """Download accessible DCE pieces via web session.

        Returns list of downloaded filenames.
        """
        if not self._web_logged_in:
            return []

        dest_dir.mkdir(parents=True, exist_ok=True)
        downloaded: list[str] = []

        org = self._get_org_acronyme(consultation_id)
        b64_id = base64.b64encode(str(consultation_id).encode()).decode()

        # 1. Download RC (Règlement de Consultation) — direct link
        rc_url = (
            f"{PLACE_BASE}/index.php"
            f"?page=Entreprise.EntrepriseDownloadReglement"
            f"&id={b64_id}&orgAcronyme={org}"
        )
        try:
            r = self._web.get(rc_url, timeout=30)
            ct = r.headers.get("content-type", "")
            if r.status_code == 200 and ("octet-stream" in ct or "pdf" in ct):
                disp = r.headers.get("content-disposition", "")
                fname_match = re.search(r'filename="?([^";\n]+)', disp)
                fname = fname_match.group(1).strip() if fname_match else "reglement_consultation.pdf"
                path = dest_dir / fname
                path.write_bytes(r.content)
                downloaded.append(fname)
                log.info("  Téléchargé: %s (%d Ko)", fname, len(r.content) // 1024)
        except requests.RequestException as exc:
            log.debug("Échec téléchargement RC: %s", exc)

        # 2. Navigate consultation page for other direct download links
        try:
            page = self._web.get(
                f"{PLACE_BASE}/entreprise/consultation/{consultation_id}"
                f"?orgAcronyme={org}",
                timeout=15,
            )
            # Find EntrepriseDownload* links
            dl_links = re.findall(
                r'href="(/index\.php\?page=Entreprise\.Entreprise(?:Download|Piece)[^"]+)"',
                page.text,
            )
            for link in dl_links:
                link_clean = link.replace("&amp;", "&")
                # Skip if it's the same RC link
                if "DownloadReglement" in link_clean:
                    continue
                try:
                    r2 = self._web.get(f"{PLACE_BASE}{link_clean}", timeout=30)
                    ct2 = r2.headers.get("content-type", "")
                    if r2.status_code == 200 and (
                        "octet-stream" in ct2 or "pdf" in ct2 or "zip" in ct2
                    ):
                        disp2 = r2.headers.get("content-disposition", "")
                        fm2 = re.search(r'filename="?([^";\n]+)', disp2)
                        fname2 = fm2.group(1).strip() if fm2 else f"document_{len(downloaded)}"
                        path2 = dest_dir / fname2
                        if not path2.exists():
                            path2.write_bytes(r2.content)
                            downloaded.append(fname2)
                            log.info("  Téléchargé: %s (%d Ko)", fname2, len(r2.content) // 1024)
                    time.sleep(0.3)
                except requests.RequestException:
                    pass
        except requests.RequestException as exc:
            log.debug("Échec navigation consultation: %s", exc)

        return downloaded

    def save_dce_metadata(
        self,
        consultation_id: str,
        dest_dir: Path,
        downloaded_files: Optional[list[str]] = None,
    ) -> None:
        """Save DCE file listing and download status as markdown."""
        files = self.list_dce_files(consultation_id)
        if not files:
            return

        dest_dir.mkdir(parents=True, exist_ok=True)
        downloaded_files = downloaded_files or []
        consultation_url = f"{PLACE_BASE}/entreprise/consultation/{consultation_id}"

        lines = [
            "# Fichiers DCE disponibles",
            "",
            f"**Consultation PLACE :** [{consultation_id}]({consultation_url})",
            "",
            "| Fichier | Taille | Type | Téléchargé |",
            "|---------|--------|------|:----------:|",
        ]

        for f in files:
            name = f.get("name") or f.get("fileName") or f.get("nom") or "?"
            size = f.get("taille") or f.get("size") or "?"
            ftype = f.get("type") or f.get("contentType") or "?"
            try:
                size_num = int(size)
                if size_num > 1024 * 1024:
                    size_str = f"{size_num / (1024 * 1024):.1f} Mo"
                elif size_num > 1024:
                    size_str = f"{size_num / 1024:.0f} Ko"
                else:
                    size_str = f"{size_num} octets"
            except (ValueError, TypeError):
                size_str = str(size)

            # Check if this file was downloaded (fuzzy match on name)
            is_dl = any(name.lower() in dl.lower() or dl.lower() in name.lower()
                        for dl in downloaded_files)
            status = "oui" if is_dl else "non"
            lines.append(f"| {name} | {size_str} | {ftype} | {status} |")

        if not all(
            any(name.lower() in dl.lower() or dl.lower() in name.lower()
                for dl in downloaded_files)
            for f in files
            if (name := f.get("name") or f.get("fileName") or "")
        ):
            lines += [
                "",
                "---",
                "",
                "## Téléchargement manuel du DCE complet",
                "",
                "Le DCE complet (ZIP) utilise le système Utah de PLACE",
                "qui nécessite un navigateur. Pour le télécharger :",
                "",
                f"1. Aller sur [{consultation_url}]({consultation_url})",
                '2. Cliquer sur « Télécharger le DCE »',
                "3. Choisir le téléchargement identifié ou anonyme",
                "4. Placer les fichiers dans ce dossier",
            ]

        (dest_dir / "FICHIERS_DCE.md").write_text("\n".join(lines), encoding="utf-8")


def fetch_dce_for_notice(
    client: PlaceClient,
    notice: dict,
    docs_dir: Path,
) -> None:
    """Try to find and download DCE for a BOAMP notice."""
    objet = notice.get("objet", "")
    acheteur = notice.get("nomacheteur", "")
    idweb = notice.get("idweb", "")

    log.info("  Recherche DCE sur PLACE pour %s…", idweb)

    consultation = client.search_consultation(objet, acheteur)
    if not consultation:
        log.info("  → Consultation non trouvée sur PLACE")
        return

    consultation_id = (
        consultation.get("id")
        or consultation.get("@id", "").split("/")[-1]
    )
    if not consultation_id:
        return

    title = consultation.get("objet") or consultation.get("intitule") or ""
    log.info("  → Trouvée sur PLACE: %s (id=%s)", title[:50], consultation_id)

    # Download accessible files
    downloaded: list[str] = []
    if client.authenticated:
        downloaded = client.download_dce_for_consultation(consultation_id, docs_dir)
        if downloaded:
            log.info("  → %d fichier(s) téléchargé(s)", len(downloaded))

    # Save file listing with download status
    client.save_dce_metadata(consultation_id, docs_dir, downloaded)
