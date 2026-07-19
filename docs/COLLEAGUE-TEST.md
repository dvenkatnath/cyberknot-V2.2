# Colleague test guide

Remote testing for **Aegis Secure Chat** on the production server. You only need a browser — no VPN, no Mac mini, no manual copy-paste of Offer/Answer JSON.

## Production URL

```
https://chat.zetaegis.com
```

The app runs on a self-hosted Hetzner VPS. The admin deploys updates; testers always use the URL above.

**Health check (optional):** `https://chat.zetaegis.com/health` should return `{"ok":true,...}`.

---

## Roles

| Person | Role | What they do |
|--------|------|----------------|
| **Host** | Room owner | Creates invite, admits guests from waiting room |
| **Guest(s)** | Joiner(s) | Opens invite link, enters name, waits to be admitted |

Up to **5 guests** can be connected at the same time.

### Browsers

| Platform | Browser | Notes |
|----------|---------|-------|
| Windows / macOS / Linux | **Chrome** or **Firefox** | Recommended |
| iPhone / iPad | **Safari** | Keep tab in foreground during connect |
| Any | Slack / Teams / email in-app browser | **Do not use** — WebRTC will fail |

---

## Before you start

1. Use a **real browser** (Chrome, Firefox, or Safari) — not an embedded app browser.
2. **Turn off consumer VPNs** (NordVPN, corporate full-tunnel VPN, iCloud Private Relay) for the test — they often break WebRTC. Normal home/office Wi‑Fi or mobile data is fine.
3. Share the **guest invite link** only via **Signal, WhatsApp DM, or in person** — not Slack, Teams, or email (those services may prefetch the URL and leak the room secret).
4. Host must open **`https://chat.zetaegis.com`** before creating an invite — not `localhost`.

---

## Step-by-step

### 1 — Host

1. Open **https://chat.zetaegis.com**.
2. Wait until the security panel shows **WASM loaded ✓**.
3. Click **Create Invite**.
4. Copy the **Guest invite link** and send it to the guest(s).
5. Keep this tab **open** — the waiting room runs from the host browser.
6. When a guest appears in **Waiting room**, click **Admit**.

Connection setup is **automatic** after admit (no Offer/Answer JSON to copy).

### 2 — Guest

1. Open the **guest link** from the host (new browser tab or device).
2. Enter your **display name** in the modal → click **Join waiting room**.
3. Wait until the host admits you (`Admitted — connecting automatically…`).
4. Wait for **Secure P2P channel established** in the chat log.

### 3 — Both sides: safety check

Before chat unlocks, **both** host and guest must:

1. Open the **security / peer status panel**.
2. Compare the **6-digit safety code** on both screens (must match).
3. Click **Confirm — codes match** on **each** side.

Chat input stays disabled until this step is done on both sides.

### 4 — Chat and files

1. Send text messages **both ways**.
2. Try a **small file** (e.g. a photo or PDF under 5 MB) — transfers directly peer-to-peer.
3. Optionally try a **large file** (over 20 MB) — uploads as an **encrypted blob** via the server; the guest receives a download link after the host finishes uploading.

| File size | Path |
|-----------|------|
| **≤ 20 MB** | P2P over WebRTC (encrypted) |
| **> 20 MB** | Encrypted blob relay (server never sees plaintext) |

Files over **10 MB** show an amber progress banner during transfer.

### 5 — Multi-guest (optional)

Repeat steps 2–3 for up to **5 guests**. Each guest gets their own safety code with the host. Host messages fan out to all connected guests.

---

## What to verify

| Check | Expected |
|-------|----------|
| Waiting room | Guest name appears on host; admit works |
| P2P channel | Green checks: session key, DTLS fingerprint, P2P channel open |
| Connection path | **Routed via TURN relay** or **Direct P2P** — either is OK |
| Safety code | Same 6 digits on both sides; both confirmed |
| Messages | Delivered both directions |
| Small file | Guest can open/download; content matches |
| Large file (>20 MB) | Upload completes; guest receives via encrypted relay |
| Guest leaves | Host sees `{name} has left.` |
| Idle ~2 min | Messages still send after a quiet period |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Page won't load | Check https://chat.zetaegis.com/health — ask admin if down |
| Guest stuck in waiting room | Host must keep tab open and click **Admit**; host should open the production URL, not localhost |
| "Waiting room: host not online yet" | Host tab closed or asleep — host reopens invite link and guest retries |
| "Signal authentication failed" | Wrong or expired invite link — host creates a new invite (links expire after 24h) |
| Stuck on ICE / "P2P connection failed" | Hard-refresh both tabs (`Ctrl+Shift+R` / `Cmd+Shift+R`); disable VPN; try Wi‑Fi instead of cellular |
| iPhone Safari issues | Keep Safari in foreground; wait up to 30s for TURN relay; confirm safety code on both sides |
| Chat input disabled | Complete **safety code confirm** on both sides; wait for all green checks in security panel |
| Large file fails | Check file under 500 MB; wait for upload progress; stay connected until "Encrypted relay upload complete" |
| Connection drops after idle | Wait for auto-recovery message, or hard-refresh both tabs and reconnect |

---

## What the server does (and does not do)

**The server provides:**

- App pages (HTML + WASM)
- Waiting room signaling (WebSocket relay — opaque blobs only)
- Key transparency log
- TURN credentials (via Metered relay for NAT traversal)
- Encrypted blob storage for large files (ciphertext only)

**The server never sees:**

- Plaintext chat messages
- File contents (only encrypted blobs for large files)
- Session encryption keys or CyberKnot keys

Messages and small files travel **directly between browsers** (or via TURN relay as encrypted WebRTC — the relay cannot read them).

---

## For admins

Deploy and status (VPN/SSH access to Hetzner only):

```bash
ssh venkat@<hetzner-vpn-ip>
cd ~/Aegis-chat-whatsapp
git pull
./deploy.sh
curl -s https://chat.zetaegis.com/health
```

Automated smoke test (from a dev machine):

```bash
E2E_BASE=https://chat.zetaegis.com ./scripts/run-p0-test.sh
```
