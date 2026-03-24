"""Publie les dossiers d'offres sur un repo GitHub privé.

Chaque offre est commitée et poussée automatiquement.
Les offres expirées sont déplacées dans AO/ARCHIVE/{TYPE}/.

Setup (une seule fois) :
    Le repo est cloné automatiquement au premier lancement.
    Nécessite un accès SSH ou HTTPS à GitHub (gh auth / ssh key).
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)

TOOL_DIR = Path(__file__).parent
REPO_DIR = TOOL_DIR / "data" / "fenrir-ao"
REMOTE_URL = "git@github.com:kaiser971/fenrir-ao.git"


def _run(cmd: list[str], cwd: Optional[Path] = None) -> str:
    """Run a git command and return stdout."""
    result = subprocess.run(
        cmd, cwd=cwd or REPO_DIR,
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        log.debug("git stderr: %s", result.stderr.strip())
    return result.stdout.strip()


def _ensure_repo() -> None:
    """Clone the repo if it doesn't exist, pull if it does."""
    if (REPO_DIR / ".git").exists():
        _run(["git", "pull", "--rebase", "--quiet"])
        return

    REPO_DIR.mkdir(parents=True, exist_ok=True)
    log.info("Clonage du repo fenrir-ao...")
    subprocess.run(
        ["git", "clone", REMOTE_URL, str(REPO_DIR)],
        capture_output=True, text=True, timeout=120,
        check=True,
    )
    # Configure git identity for this repo
    _run(["git", "config", "user.email", "fenririt.gest@gmail.com"])
    _run(["git", "config", "user.name", "Fenrir IT"])
    log.info("Repo cloné dans %s", REPO_DIR)


def publish_offer(offer_dir: Path, offer_type: str = "TMA") -> bool:
    """Copy an offer directory to the repo and push.

    Structure in repo:
        fenrir-ao/
        ├── README.md
        └── AO/
            ├── TMA/
            ├── DEVELOPPEMENT/
            ├── FORMATION/
            └── IA/
                └── {offer_name}/

    Returns True if new changes were pushed.
    """
    _ensure_repo()

    type_dir = REPO_DIR / "AO" / offer_type
    type_dir.mkdir(parents=True, exist_ok=True)

    offer_name = offer_dir.name
    dest = type_dir / offer_name

    # Copy all files (overwrite if exists)
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(offer_dir, dest)

    # Check if there are changes
    _run(["git", "add", "-A"])
    status = _run(["git", "status", "--porcelain"])

    if not status:
        log.debug("Pas de changement pour %s", offer_name)
        return False

    # Commit and push
    _run(["git", "commit", "-m", f"Ajout offre: {offer_name}"])
    _run(["git", "push", "--quiet"])
    log.info("GitHub: offre publiée — %s", offer_name)
    return True


def init_repo() -> None:
    """Initialize the repo with a README if empty."""
    _ensure_repo()

    readme = REPO_DIR / "README.md"
    if not readme.exists():
        readme.write_text(
            "# Fenrir IT — Appels d'offres\n\n"
            "Dossiers de réponse aux marchés publics.\n\n"
            "Généré automatiquement par le scraper BOAMP.\n\n"
            "## Structure\n\n"
            "```\n"
            "AO/\n"
            "├── TMA/              ← Tierce Maintenance Applicative\n"
            "├── DEVELOPPEMENT/    ← Développement web/mobile\n"
            "├── FORMATION/        ← Formation / e-learning\n"
            "├── IA/               ← Intelligence artificielle\n"
            "└── ARCHIVE/          ← Offres dont la date limite est passée\n"
            "    ├── TMA/\n"
            "    ├── DEVELOPPEMENT/\n"
            "    ├── FORMATION/\n"
            "    └── IA/\n"
            "```\n\n"
            "Chaque dossier contient :\n"
            "- `offre.md` — Fiche descriptive de l'offre\n"
            "- `documents/` — DCE téléchargés (RC, CCTP, etc.)\n"
            "- `reponse/` — Dossier de réponse pré-rempli Fenrir IT\n"
            "  - `01_DC1_Fenrir_IT.docx` — Lettre de candidature\n"
            "  - `02_DC2_Fenrir_IT.docx` — Déclaration du candidat\n"
            "  - `03_Memoire_Technique_Fenrir_IT.docx` — Mémoire technique\n"
            "  - `04_Acte_Engagement_Fenrir_IT.docx` — Acte d'engagement\n"
            "  - `05_DPGF_Fenrir_IT.xlsx` — Bordereau des prix\n",
            encoding="utf-8",
        )
        _run(["git", "add", "README.md"])
        _run(["git", "commit", "-m", "Init repo avec README"])
        _run(["git", "push", "--quiet"])
        log.info("GitHub: repo initialisé avec README")


def archive_expired_offers(registry: dict[str, Any]) -> int:
    """Move expired offers from AO/{TYPE}/ to AO/ARCHIVE/{TYPE}/.

    Checks the datelimitereponse stored in the registry.
    Returns the number of offers archived.
    """
    _ensure_repo()

    ao_dir = REPO_DIR / "AO"
    if not ao_dir.exists():
        return 0

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    archived = 0

    for idweb, info in registry.get("seen", {}).items():
        deadline = info.get("datelimitereponse", "")
        if not deadline:
            continue

        # Compare date (deadline format: "2026-04-10T16:00:00+00:00" or "2026-04-10")
        deadline_date = deadline[:10]
        if deadline_date >= today:
            continue  # Still open

        offer_type = info.get("offer_type", "TMA")
        offer_title = info.get("title", "")

        # Find the offer directory in AO/{TYPE}/
        type_dir = ao_dir / offer_type
        if not type_dir.exists():
            continue

        # Match by idweb prefix in directory name
        source = None
        for d in type_dir.iterdir():
            if d.is_dir() and d.name.startswith(idweb.replace("/", "-")):
                source = d
                break

        if not source:
            continue

        # Move to ARCHIVE
        archive_dir = ao_dir / "ARCHIVE" / offer_type
        archive_dir.mkdir(parents=True, exist_ok=True)
        dest = archive_dir / source.name

        if dest.exists():
            continue  # Already archived

        shutil.move(str(source), str(dest))
        archived += 1
        log.info("Archivé: %s → ARCHIVE/%s/", source.name[:50], offer_type)

    if archived > 0:
        _run(["git", "add", "-A"])
        _run(["git", "commit", "-m", f"Archive {archived} offre(s) expirée(s)"])
        _run(["git", "push", "--quiet"])
        log.info("GitHub: %d offre(s) archivée(s)", archived)

    return archived
