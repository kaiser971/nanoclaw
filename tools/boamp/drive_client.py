"""Client Google Drive pour déposer les dossiers d'appel d'offres.

Utilise OAuth utilisateur pour uploader les fichiers générés
dans le dossier "Appel d'offre" sur Google Drive.

Setup (une seule fois par machine) :
    python3 drive_setup.py
"""

from __future__ import annotations

import json
import logging
import mimetypes
from pathlib import Path
from typing import Any, Optional

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

log = logging.getLogger(__name__)

TOOL_DIR = Path(__file__).parent
TOKEN_FILE = TOOL_DIR / "token.json"
CREDENTIALS_FILE = TOOL_DIR / "oauth_credentials.json"
SCOPES = ["https://www.googleapis.com/auth/drive"]

# Dossier "Appel d'offre" existant sur le Drive (contient CV, exemples)
PARENT_FOLDER_ID = "1C7o0Hj2bdbgpsgUIMQn9La7gTJyKF9oc"
# Sous-dossier pour les appels d'offres scrapés
AO_FOLDER_NAME = "AO"


def _load_credentials() -> Optional[Credentials]:
    """Load and refresh OAuth credentials from token.json."""
    if not TOKEN_FILE.exists():
        return None

    creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)

    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        TOKEN_FILE.write_text(creds.to_json())

    if creds and creds.valid:
        return creds

    return None


class DriveClient:
    """Upload offer response folders to Google Drive via OAuth."""

    def __init__(self) -> None:
        creds = _load_credentials()
        if not creds:
            raise RuntimeError(
                "Drive non configuré. Lancez d'abord : python3 drive_setup.py"
            )
        self._service = build("drive", "v3", credentials=creds)
        self._root_id: Optional[str] = None

    def _find_folder(self, name: str, parent_id: Optional[str] = None) -> Optional[str]:
        """Find a folder by name, optionally under a parent."""
        escaped = name.replace("'", "\\'")
        q = f"name='{escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
        if parent_id:
            q += f" and '{parent_id}' in parents"
        results = (
            self._service.files()
            .list(q=q, spaces="drive", fields="files(id, name)", pageSize=1)
            .execute()
        )
        files = results.get("files", [])
        return files[0]["id"] if files else None

    def _create_folder(self, name: str, parent_id: Optional[str] = None) -> str:
        """Create a folder on Drive, returns its ID."""
        metadata: dict[str, Any] = {
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
        }
        if parent_id:
            metadata["parents"] = [parent_id]
        folder = self._service.files().create(body=metadata, fields="id").execute()
        folder_id = folder["id"]
        log.info("Dossier Drive créé: %s (id=%s)", name, folder_id)
        return folder_id

    def _get_or_create_folder(self, name: str, parent_id: Optional[str] = None) -> str:
        """Get existing folder or create it."""
        existing = self._find_folder(name, parent_id)
        if existing:
            return existing
        return self._create_folder(name, parent_id)

    def get_root_folder(self) -> str:
        """Get or create 'Appel d'offre/AO/' folder."""
        if not self._root_id:
            self._root_id = self._get_or_create_folder(AO_FOLDER_NAME, PARENT_FOLDER_ID)
        return self._root_id

    def _upload_file(self, local_path: Path, parent_id: str) -> str:
        """Upload a single file to Drive. Returns file ID."""
        mime_type = mimetypes.guess_type(str(local_path))[0] or "application/octet-stream"
        metadata: dict[str, Any] = {
            "name": local_path.name,
            "parents": [parent_id],
        }
        media = MediaFileUpload(str(local_path), mimetype=mime_type, resumable=True)
        result = self._service.files().create(
            body=metadata, media_body=media, fields="id",
        ).execute()
        return result["id"]

    def upload_offer_folder(self, offer_dir: Path) -> str:
        """Upload an entire offer directory to Drive.

        Creates:
          Appel d'offre/
            └── {offer_name}/
                ├── offre.md
                ├── documents/
                │   └── ...
                └── reponse/
                    └── ...

        Returns the Drive folder ID of the offer folder.
        """
        root_id = self.get_root_folder()
        offer_name = offer_dir.name
        offer_folder_id = self._get_or_create_folder(offer_name, root_id)

        uploaded = 0
        for item in sorted(offer_dir.rglob("*")):
            if item.is_dir():
                continue
            # Compute relative path and create subfolders as needed
            rel = item.relative_to(offer_dir)
            parent_id = offer_folder_id
            for part in rel.parts[:-1]:
                parent_id = self._get_or_create_folder(part, parent_id)

            # Check if file already exists
            fname = item.name.replace("'", "\\'")
            q = f"name='{fname}' and '{parent_id}' in parents and trashed=false"
            existing = (
                self._service.files()
                .list(q=q, spaces="drive", fields="files(id)", pageSize=1)
                .execute()
                .get("files", [])
            )
            if existing:
                # Update existing file
                mime_type = mimetypes.guess_type(str(item))[0] or "application/octet-stream"
                media = MediaFileUpload(str(item), mimetype=mime_type, resumable=True)
                self._service.files().update(
                    fileId=existing[0]["id"], media_body=media,
                ).execute()
            else:
                self._upload_file(item, parent_id)
            uploaded += 1

        log.info("Drive: %d fichier(s) uploadé(s) dans '%s'", uploaded, offer_name)
        return offer_folder_id
