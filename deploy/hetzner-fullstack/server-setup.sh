#!/usr/bin/env bash
# Run once on a fresh Ubuntu/Debian Hetzner server, as root.
set -euo pipefail
apt-get update -y
apt-get install -y ca-certificates curl ufw rsync openssl
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 49160:49200/udp
ufw --force enable
mkdir -p /opt/cyberknot
echo "Server ready. Next: deploy the code from your Mac with scripts/deploy-hetzner.sh"
