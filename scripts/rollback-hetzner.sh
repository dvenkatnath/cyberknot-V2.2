#!/usr/bin/env bash
# Put the previous app image back on the Hetzner server.
set -euo pipefail
HOST="${HETZNER_HOST:-10.66.66.1}"
SSH_USER="${HETZNER_USER:-venkat}"
REMOTE_DIR="${HETZNER_DIR:-/home/${SSH_USER}/cyberknot}"
ssh "${SSH_USER}@${HOST}" "cd '${REMOTE_DIR}' && docker image inspect aegis-chat:prev >/dev/null && \
  docker rm -f aegis-chat && \
  docker run -d --name aegis-chat --restart unless-stopped -p 127.0.0.1:8080:8080 --env-file .env -v aegis-data:/app/data aegis-chat:prev && \
  sleep 4 && curl -s http://127.0.0.1:8080/health && echo && echo 'Rolled back to the previous version.'"
