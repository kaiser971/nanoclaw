#!/bin/bash
# Convert DOCX to PDF using LibreOffice.
# Removes floating table anchors (tblpPr) from DOCX before conversion
# to fix LibreOffice headless rendering bug with floating tables.
#
# Usage: convert.sh --outdir <dir> <file.docx>
set -e

DOCX_FILE=""
OUTDIR=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --outdir) OUTDIR="$2"; shift 2 ;;
    *.docx|*.DOCX) DOCX_FILE="$1"; shift ;;
    *) shift ;;
  esac
done

if [[ -z "$DOCX_FILE" ]]; then
  echo "Error: no .docx file specified" >&2
  exit 1
fi

OUTDIR="${OUTDIR:-.}"
TMPFILE="/tmp/convert_$(date +%s%N).docx"

# Remove floating table anchors (tblpPr) from DOCX so LibreOffice
# renders the full table content across pages in headless mode
python3 - "$DOCX_FILE" "$TMPFILE" << 'PYEOF'
import sys
from docx import Document
from docx.oxml.ns import qn

src, dst = sys.argv[1], sys.argv[2]
doc = Document(src)

for table in doc.tables:
    tblPr = table._tbl.find(qn('w:tblPr'))
    if tblPr is not None:
        tblpPr = tblPr.find(qn('w:tblpPr'))
        if tblpPr is not None:
            tblPr.remove(tblpPr)
            print(f"Removed tblpPr from table", file=sys.stderr)

doc.save(dst)
PYEOF

libreoffice --headless --convert-to pdf --outdir "$OUTDIR" "$TMPFILE"

# Rename output from tmp name to match original docx name
TMPBASE=$(basename "$TMPFILE" .docx)
DOCXBASE=$(basename "$DOCX_FILE" .docx)
if [[ -f "$OUTDIR/${TMPBASE}.pdf" ]]; then
  mv "$OUTDIR/${TMPBASE}.pdf" "$OUTDIR/${DOCXBASE}.pdf"
  echo "Output: $OUTDIR/${DOCXBASE}.pdf"
fi

rm -f "$TMPFILE"
