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
