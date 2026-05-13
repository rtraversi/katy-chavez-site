#!/usr/bin/env bash
# bootstrap.sh — provisions the KCL n8n stack on a fresh Hostinger Ubuntu/Debian VPS.
#
# Usage (on the VPS, as root):
#   bash bootstrap.sh
#
# Requirements before running:
#   - DNS A record n8n.katychavez.com → this VPS public IP (done)
#   - You'll be prompted to paste .env contents after Docker installs.

set -euo pipefail

DIR="/opt/kcl-n8n"

# Must run as root.
if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash bootstrap.sh" >&2
  exit 1
fi

echo "==> Updating apt"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg lsb-release ufw

# ── Docker install (official convenience script — idempotent) ──
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  curl -fsSL https://get.docker.com | sh
else
  echo "==> Docker already installed: $(docker --version)"
fi

# Compose v2 ships with the Docker repo as a plugin. Verify.
if ! docker compose version >/dev/null 2>&1; then
  echo "==> Installing docker-compose-plugin"
  apt-get install -y docker-compose-plugin
fi

# ── Firewall: open 80 / 443 / 22 ──
echo "==> Configuring firewall"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP (cert renewal)'
ufw allow 443/tcp comment 'HTTPS (n8n)'
ufw --force enable

# ── Create stack directory ──
mkdir -p "$DIR" "$DIR/forms" "$DIR/jobs"
cd "$DIR"

# ── docker-compose.yml ──
echo "==> Writing docker-compose.yml"
cat > docker-compose.yml <<'YAML'
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./jobs:/srv/jobs:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - n8n
    networks:
      - kcl

  n8n:
    image: n8nio/n8n:latest
    restart: unless-stopped
    environment:
      N8N_HOST: ${N8N_HOST}
      N8N_PORT: 5678
      N8N_PROTOCOL: https
      WEBHOOK_URL: https://${N8N_HOST}/
      N8N_EDITOR_BASE_URL: https://${N8N_HOST}/
      N8N_PROXY_HOPS: 1
      N8N_BASIC_AUTH_ACTIVE: "false"
      N8N_PAYLOAD_SIZE_MAX: 100
      EXECUTIONS_DATA_PRUNE: "true"
      EXECUTIONS_DATA_MAX_AGE: 336
      N8N_ENCRYPTION_KEY: ${N8N_ENCRYPTION_KEY}
      GENERIC_TIMEZONE: America/New_York
      TZ: America/New_York
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
      CLERK_SECRET_KEY: ${CLERK_SECRET_KEY}
      CLERK_JWT_ISSUER: ${CLERK_JWT_ISSUER}
    volumes:
      - n8n_data:/home/node/.n8n
      - ./forms:/data/forms:ro
      - ./jobs:/data/jobs
    networks:
      - kcl

volumes:
  n8n_data:
  caddy_data:
  caddy_config:

networks:
  kcl:
    driver: bridge
YAML

# ── Caddyfile ──
echo "==> Writing Caddyfile"
cat > Caddyfile <<'CADDY'
{$N8N_HOST} {
    reverse_proxy n8n:5678

    request_body {
        max_size 100MB
    }

    handle_path /files/* {
        root * /srv/jobs
        file_server browse
    }

    encode zstd gzip

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }
}
CADDY

# ── .env: do not overwrite if user has already populated it ──
if [[ ! -f .env ]]; then
  echo "==> No .env found. Creating placeholder."
  cat > .env <<'ENV'
N8N_HOST=n8n.katychavez.com
N8N_ENCRYPTION_KEY=
ANTHROPIC_API_KEY=
TELEGRAM_BOT_TOKEN=
CLERK_SECRET_KEY=
CLERK_JWT_ISSUER=https://decent-seahorse-78.clerk.accounts.dev
ENV
  chmod 600 .env
  echo ""
  echo "================================================================"
  echo "  NEXT STEP: paste your real .env values into /opt/kcl-n8n/.env"
  echo "  Run:  nano /opt/kcl-n8n/.env"
  echo "  Then: cd /opt/kcl-n8n && docker compose up -d"
  echo "================================================================"
  exit 0
fi

# ── Validate .env has the required keys filled ──
required=(N8N_HOST N8N_ENCRYPTION_KEY ANTHROPIC_API_KEY TELEGRAM_BOT_TOKEN CLERK_SECRET_KEY CLERK_JWT_ISSUER)
missing=()
for k in "${required[@]}"; do
  if ! grep -q "^${k}=.\+" .env; then
    missing+=("$k")
  fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "ERROR: .env is missing values for: ${missing[*]}" >&2
  echo "Edit /opt/kcl-n8n/.env and re-run this script." >&2
  exit 1
fi
chmod 600 .env

# ── Bring up the stack ──
echo "==> Pulling images"
docker compose pull

echo "==> Starting stack"
docker compose up -d

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
echo "  KCL n8n stack is up."
echo ""
echo "  First-time setup: open https://n8n.katychavez.com in a browser"
echo "  and create the owner account."
echo ""
echo "  Stack logs:    docker compose logs -f"
echo "  Stop stack:    docker compose down"
echo "  Restart:       docker compose restart"
echo "================================================================"
