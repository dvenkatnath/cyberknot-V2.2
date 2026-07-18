#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

echo "Building image..."
docker build -t aegis-chat .

echo "Restarting container..."
docker rm -f aegis-chat 2>/dev/null || true
docker run -d \
  --name aegis-chat \
  --restart unless-stopped \
  -p 8080:8080 \
  --env-file .env \
  -v aegis-data:/app/data \
  aegis-chat

echo "Waiting for app to boot..."
sleep 3
docker logs aegis-chat --tail 20
curl -sf localhost:8080/health && echo
