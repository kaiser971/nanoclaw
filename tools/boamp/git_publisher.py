"""Publie les dossiers d'offres sur un repo GitHub privé.

Chaque offre est commitée et poussée automatiquement.
Le repo sert de stockage versionné et interrogeable via API.

Setup (une seule fois) :
    Le repo est cloné automatiquement au premier lancement.
    Nécessite un accès SSH ou HTTPS à GitHub (gh auth / ssh key).
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path
from typing import Optional

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


def publish_offer(offer_dir: Path) -> bool:
    """Copy an offer directory to the repo and push.

    Structure in repo:
        fenrir-ao/
        ├── README.md
        └── {offer_name}/
            ├── offre.md
            ├── documents/
            └── reponse/

    Returns True if new changes were pushed.
    """
    _ensure_repo()

    offer_name = offer_dir.name
    dest = REPO_DIR / offer_name

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
            "Dossiers de réponse aux marchés publics TMA / Éducation.\n\n"
            "Généré automatiquement par le scraper BOAMP.\n\n"
            "## Structure\n\n"
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
