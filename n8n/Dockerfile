# KCL n8n custom image — extends the official n8n image with pdf-lib.
#
# pdf-lib is used by:
#   - Phase 3: mail-ingest workflow splits multi-page USCIS mail scans into
#              individual client PDFs.
#   - Phase 2: portal-fill workflow generates filled USCIS AcroForm PDFs.
#
# Build triggered automatically by docker compose up --build.
# Re-run after pulling a new version of this file:
#   sudo docker compose -f /opt/kcl-n8n/docker-compose.yml up --build -d

FROM n8nio/n8n:latest

USER root

# Install pdf-lib globally so Code nodes can require('pdf-lib').
# NODE_FUNCTION_ALLOW_EXTERNAL=pdf-lib in docker-compose.yml gates access.
RUN npm install -g pdf-lib

USER node
