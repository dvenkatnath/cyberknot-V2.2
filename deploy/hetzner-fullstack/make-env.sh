#!/usr/bin/env bash
# Run once on the server:  DOMAIN=chat.yourdomain.com ACME_EMAIL=you@example.com ./make-env.sh
set -euo pipefail
cd "$(dirname "$0")"
: "${DOMAIN:?Set DOMAIN, e.g. DOMAIN=chat.yourdomain.com}"
: "${ACME_EMAIL:?Set ACME_EMAIL, e.g. ACME_EMAIL=you@example.com}"
if [ -f .env ]; then echo ".env already exists - not overwriting."; exit 1; fi
umask 077
cat > .env <<ENV
DOMAIN=${DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
TURN_SECRET=$(openssl rand -hex 32)
LOG_SECRET=$(openssl rand -hex 32)
ENV
echo "Created .env for ${DOMAIN} with new random secrets."
