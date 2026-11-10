# Changes in this build — audio/video calling

## Summary

Adds an explicit "Call" button that turns on camera + microphone and
sends audio/video to every currently-connected, safety-number-verified
peer, alongside the existing text chat and file transfer — nothing
starts automatically, and nobody's camera turns on without them
clicking the button. Mute, camera-off, and hang-up controls are
included. This is additive: no cryptographic file, key-exchange
function, or signaling-verification function was changed.

## What changed

- `app-pre.js` — added per-peer state fields (`remoteStream`,
  `senders`, `negotiating`, `ignoreOffer`), call-level globals
  (`localMediaStream`, `callActive`, `micEnabled`, `camEnabled`), and
  `sendRelayRenegotiate()`, a thin wrapper around the existing relay
  send path (mirrors `sendRelayIceCandidate()`).
- `app-post.js` — added the call UI wiring (`getOrCreateVideoTile`,
  `removeVideoTile`, `updateCallButtons`, `ensureLocalMedia`,
  `attachTracksToPeer`, `detachTracksFromPeer`, `bindMediaHandlers`,
  `handleRenegotiateSignal`, and the `callBtn` / `hangupBtn` /
  `muteBtn` / `cameraBtn` click handlers). Added a `case 'renegotiate'`
  branch to the existing relay-message switch. Extended `closePeer()`
  and `closeAllPeers()` to stop media tracks and remove video tiles
  alongside their existing cleanup.
- `server/keyserver.js` — added a `case 'renegotiate'` to the `/ws`
  relay, in the same opaque-forwarding shape as the existing
  `ice-candidate` case: the server relays the payload by connection id
  and does not parse, validate, or log its contents.
- `index.html`, `mobile.html` — added a "Call" button, a video-tile
  grid, and mute/camera/hang-up buttons. Pure markup + CSS; no
  signaling or crypto logic lives in either file.

## How it works, and why it's safe to add here

Adding a camera/mic track to an `RTCPeerConnection` that's already
connected requires renegotiating the SDP (a new offer/answer), which
is what `sendRelayRenegotiate` / `handleRenegotiateSignal` / the new
relay case do. Critically, renegotiation reuses the **same DTLS
transport and certificate** as the original connection — the
fingerprint that was already checked against the safety number at
connect time does not change when tracks are added. So:

- No new key exchange. `establishSessionKey`, `wrapSignal`,
  `parseAndVerifySignal`, and every CyberKnot/WASM call are untouched
  and are never invoked by the call code.
- No new trust decision for the relay server. The new `renegotiate`
  message type is forwarded exactly like `ice-candidate` already is —
  opaque, connection-id-scoped, no parsing.
- Media (SRTP) is encrypted by the same DTLS session whose fingerprint
  the two sides already verified via the safety number. A call started
  after that confirmation inherits it; nothing further to confirm.
- `onnegotiationneeded` is guarded by `peer.sessionKeyReady` so it does
  nothing during the very first (manually-driven) offer/answer, only
  firing for later track add/remove — and uses the standard "perfect
  negotiation" collision rule (guest polite, host impolite) so both
  sides starting a call at the same instant resolve deterministically.

## Known limitation — read before assuming "everyone sees everyone"

This app's topology (unchanged by this update) is a **star through the
host**, not a mesh: a guest only ever holds one peer connection, to the
host, keyed `HOST_PEER_KEY`. Guests never connect directly to each
other — this is exactly why text messages are relayed by the host to
each guest individually, and it applies to calling too:

- The **host** sees and hears every admitted guest's camera/mic (one
  tile per guest).
- Each **guest** sees and hears only the **host's** camera/mic, not
  other guests' — there is no peer connection between guests to carry
  that media, and this update does not add an SFU or any
  decode/re-encode relay to bridge that gap.

If guest-to-guest visibility is wanted, that is materially new
engineering (an SFU, or moving to the mesh/MLS architecture already
flagged as a separate, larger change in prior notes) — out of scope
for this pass, and called out here rather than left implicit.

## What did NOT change — verified, not assumed

Every cryptographic artifact is byte-for-byte identical to the version
before this change:

| Artifact | MD5 |
|---|---|
| `cyberknot.wasm` | `e782ab299f833b969333f1c009f043db` |
| `cyberknot.js` | `0efbb2b2356d91a3ec988666ba4af06e` |
| `src/aes.c` | `5798ad75c7e5709f674939382cb3c9c5` |
| `src/Hmac.c` | `a0f003f1a9016016022650cab8114db2` |
| `src/HmacSha256.c` | `57429a1847f3bf61500079dec0df59ab` |
| `src/SHA256.c` | `89983c55ecfa43e23a47d4215e85102d` |
| `src/EncryptionToolsApi.c` | `39e7dd69a5da6b43aa6bfadbc2392992` |
| `src/CryptoRng.c` | `cc74d55df9480ef89665df1f58419aba` |
| `src/bridge.c` | `743b305d3082e85df9ad1376f33044b3` |

Re-verify yourself: `md5sum cyberknot.wasm cyberknot.js src/*.c` and
compare against the table above (matches the table already recorded in
this project's history for the prior build).

`establishSessionKey`, `wrapSignal`, `parseAndVerifySignal`,
`verifyLiveFingerprint`, `verifyHostKeyTransparency`, and every
`Module._bridge_*` call site are unmodified — grep for them shows the
call sites this update added are all new lines, not edits to existing
ones.

## Testing performed

- `md5sum` of every crypto artifact, before and after, confirmed
  identical (table above).
- `node --check` on `app-pre.js`, `app-post.js`, and
  `server/keyserver.js` — all parse cleanly.
- Started the real server locally (`node server/keyserver.js` against
  a copy of `dist/` with the patched files) and confirmed `index.html`,
  `mobile.html`, `app-pre.js`, and `app-post.js` all serve `200 OK`
  with no server-side errors in the log.
- Confirmed every DOM id the new JS looks up (`call-btn`, `hangup-btn`,
  `mute-btn`, `camera-btn`, `video-call-panel`, `video-grid`) exists
  exactly once in both `index.html` and `mobile.html` — a missing id
  would throw at page-load time (`callBtn.onclick = ...` on `null`)
  and break the whole app, not just calling, so this was checked
  explicitly rather than assumed.
- `git status`/`git diff --stat` confirms only the five intended files
  changed — nothing else was touched.

## What was NOT tested (do this yourself before relying on it)

This sandbox has no browser and cannot open two real tabs against each
other, so the actual `getUserMedia` → `addTrack` → renegotiate →
`ontrack` flow has not been exercised end-to-end with real media. Test
it with real browsers, on both a host tab and at least one guest tab,
before relying on it for anything sensitive — the renegotiation glare
handling (both sides starting a call at once) in particular deserves a
deliberate double-click test, not just the happy path.

## How to test it yourself, end to end

```bash
cd server && npm install --omit=dev && cd ..
./scripts/run-local.sh
```

Open a host tab and at least one guest tab as usual (Create Invite →
Admit → safety number confirm). Once that pair's channel is unlocked,
click **Call** in either tab. The clicking side's camera/mic tile
appears immediately; the other side's video tile appears once its
`ontrack` fires. Try clicking Call on both sides within the same
second, to exercise the renegotiation-collision path. Test Mute,
Camera off, and Hang up on both sides. With a host + 2 guests, confirm
the host sees both guests' video, and that each guest sees only the
host's.

---

# Update — fixing a negotiation-drop bug found in real multi-browser testing

## What was reported

Testing with real browsers on both ends surfaced several call-quality
issues, most explainable by one root cause:

1. Whichever side started a call first only had **audio** reach the
   other side; **video** only started flowing once the other
   participant also clicked Call.
2. When a guest hung up, the host kept hearing the guest's **audio**
   even though the guest's video tile correctly disappeared.
3. On Chrome (desktop), audio worked but video did not display in
   several test runs.

## Root cause

`RTCPeerConnection.addTrack()` (and `removeTrack()`) each schedule a
`negotiationneeded` event. Adding two tracks (audio, then video) back
to back can fire that event twice in quick succession, depending on
the browser's internal coalescing. The old handler did this:

```js
if (!peer.sessionKeyReady || peer.negotiating) return;
```

If a second `negotiationneeded` arrived while the first renegotiation
was still in flight, it was silently **dropped** — not queued, not
retried. Whichever track's add/remove triggered the dropped event
never made it into an offer, so the remote side never learned about
it, until something unrelated (like the other side also starting a
call) happened to trigger a fresh renegotiation that pulled the
missing track in as a byproduct. This exactly matches all three
symptoms above: audio's renegotiation would go out, video's (or vice
versa) would get dropped, and it would only "fix itself" once a later,
unrelated renegotiation swept it up.

## Fix

`app-post.js` / `app-pre.js`: added a `peer.negotiationPending` flag
and a `clearNegotiating(peer)` helper. A `negotiationneeded` that
arrives while one is already in flight now sets that flag instead of
being dropped; `clearNegotiating()` — called everywhere the code used
to just do `peer.negotiating = false` (offer error, answer applied,
answer error) — drains it by starting a fresh renegotiation if one was
requested in the meantime. No cryptographic file touched; verified by
MD5 (unchanged from the table above) and `node --check` on both
patched files.

## Still open — not explained by the fix above, needs real logs to pin down

These were reported in the same test pass but don't fit the
negotiation-drop pattern, since they're about the *initial* connection
or unrelated UI, not calling:

- **iPhone as host, Safari:** guest's name didn't show in the waiting
  room.
- **iPhone as host, Chrome:** host couldn't share the meeting link.
- **Firefox as host:** repeatedly failed to establish a connection at
  all.
- **Chrome as host:** failed 5 of 7 attempts; 9 of 12 failures overall
  involved Chrome.

These look like they may be pre-existing connection/ICE reliability
issues (or, for the iPhone waiting-room/link-share items, unrelated to
calling entirely) rather than something this audio/video patch
introduced — but that's a hypothesis, not a verified diagnosis. Real
diagnosis needs the browser console output (`F12` → Console, or Safari
Web Inspector for iOS) from a failing attempt, since none of this is
reproducible in a sandboxed test environment without two real devices
talking to each other. If you hit these again, capture the console
log from the host tab (and the guest tab, if possible) at the moment
of failure and share it — that will point directly at the failing
step (ICE gathering, signaling, TURN) instead of guessing.

---

# Update — mesh calling: everyone sees and hears everyone (up to ~6)

## What changed

The topology for **audio/video calling** is no longer a star through the
host. Every admitted participant (host and guests alike) now opens a
direct `RTCPeerConnection` with every other admitted participant, so in a
call with a host and two guests, all three now see and hear each other —
not just each guest seeing the host.

Scope, deliberately: **only calling is meshed. Text chat is unchanged** —
it still goes host → each guest (documented in `broadcastToOthers()`),
which was a conscious decision to keep this change reviewable rather than
rewriting the whole app's topology in one pass. Say if you want chat
meshed too; the same connections this update opens would carry it.

- `server/keyserver.js`:
  - `admit`: now also sends the newly-admitted guest a `peer-roster` (who
    else is already in the call) and tells everyone already in the call
    about the new guest (`peer-joined`) — both are just connId/name pairs,
    not signaling content.
  - New `peer-relay` case: opaque forwarding between two **admitted**
    guests, addressed by connId — same trust model as the existing
    `ice-candidate` case (server never parses the payload).
  - A guest disconnecting now also notifies the *other* guests (not just
    the host as before) — reuses the client's existing `peer-left`
    handler unchanged, since it already looked up peers generically.
- `app-pre.js` / `app-post.js`: new guest-to-guest connection functions
  (`initMeshPeer`, `handleMeshOffer`, `handleMeshAnswer`,
  `sendMeshPeerMessage`, `bindMeshIceCandidateHandler`) plus dispatch for
  the three new relay message types.

## Why this doesn't compromise the security posture

Every primitive a guest<->guest connection uses was **already written
generically per-peer**, not hard-coded to "the host" — this update reuses
all of it completely unchanged:

- `wrapSignal` / `parseAndVerifySignal` — the offer/answer exchange
  between two guests is HMAC-signed with the same shared room secret
  every participant already holds, exactly like host<->guest signaling.
  A relay that tampered with it is caught the same way.
- The DTLS fingerprint check and the human-verified safety number — a
  guest now confirms a safety code with each other participant it
  connects to, the same UI and the same manual out-of-band verification
  step host<->guest already required. No pairwise link is trusted without
  it.
- `establishSessionKey`, the WASM per-connId session key slotting, and
  `computeSafetyNumber` — used as-is, keyed by connId exactly like they
  already were for N guests on the host's side.
- The relay server still never decrypts or validates anything it
  forwards for calling; `peer-relay` extends *who* an opaque payload can
  be addressed to, not what the server is trusted to do with it.

Net effect: the "no compromise" story is the same N-independent-verified
links, just with edges between guests too, not a downgrade to a shared or
server-mediated media path.

## Who initiates each connection

Deterministic, so two sides never both start an offer for the same edge:
whichever participant's own connId sorts lower (plain string comparison)
initiates. Both sides compute this independently from the roster/joined
message, so no coordination round-trip is needed before connecting.

## What did NOT change — verified, not assumed

Crypto files unchanged (same MD5s as every prior entry in this file —
`md5sum cyberknot.wasm cyberknot.js src/*.c` to re-check). `node --check`
passes on all three patched files. Server starts and serves the patched
static files with no errors. `git diff --stat` shows only the five
intended files changed.

## What was NOT tested (this needs real devices)

This sandbox cannot open three real browser tabs against each other, so
the actual guest<->guest handshake — offer/answer, ICE, safety-number
confirmation, and calling across a live 3-way mesh — has not been
exercised end to end. Before relying on this:

1. Set up a host + 2 guests as usual (invite → admit both).
2. Confirm each of the 3 pairwise safety numbers (host<->guestA,
   host<->guestB, and the **new** guestA<->guestB).
3. Click Call from any participant; confirm all three see and hear each
   other, not just the two who share a browser tab with the host.
4. Have a guest leave mid-call; confirm their tile disappears for the
   *other guest* too, not just for the host.
5. Try a 3rd guest joining after a call is already active, to exercise
   the "joining an in-progress call" paths in `initMeshPeer` /
   `handleMeshOffer`.

## Known limits of this pass

- Text chat is still host-relayed, not meshed (see Scope above).
- No SFU, no scale beyond a small mesh — bandwidth and CPU cost is
  roughly O(N²), which is why the earlier scoping conversation capped
  this at ~6 participants; beyond that a relay-based (SFU) architecture
  with end-to-end frame encryption would be a separate, materially larger
  build.
- The Firefox-as-host, Chrome-as-host, and iPhone waiting-room/link-share
  issues from the last test round are **not addressed by this update** —
  they're connection-establishment/UI issues unrelated to the mesh
  topology, and still need real browser console logs to diagnose (see the
  note in the previous update above).

---

# Update — security audit fixes 1 to 5

This supersedes two statements earlier in this file: call renegotiation no
longer goes through the relay (the `renegotiate` relay case is removed), and
media is no longer sent as soon as a session key exists.

1. **Key transparency fails closed.** A 404, 501 or network error from the key
   endpoints is only tolerated on a localhost origin. Anywhere else the
   connection is refused. The host now registers its key on every offer, and a
   conflicting host key stops the host with a clear message.
2. **Safety number uses commit/reveal.** The 6-digit code is no longer a plain
   hash of the two public keys. Each side contributes a random nonce over the
   data channel, and the initiator commits to its nonce before seeing the
   other. A party in the middle gets one blind guess (1 in 1,000,000) instead
   of being able to grind keys offline. Confirm is disabled until the code
   exists.
3. **Nothing flows before confirmation.** Camera and mic are only attached to
   peers whose code the user confirmed. Incoming audio/video is not rendered,
   and incoming messages and files are held, until the receiver confirms. The
   participant list from the host is the one exception.
4. **Renegotiation is authenticated.** Offers and answers that add or remove
   media travel over the data channel with an HMAC keyed by that pair's
   session key, the sender's public key, and a sequence number. The SDP must
   keep the DTLS fingerprint verified at connect time.
5. **Sender names cannot be spoofed.** The host labels a message with the name
   of the connection it arrived on. A guest only believes a sender name from
   the host, ignores rosters from anyone else, and drops chat or files
   arriving on a guest-to-guest link.

Crypto files are unchanged (same MD5s as above).

## Tested

Real browsers this time: three headless Chromium tabs (host, two guests) with
a fake camera against the real keyserver on localhost, 24 checks, all passing.
They cover matching codes on all three pairs, held-then-released messages,
spoofed names and rosters, media withheld from an unconfirmed peer, mesh video
guest to guest, hang-up, forged and fingerprint-changing renegotiations, a
mismatched reveal, and the fail-closed key checks.

## Not tested

Firefox, Safari, iPhone, `mobile.html`, file transfer under the new hold
logic, and connections through TURN. ICE candidates still travel over the
relay unsigned, and ICE-restart recovery was not exercised.

## Behaviour changes to expect

- If the server loses its key store (for example a redeploy without a
  volume), the host re-registers its key the next time it admits a guest,
  so this recovers on its own.
- A host who reloads the page must create a new invite.
- Old and new clients cannot be mixed: both ends need this build.

## UI refresh: call controls, logs, notices, branding

**Call and Hang up**
- Call stays greyed out until at least one peer is connected and its safety
  code has been confirmed. The tooltip says why.
- A guest pressing Hang up now leaves the whole conversation (all peer
  connections and the camera/mic are closed, and the guest does not rejoin
  the waiting room automatically). The host and other guests are told.
- Camera off only turns the camera off; audio, chat and the connection
  carry on.
- When the other side stops sending media, the leftover frozen frame is
  removed after the renegotiation.
- The video panel shows whenever there is something in it, so a host can
  see a guest's video without starting a call of their own.

**Logs and notices**
- New "Logs" checkbox next to Reset (in the menu drawer on mobile), off by
  default. Connection and status lines are hidden unless it is ticked.
- Always shown, whether Logs is on or off: "Ready to communicate"
  (guest), "Ready to communicate to <name>" (host), "<name> has left.",
  invite and call errors, content-held notices, host-away and not-admitted
  messages, and security warnings (red).

**Branding**
- Header now shows the CyberKnot icon, the CYBERKNOT wordmark with the
  tagline "Defend signals. Protect networks. Preserve freedom." under it,
  and the connection dot next to the wordmark ("Connected" /
  "Disconnected" on hover). It replaces the old "Secure Chat / Media"
  label. Dark and light themes each get their own artwork.
- New files: `assets/cyberknot-icon-{dark,light}.svg` and
  `assets/cyberknot-wordmark-{dark,light}.png`. They are copied by the
  Dockerfile and `scripts/build.sh`.

**Tested**: 38 checks across three headless Chromium tabs against the real
keyserver, all passing. Not covered: Firefox, Safari, iPhone, and the
mobile page in a real browser.

## Server hardening (before wider use)

- **Real client IPs behind Railway.** `trust proxy` is on in production (one
  hop; override with `TRUST_PROXY_HOPS`). Before this, every user shared the
  proxy's IP and therefore one rate-limit bucket.
- **Security headers** on every response: Content-Security-Policy,
  X-Frame-Options DENY, nosniff, Referrer-Policy no-referrer,
  Permissions-Policy (camera and microphone only for this site),
  Cross-Origin-Resource-Policy, and HSTS on HTTPS in production. The CSP still
  allows inline scripts and styles ('unsafe-inline') because the pages use
  them; moving them into files would let that be tightened.
- **`/api/ice-config`** (TURN credentials): rate-limited per IP (60 per 15
  minutes), refuses cross-site browser requests, never cached, and the Metered
  credential now expires after 48 hours and is re-issued every 12 hours. It
  still has to be reachable without a session, because a guest needs it before
  joining. Closing that fully means sending the ICE servers over the
  authenticated WebSocket after admission, which is a client change not done
  here.
- **Transparency log** (`/api/v1/transparency`) is operator-only: it returns
  404 unless `Authorization: Bearer <LOG_SECRET>` is sent. It listed invite
  IDs and key data to anyone. The client never read it.
- **File uploads (blob store):** accepted only for an invite whose host key is
  registered and unexpired; at most 20 blobs and 1 GB per invite and 2 GB in
  total (`BLOB_MAX_PER_INVITE`, `BLOB_MAX_BYTES_PER_INVITE`,
  `BLOB_TOTAL_MAX_BYTES`); and a part that would take a blob past its declared
  size is refused. Note that registering a host key only needs a well-formed
  request, so this limits the damage rather than preventing a determined
  abuser; the caps are what bound it.
- If the server loses its key store (a redeploy without a volume), uploads for
  existing invites are refused until the host re-registers its key, which
  happens the next time it admits a guest.

**Tested:** 18 direct server checks (headers, log lock, ICE guard and rate
limit, upload gate and caps) all pass, and the 38 browser checks still pass
with the new headers.
