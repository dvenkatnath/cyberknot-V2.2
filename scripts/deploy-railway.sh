#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_NAME="${RAILWAY_PROJECT:-Aegis-chat-Multi}"
SERVICE_NAME="${RAILWAY_SERVICE:-Aegis-chat-multi}"

cd "$ROOT"

if ! command -v railway >/dev/null 2>&1; then
  echo "ERROR: Railway CLI not installed. See https://docs.railway.com/develop/cli" >&2
  exit 1
fi

if ! railway whoami >/dev/null 2>&1; then
  echo "ERROR: Not logged in. Run: railway login" >&2
  exit 1
fi

if railway status >/dev/null 2>&1; then
  echo "==> Already linked to a Railway project, skipping link"
else
  echo "==> Linking project: ${PROJECT_NAME}"
  railway link --project "$PROJECT_NAME" </dev/null || {
    echo "ERROR: could not link. Run: railway link   (then pick the project) and re-run this script." >&2
    exit 1
  }
fi

echo "==> Setting production variables"
railway variable set NODE_ENV=production --service "$SERVICE_NAME" 2>/dev/null || \
  railway variable set NODE_ENV=production
railway variable set "CORS_ORIGIN=https://\${{RAILWAY_PUBLIC_DOMAIN}}" --service "$SERVICE_NAME" 2>/dev/null || \
  railway variable set "CORS_ORIGIN=https://\${{RAILWAY_PUBLIC_DOMAIN}}"

if ! railway variable list --json 2>/dev/null | grep -q LOG_SECRET; then
  LOG_SECRET="$(openssl rand -hex 32)"
  railway variable set "LOG_SECRET=${LOG_SECRET}" --service "$SERVICE_NAME" 2>/dev/null || \
    railway variable set "LOG_SECRET=${LOG_SECRET}"
fi

echo "==> Deploying to Railway"
railway up --detach -m "Deploy Aegis Secure Chat multi-guest build"

echo "==> Done. Check status: railway status"
