#!/usr/bin/env python3
"""Setup Google Drive OAuth — à lancer une seule fois par machine.

Ouvre un navigateur pour autoriser l'accès à Google Drive,
puis sauvegarde le token localement.

Usage:
    python3 drive_setup.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

TOOL_DIR = Path(__file__).parent
CREDENTIALS_FILE = TOOL_DIR / "oauth_credentials.json"
TOKEN_FILE = TOOL_DIR / "token.json"


def main() -> None:
    if not CREDENTIALS_FILE.exists():
        print("ERREUR: oauth_credentials.json introuvable.")
        print()
        print("Pour le créer :")
        print("  1. Va sur https://console.cloud.google.com/apis/credentials")
        print("  2. Projet: consortium-drive")
        print("  3. '+ CREATE CREDENTIALS' → 'OAuth client ID'")
        print("  4. Type: 'Desktop app', Nom: 'boamp-scraper'")
        print("  5. Télécharge le JSON et place-le ici :")
        print(f"     {CREDENTIALS_FILE}")
        sys.exit(1)

    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        print("Installation de google-auth-oauthlib...")
        import subprocess
        subprocess.check_call([
            sys.executable, "-m", "pip", "install", "--user",
            "--break-system-packages", "google-auth-oauthlib",
        ])
        from google_auth_oauthlib.flow import InstalledAppFlow

    SCOPES = ["https://www.googleapis.com/auth/drive"]

    flow = InstalledAppFlow.from_client_secrets_file(
        str(CREDENTIALS_FILE), SCOPES,
    )
    creds = flow.run_local_server(port=0)

    TOKEN_FILE.write_text(creds.to_json())
    print()
    print(f"Token sauvegardé dans {TOKEN_FILE}")
    print("L'authentification Drive est configurée.")
    print("Le scraper BOAMP peut maintenant uploader sur Google Drive.")


if __name__ == "__main__":
    main()
