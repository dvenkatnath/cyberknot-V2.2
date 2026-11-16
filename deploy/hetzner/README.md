# CyberKnot on the Hetzner server (chat.zetaegis.com)

Server layout (already in place, not managed by this repo):
- WireGuard (UDP 51820): SSH is only reachable through the tunnel at 10.66.66.1.
- Caddy on the host: HTTPS for chat.zetaegis.com -> localhost:8080 (`Caddyfile` here).
- coturn on the host: TURN relay, TCP/UDP 3478, relay ports UDP 49160-49200.
- Docker container `aegis-chat` (127.0.0.1:8080), data in volume `aegis-data`.

Update the app (turn the WireGuard tunnel on first):

    ./scripts/deploy-hetzner.sh

It uploads the code to ~/cyberknot on the server, builds a new image, swaps only the
app container, checks /health, and rolls back to the previous image if the check fails.

Roll back by hand to the previous version:

    ./scripts/rollback-hetzner.sh

Restore point: Hetzner snapshot `v1-before-v2.2` (full server image before the first update).
The old code is still in ~/Aegis-chat-whatsapp on the server and is never touched.

`../hetzner-fullstack/` is a separate all-in-one stack (Caddy + app + coturn in Docker)
for a brand-new server only. Do not run it on this server: ports 80/443/3478 are in use.
