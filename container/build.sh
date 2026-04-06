#!/bin/bash
# Build the NanoClaw agent container images

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# --- Main agent image (CV generation with python-docx) ---
echo "Building nanoclaw-agent:${TAG}..."
${CONTAINER_RUNTIME} build -t "nanoclaw-agent:${TAG}" .

# --- Scorer image (lightweight, no python-docx) ---
echo ""
echo "Building nanoclaw-scorer:${TAG}..."
${CONTAINER_RUNTIME} build -t "nanoclaw-scorer:${TAG}" -f Dockerfile.scorer .

echo ""
echo "Build complete!"
echo "  nanoclaw-agent:${TAG}   — CV generation (python-docx)"
echo "  nanoclaw-scorer:${TAG}  — Scoring only (no document tools)"
