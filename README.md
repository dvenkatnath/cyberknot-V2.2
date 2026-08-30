# Secure Chat — WhatsApp-style Media

Sibling project to [Aegis-chat-multi](../Aegischat-MLS) with **hybrid file transfer**:

| File size | Path | Protocol |
|-----------|------|----------|
| **≤ 20 MB** | Pure P2P (Option A) | WebRTC data channel, 32 KB AES-GCM chunks |
| **> 20 MB** | Encrypted blob relay (Option B) | Client encrypts → HTTPS upload → peer downloads ciphertext |

**Security:** The server stores **encrypted blobs only**. File keys are wrapped per-peer and sent over the existing E2E secure channel (CyberKnot + session keys). Plaintext never touches the server.

## Quick start (local)

```bash
cd server && npm ci && cd ..
./scripts/run-local.sh
# open http://localhost:8080
```

## Environment (Railway)

Same as Aegis-chat-multi, plus optional:

| Variable | Default | Purpose |
|----------|---------|---------|
| `BLOB_TTL_MS` | 72h | Auto-delete encrypted blobs |
| `BLOB_MAX_BYTES` | 500 MB | Max file size |
| `BLOB_MAX_PART_BYTES` | 6 MB | Max upload part size |

Blob files are stored under `DATA_DIR/blobs/` (ephemeral disk on Railway — use a volume for persistence if needed).

## Deploy to Railway

1. Create a **new** Railway project/service (do not reuse Aegis-chat-multi).
2. Connect this repo or run `railway up` from this directory.
3. Set `METERED_APP_NAME`, `METERED_TURN_API_KEY`, `LOG_SECRET`, and generate a public domain.
4. `CORS_ORIGIN` is auto-set from `RAILWAY_PUBLIC_DOMAIN` via `deploy/railway/start.sh`.

## Architecture

```
Small file:  Browser ══WebRTC══► Browser
Large file:  Browser ──encrypt──► Railway blob store ──download──► Browser
             Browser ══P2P (key + blobId only)══► Browser
```

Chat, signaling, and session keys are unchanged from Aegis-chat-multi.
