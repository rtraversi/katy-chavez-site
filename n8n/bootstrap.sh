#!/usr/bin/env bash
# bootstrap.sh — provisions a KCL n8n container on a BSR shared-tenancy VPS.
#
# Assumes the VPS already has:
#   - Docker + Docker Compose installed
#   - traefik-traefik-1 container running on host network (BSR shared Traefik)
#   - Firewall configured to allow 80/443 inbound for Traefik
#
# Usage (on the VPS):
#   sudo bash /opt/kcl-repo/n8n/bootstrap.sh
#
# Idempotent — safe to re-run after edits.

set -euo pipefail

DIR="/opt/kcl-n8n"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash bootstrap.sh" >&2
  exit 1
fi

# ── Docker sanity ──
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Docker not installed. Installing via official convenience script."
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "==> Installing docker-compose-plugin"
  apt-get update -y
  apt-get install -y docker-compose-plugin
fi

# ── Shared-tenancy sanity: BSR Traefik must already be running ──
if ! docker ps --format '{{.Names}}' | grep -q '^traefik-traefik-1$'; then
  echo "WARNING: traefik-traefik-1 is not running on this host." >&2
  echo "  KCL n8n won't be reachable at https://n8n.katychavez.com until Traefik is up." >&2
  echo "  (Continuing anyway — start Traefik, then 'docker compose restart' in $DIR.)" >&2
fi

# ── Stage stack directory ──
mkdir -p "$DIR" "$DIR/forms" "$DIR/jobs"

# n8n container runs as uid 1000 (user "node"). Give it ownership of the
# mounted dirs so Code-node fs.mkdirSync / writeFileSync can persist job
# data. /data/forms is mounted read-only so it can stay root-owned, but
# /data/jobs is read-write.
chown -R 1000:1000 "$DIR/jobs"

# ── docker-compose.yml: copy canonical from repo into stack dir ──
echo "==> Writing $DIR/docker-compose.yml"
cp "$REPO_DIR/docker-compose.yml" "$DIR/docker-compose.yml"

# ── Remove any stale Caddyfile from earlier dedicated-VPS layout ──
if [[ -f "$DIR/Caddyfile" ]]; then
  echo "==> Removing stale Caddyfile (no longer used in shared-tenancy mode)"
  rm "$DIR/Caddyfile"
fi

# ── .env: don't overwrite if user has populated it ──
if [[ ! -f "$DIR/.env" ]]; then
  echo "==> No .env found. Creating placeholder."
  cat > "$DIR/.env" <<'ENV'
N8N_HOST=n8n.katychavez.com
N8N_ENCRYPTION_KEY=
ANTHROPIC_API_KEY=
TELEGRAM_BOT_TOKEN=
CLERK_SECRET_KEY=
CLERK_JWT_ISSUER=https://decent-seahorse-78.clerk.accounts.dev
ENV
  chmod 600 "$DIR/.env"
  echo ""
  echo "================================================================"
  echo "  NEXT STEP: paste your real .env values into $DIR/.env"
  echo "  Run:  sudo nano $DIR/.env"
  echo "  Then: cd $DIR && sudo docker compose up -d"
  echo "================================================================"
  exit 0
fi

# ── Validate .env ──
required=(N8N_HOST N8N_ENCRYPTION_KEY ANTHROPIC_API_KEY TELEGRAM_BOT_TOKEN CLERK_SECRET_KEY CLERK_JWT_ISSUER)
missing=()
for k in "${required[@]}"; do
  if ! grep -q "^${k}=.\+" "$DIR/.env"; then
    missing+=("$k")
  fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "ERROR: $DIR/.env is missing values for: ${missing[*]}" >&2
  echo "Edit $DIR/.env and re-run this script." >&2
  exit 1
fi
chmod 600 "$DIR/.env"

# ── Bring up the stack ──
cd "$DIR"
echo "==> Pulling images"
docker compose pull
echo "==> (Re)starting stack"
docker compose up -d --remove-orphans

echo ""
echo "==> Waiting for n8n to be ready..."
for i in {1..30}; do
  if docker compose logs n8n 2>&1 | grep -q "Editor is now accessible"; then
    break
  fi
  sleep 2
done

echo ""
echo "================================================================"
echo "  KCL n8n container is up. Traefik handles TLS + routing."
echo ""
echo "  Open: https://n8n.katychavez.com  (creates owner account first time)"
echo ""
echo "  Logs:    cd $DIR && sudo docker compose logs -f"
echo "  Stop:    cd $DIR && sudo docker compose down"
echo "  Restart: cd $DIR && sudo docker compose restart"
echo "================================================================"
