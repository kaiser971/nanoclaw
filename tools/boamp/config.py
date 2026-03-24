"""Configuration for BOAMP Web Services scraper (TMA, Dev, Formation, IA)."""

from pathlib import Path


class OfferType:
    TMA = "TMA"
    DEVELOPPEMENT = "DEVELOPPEMENT"
    FORMATION = "FORMATION"
    IA = "IA"


# --- API ---
BASE_URL = "https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets"
DATASET_BOAMP = "boamp"
DATASET_HTML = "boamp-html"

# --- Search ---
MAX_RESULTS = 10

# TMA Web / applicative maintenance (termes spécifiques logiciel)
TMA_TERMS = [
    "tierce maintenance applicative",
    "maintenance applicative",
    "TMA applicative",
    "TMA web",
    "MCO applicatif",
    "MCO logiciel",
    "maintenance logicielle",
]

# Web application development
DEV_TERMS = [
    "développement application web",
    "création application web",
    "création site web",
    "développement site internet",
    "conception application web",
    "réalisation application web",
    "développement logiciel web",
    "refonte site web",
    "refonte application web",
    "développement fullstack",
    "développement frontend",
    "développement backend",
    "application mobile",
    "portail web",
    "intranet",
    "extranet",
]

# Web training / e-learning platforms
FORMATION_TERMS = [
    "formation développement web",
    "formation informatique web",
    "e-learning",
    "plateforme e-learning",
    "plateforme formation en ligne",
    "learning management system",
    "digital learning",
    "création plateforme formation",
    "formation numérique informatique",
    "MOOC",
]

# AI / ML solutions
IA_TERMS = [
    "intelligence artificielle",
    "développement IA",
    "chatbot IA",
    "machine learning",
    "data science",
    "intégration intelligence artificielle",
    "deep learning",
    "traitement automatique du langage naturel",
    "analyse prédictive données",
    "automatisation intelligence artificielle",
    "solution IA",
]

# Combined for WHERE clause
ALL_SEARCH_TERMS = TMA_TERMS + DEV_TERMS + FORMATION_TERMS + IA_TERMS

# Only active calls for tenders
NOTICE_TYPES = ["Avis de marché/", "Avis de marché"]

# --- Paths ---
TOOL_DIR = Path(__file__).parent
DATA_DIR = TOOL_DIR / "data"
OFFRES_DIR = DATA_DIR / "offres"
REGISTRY_FILE = DATA_DIR / "registry.json"

# --- Web ---
BOAMP_NOTICE_URL = "https://www.boamp.fr/pages/avis/?q=idweb:{idweb}"
