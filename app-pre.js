// Secure Chat -- shared engine, part 1 (must run BEFORE cyberknot.js loads)
// Defines the Emscripten Module pre-config object + core state; cyberknot.js
// merges into this Module object rather than replacing it.

        let wasmReady = false;
        let keyTransparencyOk = false;
        let iceConfigCache = null;
        let iceConfigWarningShown = false;
        let localDevMode = false;
        let currentInviteId = null;
        let inviteRole = null;
        /* --- waiting room / automated handshake relay (additive) --- */
        let relayWs = null;
        let myConnId = null;             /* guest's connection id, assigned by relay */
        let myDisplayName = null;
        const waitingGuests = new Map(); /* host-side: connId -> name */

        /*
         * --- per-peer connection state ---
         * Replaces the old singleton globals (peerConnection, dataChannel,
         * ecdhKeyPair, peerEcdhPublicKey, isInitiator, expectedPeerFingerprint,
         * fingerprintVerified, livePeerFingerprint, connectionPath,
         * sessionKeyReady, signalPublished, safetyNumberConfirmed) so the
         * host can hold up to MAX_ACTIVE_GUESTS_CLIENT independent encrypted
         * connections without one guest's async events touching another's
         * state. A guest only ever has one peer, always keyed HOST_PEER_KEY.
         */
        const HOST_PEER_KEY = '__host__';
        const MAX_ACTIVE_GUESTS_CLIENT = 5; /* matches server MAX_ACTIVE_GUESTS */
        const peers = new Map(); /* connId -> peer state */
        let hostEcdhKeyPair = null;     /* host's ECDH keypair — one, reused for every guest */
        let activeWasmKeyPeerId = null; /* which peer's key is currently loaded in WASM */

        /* --- audio/video calling: one local camera/mic shared across every
           peer connection; media rides the SAME already-authenticated DTLS
           transport as chat/files, so it inherits that verification --- */
        let localMediaStream = null;
        let callActive = false;
        let micEnabled = true;
        let camEnabled = true;

        /* --- mesh calling: guest<->guest direct connections, alongside
           the existing host<->guest star (unchanged). connId -> display
           name, known from the relay's roster/joined messages, before a
           peer object necessarily exists yet. --- */
        const meshPeerNames = new Map();

        function makePeer(connId, name) {
            return {
                connId,
                pc: null,
                dc: null,
                peerPubKeyB64: null,
                peerPubKey: null,
                sessionKeyHex: null,
                sessionKeyReady: false,
                isInitiator: false,
                signalPublished: false,
                expectedFingerprint: null,
                fingerprintVerified: false,
                livePeerFingerprint: null,
                connectionPath: 'unknown',
                safetyConfirmed: false,
                ecdhKeyPair: null,   /* guest-side only; host uses hostEcdhKeyPair */
                fingerprintTimer: null,
                pendingIncoming: [],
                pendingNoticeShown: false,
                safetyCode: null,
                publishedSignal: null,
                iceRestartAttempted: false,
                connectWatchdogTimer: null,
                connectStatusTimer: null,
                remoteIceQueue: [],
                pendingLocalIce: [],
                trickleIce: false,
                iceGatheringDone: false,
                name: name || null,
                heartbeatTimer: null,
                iceRecoveryTimer: null,
                iceRestartCount: 0,
                lastHeartbeatAck: 0,
                recoveryFailedNotified: false,
                leftNoticeSent: false,
                /* --- audio/video calling (additive; does not touch the
                   data-channel or session-key state above) --- */
                remoteStream: null,
                senders: { audio: null, video: null },
                negotiating: false,
                negotiationPending: false, /* another renegotiation was
                   requested while one was already in flight — drain it
                   once the in-flight one finishes, instead of dropping it */
                ignoreOffer: false,
                /* --- safety-number commit/reveal, held content, signed renegotiation --- */
                sas: null,
                myPubKeyB64: null,
                heldUntilConfirmed: [],
                releasingHeld: false,
                heldNoticeShown: false,
                renegSendSeq: 0,
                renegRecvSeq: 0
            };
        }

        function myKeyPairFor(peer) {
            return inviteRole === 'host' ? hostEcdhKeyPair : peer.ecdhKeyPair;
        }
        const incomingFiles = new Map();
        const incomingMessages = new Map();
        const fileAesKeyCache = new Map();
        /* hybrid: ≤20 MB pure P2P (Option A); >20 MB encrypted blob relay (Option B) */
        const FILE_TRANSFER_MODE = 'hybrid';
        const FILE_BLOB_THRESHOLD_BYTES = 20 * 1024 * 1024;
        const FILE_BLOB_PART_BYTES = 4 * 1024 * 1024;
        const FILE_BLOB_MAX_BYTES = 500 * 1024 * 1024;
        const FILE_LEGACY_CHUNK_SIZE = 384; /* CyberKnot WASM limit — legacy small-file path */
        const FILE_P2P_CHUNK_BYTES = 32768;
        const FILE_DC_MAX_BUFFERED = 2 * 1024 * 1024;
        const FILE_P2P_MAX_BYTES = FILE_BLOB_THRESHOLD_BYTES;
        const LARGE_FILE_WARN_BYTES = 10 * 1024 * 1024;
        const FILE_SEND_CHUNKS_PER_SEC_EST = 120;
        const FILE_BLOB_PARTS_PER_SEC_EST = 8;
        /* Must stay under WASM BRIDGE_MAX_PLAIN (880) after JSON envelope overhead */
        const TEXT_CHUNK_SIZE = 512;
        const ENCRYPT_MAX_PLAIN = 880;
        const SIGNAL_VERSION = 3;
        const MIN_ROOM_SECRET_LEN = 32;
        const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
        const DISPLAY_NAME_MAX_CLIENT = 40; /* matches server DISPLAY_NAME_MAX */
        const TRICKLE_PUBLISH_MS = 1200;    /* send offer/answer after first ICE candidates, not full gather */
        const TURN_TRICKLE_WAIT_MS = 8000;  /* wait for TURN relay candidates before publishing when TURN configured */
        const HEARTBEAT_INTERVAL_MS = 25000;
        const HEARTBEAT_TIMEOUT_MS = 75000;
        const ICE_RESTART_MAX = 5;
        const ICE_DISCONNECTED_GRACE_MS = 8000;

        const chatBox = document.getElementById('chat-box');
        const msgInput = document.getElementById('msg-input');
        const fileInput = document.getElementById('file-input');
        const sendBtn = document.getElementById('send-btn');
        const fileBtn = document.getElementById('file-btn');
        const fileTransferBanner = document.getElementById('file-transfer-banner');
        const statusDot = document.getElementById('status-dot');
        const signalArea = document.getElementById('signal-area');
        const roomSecretInput = document.getElementById('room-secret');
        const createInviteBtn = document.getElementById('create-invite-btn');
        const copyGuestLinkBtn = document.getElementById('copy-guest-link-btn');
        const guestInviteLinkArea = document.getElementById('guest-invite-link');

        function isLocalDevOrigin() {
            return location.hostname === 'localhost'
                || location.hostname === '127.0.0.1'
                || location.hostname.endsWith('.local');
        }

        function preferTurnRelay() {
            /* Public HTTPS sites cannot rely on direct LAN candidates — Chrome 142+
               Local Network Access blocks private IP ICE without a permission prompt. */
            return location.protocol === 'https:' && !isLocalDevOrigin();
        }

        function iceConfigHasTurn(cfg) {
            const servers = cfg?.iceServers || [];
            return servers.some((entry) => {
                const list = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
                return list.some((u) => u.startsWith('turn:') || u.startsWith('turns:'));
            });
        }

        function buildRtcConfigSync() {
            const cfg = iceConfigCache || window.AEGIS_ICE || {
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
                iceTransportPolicy: 'all'
            };
            const servers = cfg.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
            const stunUrls = new Set([
                'stun:stun.l.google.com:19302',
                'stun:stun1.l.google.com:19302'
            ]);
            const turnServers = [];

            for (const entry of servers) {
                const list = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
                const turnUrls = [];
                for (const url of list) {
                    if (url.startsWith('stun:')) {
                        stunUrls.add(url);
                    } else if (url.startsWith('turn:') || url.startsWith('turns:')) {
                        turnUrls.push(url);
                    }
                }
                if (turnUrls.length === 0) continue;
                if (entry.username && entry.credential) {
                    turnServers.push({
                        urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
                        username: entry.username,
                        credential: entry.credential
                    });
                } else {
                    console.warn('TURN URLs omitted — missing username/credential', turnUrls);
                }
            }

            let iceTransportPolicy = cfg.iceTransportPolicy || 'all';
            /* Never force relay-only — if TURN allocation fails, ICE hangs indefinitely. */
            if (iceTransportPolicy === 'relay') {
                iceTransportPolicy = 'all';
            }

            return {
                iceServers: [{ urls: [...stunUrls] }, ...turnServers],
                iceTransportPolicy,
                iceCandidatePoolSize: turnServers.length > 0 ? 16 : 0,
                bundlePolicy: 'max-bundle',
                rtcpMuxPolicy: 'require'
            };
        }

        function isMobileSafari() {
            const ua = navigator.userAgent;
            return (/iPhone|iPad|iPod/i.test(ua) && /Safari/i.test(ua))
                || (/Safari/i.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS/i.test(ua) && /Mobile/i.test(ua));
        }

        function isSafari() {
            const ua = navigator.userAgent;
            return /Safari/i.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS|Chromium/i.test(ua);
        }

        async function loadIceConfig(force = false) {
            if (iceConfigCache && !force) return iceConfigCache;
            try {
                const response = await fetch('/api/ice-config', { cache: 'no-store' });
                if (response.ok) {
                    iceConfigCache = await response.json();
                    if (iceConfigCache.turnWarning && !iceConfigWarningShown) {
                        iceConfigWarningShown = true;
                        addMessage(iceConfigCache.turnWarning, 'system');
                    }
                    return iceConfigCache;
                }
            } catch (_) {
                /* local dev without keyserver */
            }
            iceConfigCache = window.AEGIS_ICE || {
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
                iceTransportPolicy: 'all'
            };
            return iceConfigCache;
        }

        function preloadIceConfig() {
            loadIceConfig().catch(() => {});
        }

        async function buildRtcConfig() {
            await loadIceConfig(true);
            return buildRtcConfigSync();
        }

        function addMessage(text, type = 'received', senderName = null) {
            const div = document.createElement('div');
            div.className = `msg ${type}`;
            div.textContent = senderName ? `${senderName}: ${text}` : text;
            chatBox.appendChild(div);
            chatBox.scrollTop = chatBox.scrollHeight;
        }

        function setFileTransferStatus(text) {
            fileTransferBanner.textContent = text;
            fileTransferBanner.classList.add('show');
        }

        function clearFileTransferStatus() {
            fileTransferBanner.textContent = '';
            fileTransferBanner.classList.remove('show');
        }

        function waitForNextPaint() {
            return new Promise((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(resolve));
            });
        }

        function formatBytes(bytes) {
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        }

        function formatEta(totalSeconds) {
            if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return 'unknown';
            const secs = Math.max(1, Math.round(totalSeconds));
            if (secs < 60) return `${secs}s`;
            const mins = Math.floor(secs / 60);
            const rem = secs % 60;
            if (mins < 60) return rem ? `${mins}m ${rem}s` : `${mins}m`;
            const hrs = Math.floor(mins / 60);
            const remMins = mins % 60;
            return remMins ? `${hrs}h ${remMins}m` : `${hrs}h`;
        }

        function estimateFileSendEtaSeconds(fileSize) {
            if (fileSize > FILE_BLOB_THRESHOLD_BYTES) {
                const totalParts = Math.max(1, Math.ceil(fileSize / FILE_BLOB_PART_BYTES));
                return totalParts / FILE_BLOB_PARTS_PER_SEC_EST;
            }
            const chunkBytes = FILE_P2P_CHUNK_BYTES;
            const totalChunks = Math.max(1, Math.ceil(fileSize / chunkBytes));
            return totalChunks / FILE_SEND_CHUNKS_PER_SEC_EST;
        }

        function blobProofMessage(inviteId, blobId, action) {
            return `${inviteId}:blob:${blobId}:${action}`;
        }

        async function makeBlobProof(blobId, action) {
            return hmacSign(getRoomSecret(), blobProofMessage(currentInviteId, blobId, action));
        }

        function yieldToEventLoop() {
            return new Promise((resolve) => setTimeout(resolve, 0));
        }

        function getRoomSecret() {
            return roomSecretInput.value;
        }

        function roomSecretValid() {
            return getRoomSecret().length >= MIN_ROOM_SECRET_LEN;
        }

        function peerCanSend(peer) {
            return peer.sessionKeyReady && peer.fingerprintVerified && peer.safetyConfirmed
                && peer.dc && peer.dc.readyState === 'open';
        }

        function peerReadyForSafetyConfirm(peer) {
            return peer.sessionKeyReady && peer.fingerprintVerified
                && peer.dc && peer.dc.readyState === 'open';
        }

        function describePeerConnectState(peer) {
            if (!peer.pc) return 'no peer connection';
            const parts = [
                `signaling: ${peer.pc.signalingState}`,
                `ICE: ${peer.pc.iceConnectionState}`,
                `gathering: ${peer.pc.iceGatheringState}`,
            ];
            if (peer.dc) parts.push(`channel: ${peer.dc.readyState}`);
            return parts.join(', ');
        }

        function stopPeerConnectWatchdog(peer) {
            if (peer.connectWatchdogTimer) {
                clearTimeout(peer.connectWatchdogTimer);
                peer.connectWatchdogTimer = null;
            }
            if (peer.connectStatusTimer) {
                clearInterval(peer.connectStatusTimer);
                peer.connectStatusTimer = null;
            }
        }

        function startPeerConnectWatchdog(peer) {
            stopPeerConnectWatchdog(peer);
            let statusTicks = 0;
            peer.connectStatusTimer = setInterval(() => {
                if (!peer.pc || peer.dc?.readyState === 'open') {
                    stopPeerConnectWatchdog(peer);
                    return;
                }
                statusTicks += 1;
                if (statusTicks % 3 === 0) {
                    addMessage(`Still connecting — ${describePeerConnectState(peer)}`, 'system');
                }
                updateSecurityPanel();
            }, 10000);

            peer.connectWatchdogTimer = setTimeout(async () => {
                if (!peer.pc || peer.dc?.readyState === 'open') return;
                const ice = peer.pc.iceConnectionState;
                addMessage(`Connection slow (${ice}) — retrying…`, 'system');
                await attemptPeerIceRecovery(peer, `slow connect (${ice})`);
                updateSecurityPanel();
            }, isSafari() ? 45000 : 35000);
        }

        function stopPeerHeartbeat(peer) {
            if (peer.heartbeatTimer) {
                clearInterval(peer.heartbeatTimer);
                peer.heartbeatTimer = null;
            }
            if (peer.iceRecoveryTimer) {
                clearTimeout(peer.iceRecoveryTimer);
                peer.iceRecoveryTimer = null;
            }
        }

        function handleHeartbeatMessage(peer, msg) {
            if (msg.type === 'aegis-ping') {
                peer.lastHeartbeatAck = Date.now();
                if (peer.dc?.readyState === 'open') {
                    try {
                        peer.dc.send(JSON.stringify({ type: 'aegis-pong', t: msg.t }));
                    } catch (_) { /* channel closing */ }
                }
                return true;
            }
            if (msg.type === 'aegis-pong') {
                peer.lastHeartbeatAck = Date.now();
                peer.iceRestartCount = 0;
                peer.recoveryFailedNotified = false;
                return true;
            }
            return false;
        }

        function startPeerHeartbeat(peer) {
            stopPeerHeartbeat(peer);
            peer.lastHeartbeatAck = Date.now();
            peer.heartbeatTimer = setInterval(() => {
                tickPeerHeartbeat(peer);
            }, HEARTBEAT_INTERVAL_MS);
        }

        async function tickPeerHeartbeat(peer) {
            if (peer.closing || !peer.pc) return;
            if (peer.dc?.readyState === 'open') {
                try {
                    peer.dc.send(JSON.stringify({ type: 'aegis-ping', t: Date.now() }));
                } catch (_) { /* ignore */ }
            }
            const silentMs = Date.now() - (peer.lastHeartbeatAck || 0);
            if (silentMs > HEARTBEAT_TIMEOUT_MS) {
                await attemptPeerIceRecovery(peer, 'idle timeout');
            }
        }

        function scheduleIceRecovery(peer, delayMs = ICE_DISCONNECTED_GRACE_MS) {
            if (peer.closing || peer.iceRecoveryTimer) return;
            peer.iceRecoveryTimer = setTimeout(async () => {
                peer.iceRecoveryTimer = null;
                if (!peer.pc || peer.closing) return;
                const ice = peer.pc.iceConnectionState;
                if (ice === 'disconnected' || ice === 'failed') {
                    await attemptPeerIceRecovery(peer, `ICE ${ice}`);
                }
            }, delayMs);
        }

        async function attemptPeerIceRecovery(peer, reason) {
            if (peer.closing) return;
            if (peer.iceRestartCount >= ICE_RESTART_MAX) {
                if (!peer.recoveryFailedNotified) {
                    peer.recoveryFailedNotified = true;
                    addMessage(
                        `Connection lost (${reason}). Click Reset, hard-refresh, and reconnect.`,
                        'system'
                    );
                }
                return;
            }
            peer.iceRestartCount += 1;
            peer.iceRestartAttempted = false;
            addMessage(
                `Connection interrupted — reconnecting (${peer.iceRestartCount}/${ICE_RESTART_MAX})…`,
                'system'
            );
            const useRelay = preferTurnRelay() && iceConfigHasTurn(iceConfigCache);
            if (await retryPeerIce(peer, useRelay)) {
                updateSecurityPanel();
                return;
            }
            if (peer.iceRestartCount >= ICE_RESTART_MAX && !peer.recoveryFailedNotified) {
                peer.recoveryFailedNotified = true;
                addMessage(
                    `Connection lost (${reason}). Click Reset, hard-refresh, and reconnect.`,
                    'system'
                );
            }
        }

        function relayTrickleEnabled() {
            return relayWs && relayWs.readyState === WebSocket.OPEN;
        }

        function sendRelayIceCandidate(peer, candidateInit) {
            if (!relayTrickleEnabled()) return;
            const body = { type: 'ice-candidate', payload: candidateInit };
            if (inviteRole === 'host') {
                body.connId = peer.connId;
            }
            relayWs.send(JSON.stringify(body));
        }

        function flushPendingLocalIce(peer) {
            if (!peer.trickleIce || !peer.pendingLocalIce?.length) return;
            const pending = peer.pendingLocalIce.splice(0);
            for (const init of pending) {
                sendRelayIceCandidate(peer, init);
            }
        }

        async function addRemoteIceCandidate(peer, candidateInit) {
            if (!peer.pc || !candidateInit) return;
            if (!peer.pc.remoteDescription) {
                peer.remoteIceQueue.push(candidateInit);
                return;
            }
            try {
                await peer.pc.addIceCandidate(candidateInit);
            } catch (err) {
                console.warn('addIceCandidate failed:', err);
            }
        }

        async function flushRemoteIceQueue(peer) {
            if (!peer.remoteIceQueue?.length) return;
            const queued = peer.remoteIceQueue.splice(0);
            for (const candidateInit of queued) {
                await addRemoteIceCandidate(peer, candidateInit);
            }
        }

        function waitForEarlyIcePublish(pc, maxMs = TRICKLE_PUBLISH_MS) {
            if (pc.iceGatheringState === 'complete') {
                return Promise.resolve();
            }
            return new Promise((resolve) => {
                const done = () => {
                    pc.removeEventListener('icecandidate', onCandidate);
                    clearTimeout(timer);
                    resolve();
                };
                const onCandidate = (event) => {
                    if (event.candidate || pc.iceGatheringState === 'complete') {
                        done();
                    }
                };
                pc.addEventListener('icecandidate', onCandidate);
                const timer = setTimeout(done, maxMs);
            });
        }

        function waitForTricklePublish(pc) {
            const hasTurn = iceConfigHasTurn(iceConfigCache);
            if (!hasTurn) {
                return waitForEarlyIcePublish(pc, TRICKLE_PUBLISH_MS);
            }
            const maxMs = isSafari() ? Math.max(TURN_TRICKLE_WAIT_MS, 12000) : TURN_TRICKLE_WAIT_MS;
            if (pc.iceGatheringState === 'complete') {
                return Promise.resolve();
            }
            return new Promise((resolve) => {
                let finished = false;
                const finish = () => {
                    if (finished) return;
                    finished = true;
                    pc.removeEventListener('icecandidate', onCandidate);
                    pc.removeEventListener('icegatheringstatechange', onGathering);
                    clearTimeout(timer);
                    resolve();
                };
                const checkRelay = () => {
                    const sdp = pc.localDescription?.sdp || '';
                    if (sdpHasRelayCandidate(sdp)) finish();
                };
                const onCandidate = (event) => {
                    if (!event.candidate) finish();
                    else checkRelay();
                };
                const onGathering = () => {
                    if (pc.iceGatheringState === 'complete') finish();
                    else checkRelay();
                };
                pc.addEventListener('icecandidate', onCandidate);
                pc.addEventListener('icegatheringstatechange', onGathering);
                const timer = setTimeout(() => {
                    if (!sdpHasRelayCandidate(pc.localDescription?.sdp || '')) {
                        addMessage(
                            'TURN relay still gathering — cross-network connect may take up to a minute. Keep both tabs open.',
                            'system'
                        );
                    }
                    finish();
                }, maxMs);
                checkRelay();
            });
        }

        async function ensureSignalPublished(peer, label) {
            if (peer.signalPublished) return peer.publishedSignal;
            if (peer.trickleIce) {
                await waitForTricklePublish(peer.pc);
            } else {
                await waitForIceGatheringAndRelay(peer.pc, isSafari() ? 20000 : 10000);
            }
            if (!peer.signalPublished) {
                await publishLocalSignal(peer, label);
            }
            return peer.publishedSignal;
        }

        function getSendBlockers() {
            const blockers = [];
            if (!wasmReady) blockers.push('encryption module');
            if (!roomSecretValid()) blockers.push('room secret');
            if (!currentInviteId) blockers.push('invite link');
            if (!keyTransparencyOk) blockers.push('key transparency');
            if (peers.size === 0) {
                blockers.push('peer connection');
                return blockers;
            }
            const peer = [...peers.values()][0];
            if (!peer.sessionKeyReady) blockers.push('session key');
            if (!peer.fingerprintVerified) blockers.push('DTLS fingerprint');
            if (!peer.dc || peer.dc.readyState !== 'open') blockers.push('P2P channel');
            if (!peer.safetyConfirmed) blockers.push('safety code');
            return blockers;
        }

        function updateSecurityPanel() {
            document.getElementById('sec-wasm').innerHTML = wasmReady
                ? '<span class="ok">✓ WASM ready</span>'
                : '<span class="bad">✗ WASM not ready</span>';
            document.getElementById('sec-room').innerHTML = roomSecretValid()
                ? '<span class="ok">✓ Room secret set (from invite)</span>'
                : '<span class="bad">✗ Room secret required — create or open invite link</span>';
            document.getElementById('sec-invite').innerHTML = currentInviteId
                ? `<span class="ok">✓ Invite ${inviteRole}: ${currentInviteId.slice(0, 8)}…</span>`
                : '<span class="bad">✗ Invite-only — create or open invite link</span>';
            document.getElementById('sec-transparency').innerHTML = keyTransparencyOk
                ? localDevMode
                    ? '<span class="ok">✓ Key transparency skipped (local dev mode)</span>'
                    : '<span class="ok">✓ Key transparency verified</span>'
                : '<span class="bad">✗ Key transparency not verified</span>';

            renderPeerStatusList();

            const anyReady = [...peers.values()].some(peerCanSend);
            const canSend = wasmReady && roomSecretValid() && currentInviteId && keyTransparencyOk && anyReady;
            msgInput.disabled = !canSend;
            fileInput.disabled = !canSend;
            sendBtn.disabled = !canSend;
            fileBtn.disabled = !canSend;
            if (canSend) {
                msgInput.placeholder = 'Type secure message…';
            } else {
                const blockers = getSendBlockers();
                msgInput.placeholder = blockers.length
                    ? `Waiting for: ${blockers.join(', ')}…`
                    : 'Type secure message… (connect first)';
            }

            // Centralized hook: every peer-state transition that matters for
            // the participants roster (channel open/close, key/fingerprint
            // ready, safety confirmed) already calls updateSecurityPanel(),
            // so refresh the roster from here rather than chasing every call
            // site individually. refreshRoster is defined later in
            // app-post.js, but this branch is only ever reachable once
            // inviteRole is 'host', which only happens after a user action —
            // by then both scripts have already loaded.
            if (inviteRole === 'host' && typeof refreshRoster === 'function') refreshRoster();
            /* Call / Hang up availability follows peer state. Guarded because this
               can run while app-post.js is still loading. */
            if (typeof updateCallButtons === 'function') {
                try { updateCallButtons(); } catch (_) { /* call UI not initialised yet */ }
            }
        }

        function renderPeerStatusList() {
            const container = document.getElementById('peer-status-list');
            if (!container) return;
            if (peers.size === 0) {
                container.innerHTML = '';
                return;
            }
            container.innerHTML = '';
            for (const [connId, peer] of peers.entries()) {
                const channelOpen = peer.dc && peer.dc.readyState === 'open';
                const channelConnecting = peer.dc && peer.dc.readyState === 'connecting';
                const pcConnecting = peer.pc
                    && peer.pc.connectionState !== 'closed'
                    && peer.pc.connectionState !== 'failed';
                const card = document.createElement('div');
                card.className = 'peer-card' + (peer.safetyConfirmed ? ' confirmed' : '');

                const title = document.createElement('h4');
                title.textContent = peer.name ? peer.name : (inviteRole === 'host' ? 'Guest' : 'Host');
                card.appendChild(title);

                const lines = [
                    peer.expectedFingerprint
                        ? '<span class="ok">✓ Signaling authenticated (HMAC + SDP fingerprint)</span>'
                        : '<span class="bad">✗ Signaling not authenticated</span>',
                    peer.sessionKeyReady
                        ? '<span class="ok">✓ Session key derived (ECDH P-256 + HKDF)</span>'
                        : '<span class="bad">✗ Session key not derived</span>',
                    peer.fingerprintVerified
                        ? `<span class="ok">✓ DTLS fingerprint verified (${formatFingerprint(peer.livePeerFingerprint)})</span>`
                        : peer.expectedFingerprint
                            ? '<span class="bad">✗ DTLS fingerprint not yet verified live</span>'
                            : '<span class="bad">✗ DTLS fingerprint: pending signaling</span>',
                    channelOpen
                        ? '<span class="ok">✓ P2P channel open</span>'
                        : (channelConnecting || pcConnecting)
                            ? '<span class="ok">⏳ P2P channel connecting…</span>'
                            : '<span class="bad">✗ P2P channel closed</span>',
                    peer.connectionPath === 'relay'
                        ? '<span class="ok">✓ Routed via TURN relay</span>'
                        : peer.connectionPath === 'direct'
                            ? '<span class="ok">✓ Direct P2P (local/STUN)</span>'
                            : channelOpen
                                ? '<span class="ok">✓ P2P connected (path stats unavailable on this browser)</span>'
                                : (channelConnecting || pcConnecting)
                                    ? `<span class="ok">⏳ Connecting… (${peer.pc ? peer.pc.iceConnectionState : 'starting'})</span>`
                                    : '<span class="bad">✗ Connection path unavailable</span>'
                ];
                lines.forEach((html) => {
                    const div = document.createElement('div');
                    div.className = 'peer-status-line';
                    div.innerHTML = html;
                    card.appendChild(div);
                });

                if (peer.sessionKeyReady) {
                    const codeDiv = document.createElement('div');
                    codeDiv.className = 'peer-safety-code';
                    codeDiv.textContent = peer.safetyCode || '------';
                    card.appendChild(codeDiv);

                    const confirmBtn = document.createElement('button');
                    confirmBtn.className = 'peer-safety-confirm-btn';
                    confirmBtn.textContent = peer.safetyConfirmed
                        ? 'Confirmed ✓'
                        : peerReadyForSafetyConfirm(peer)
                            ? 'Confirm — codes match'
                            : 'Waiting for secure channel…';
                    confirmBtn.disabled = peer.safetyConfirmed || !peerReadyForSafetyConfirm(peer) || !peer.safetyCode;
                    confirmBtn.onclick = async () => {
                        if (!peerReadyForSafetyConfirm(peer)) {
                            addMessage('Wait for P2P channel open and DTLS verified before confirming.', 'system');
                            return;
                        }
                        if (!peer.safetyCode) {
                            addMessage('Safety code is still being agreed with the other side. Wait for the 6 digits to appear.', 'system');
                            return;
                        }
                        peer.safetyConfirmed = true;
                        updateSecurityPanel();
                        /* Releases anything held back until now: queued messages/files,
                           this peer's audio/video, and our own tracks toward them. */
                        if (typeof onPeerSafetyConfirmed === 'function') onPeerSafetyConfirmed(peer);
                        if (peerCanSend(peer) && wasmReady && keyTransparencyOk) {
                            addMessage(`Safety check confirmed with ${peer.name || 'peer'} — unlocked.`, 'system');
                            if (typeof announceReady === 'function') announceReady(peer);
                        } else {
                            const missing = getSendBlockers().join(', ');
                            addMessage(`Safety code confirmed — still waiting for: ${missing}.`, 'system');
                        }
                    };
                    card.appendChild(confirmBtn);
                }

                container.appendChild(card);
            }
        }

        function markWasmReady() {
            if (wasmReady) return true;
            const ready = typeof Module._bridge_encrypt_b64 === 'function'
                && typeof Module._bridge_decrypt_b64 === 'function'
                && typeof Module._bridge_set_session_key === 'function'
                && typeof Module._malloc === 'function';
            if (!ready) return false;
            wasmReady = true;
            addMessage('CyberKnot encryption module ready.', 'system');
            for (const peer of peers.values()) flushPendingIncoming(peer);
            updateSecurityPanel();
            return true;
        }

        async function flushPendingIncoming(peer) {
            if (!wasmReady || !peer.sessionKeyReady || !peer.fingerprintVerified || peer.pendingIncoming.length === 0) return;
            const queued = peer.pendingIncoming.splice(0);
            peer.pendingNoticeShown = false;
            for (const envelope of queued) {
                try {
                    if (envelope.type === 'secure-file') {
                        await handleSecureFileEnvelope(peer, envelope);
                    } else {
                        handleSecureEnvelope(peer, envelope);
                    }
                } catch (err) {
                    addMessage(`Error receiving message: ${err.message}`, 'notice');
                }
            }
        }

        var Module = {
            locateFile: (path) => path,
            onRuntimeInitialized: () => {
                if (!markWasmReady()) {
                    addMessage('WASM bridge functions missing — rebuild cyberknot.js.', 'system');
                }
            },
            onAbort: (reason) => {
                wasmReady = false;
                for (const peer of peers.values()) peer.sessionKeyReady = false;
                addMessage(`WASM error: ${reason}`, 'notice');
                updateSecurityPanel();
            }
        };

        const wasmPoll = setInterval(() => {
            if (markWasmReady()) clearInterval(wasmPoll);
        }, 50);
        setTimeout(() => {
            clearInterval(wasmPoll);
            if (!wasmReady) {
                addMessage('Encryption module failed to load — hard-refresh (Cmd+Shift+R).', 'notice');
            }
        }, 30000);

        roomSecretInput.addEventListener('input', updateSecurityPanel);
