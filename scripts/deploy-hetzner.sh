#!/usr/bin/env bash
# Update CyberKnot on the Hetzner server (reached over the WireGuard tunnel).
# Replaces only the app container. Caddy, coturn and WireGuard are not touched.
# Usage: ./scripts/deploy-hetzner.sh
set -euo pipefail

HOST="${HETZNER_HOST:-10.66.66.1}"
SSH_USER="${HETZNER_USER:-venkat}"
REMOTE_DIR="${HETZNER_DIR:-/home/${SSH_USER}/cyberknot}"
OLD_DIR="${HETZNER_OLD_DIR:-/home/${SSH_USER}/Aegis-chat-whatsapp}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${SSH_USER}@${HOST}"

echo "==> Checking SSH over the WireGuard tunnel"
ssh -o ConnectTimeout=8 -o BatchMode=yes "$TARGET" true || {
  echo "Cannot reach ${TARGET}. Turn on your WireGuard tunnel and try again."; exit 1; }

echo "==> Uploading code to ${TARGET}:${REMOTE_DIR}"
ssh "$TARGET" "mkdir -p '${REMOTE_DIR}'"
rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' --exclude 'backups' --exclude 'dist' \
  --exclude '.env' --exclude 'server/data' --exclude '*.zip' --exclude '*.log' \
  --exclude '.DS_Store' --exclude 'scripts/demo-recorder' --exclude 'deploy/hetzner-fullstack' \
  "$ROOT/" "${TARGET}:${REMOTE_DIR}/"

echo "==> Building and swapping on the server"
ssh "$TARGET" "REMOTE_DIR='${REMOTE_DIR}' OLD_DIR='${OLD_DIR}' bash -s" <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"

# First run: reuse the existing .env from the previous install (never printed).
if [ ! -f .env ]; then
  [ -f "$OLD_DIR/.env" ] || { echo "No .env found in $OLD_DIR"; exit 1; }
  cp "$OLD_DIR/.env" .env
  chmod 600 .env
fi
grep -q '^NODE_ENV=' .env || echo 'NODE_ENV=production' >> .env

run_app() {
  docker run -d --name aegis-chat --restart unless-stopped \
    -p 127.0.0.1:8080:8080 --env-file .env -v aegis-data:/app/data "$1"
}

# Keep what is running now as the rollback image, then build the new one.
docker tag aegis-chat:latest aegis-chat:prev
docker build -t aegis-chat:new .

docker rm -f aegis-chat
run_app aegis-chat:new

ok=0
for _ in $(seq 1 25); do
  if curl -sf http://127.0.0.1:8080/health >/dev/null; then ok=1; break; fi
  sleep 2
done

if [ "$ok" = 1 ]; then
  docker tag aegis-chat:new aegis-chat:latest
  echo "OK: the new version is running and healthy."
  curl -s http://127.0.0.1:8080/health; echo
else
  echo "FAILED the health check - rolling back to the previous version."
  docker logs --tail 40 aegis-chat || true
  docker rm -f aegis-chat
  run_app aegis-chat:prev
  exit 1
fi
REMOTE
echo "==> Done."
