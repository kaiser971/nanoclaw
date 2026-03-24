"""Configuration for BOAMP TMA/Education scraper."""

from pathlib import Path

# --- API ---
BASE_URL = "https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets"
DATASET_BOAMP = "boamp"
DATASET_HTML = "boamp-html"

# --- Search ---
MAX_RESULTS = 10

# Search terms for TMA
TMA_TERMS = [
    "TMA",
    "tierce maintenance applicative",
    "maintenance applicative",
]

# Search terms for education sector
EDUCATION_TERMS = [
    "université",
    "education",
    "enseignement",
    "éducation",
    "académie",
    "rectorat",
    "scolaire",
    "CROUS",
    "CNOUS",
]

# Only active calls for tenders (not results or cancellations)
NOTICE_TYPES = ["Avis de marché/", "Avis de marché"]

# --- Paths ---
TOOL_DIR = Path(__file__).parent
DATA_DIR = TOOL_DIR / "data"
OFFRES_DIR = DATA_DIR / "offres"
REGISTRY_FILE = DATA_DIR / "registry.json"

# --- Web ---
BOAMP_NOTICE_URL = "https://www.boamp.fr/pages/avis/?q=idweb:{idweb}"
