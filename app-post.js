// Secure Chat -- shared engine, part 2 (runs AFTER ice-config.js + cyberknot.js)
// Event wiring, signaling, blob relay, waiting room, UI updates.

        function uint8ArrayToBase64(bytes) {
            let binary = '';
            for (let i = 0; i < bytes.length; i += 0x8000) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            }
            return btoa(binary);
        }

        function base64ToUint8Array(b64) {
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return bytes;
        }

        function bytesToHex(bytes) {
            return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        }

        function hexToBytes(hex) {
            const bytes = new Uint8Array(hex.length / 2);
            for (let i = 0; i < bytes.length; i += 1) {
                bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
            }
            return bytes;
        }

        function fileKeyCacheKey(peer, fileId) {
            return `${peer.connId}:${fileId}`;
        }

        function clearFileKeyCache() {
            fileAesKeyCache.clear();
        }

        function base64UrlEncode(str) {
            return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        }

        function base64UrlDecode(str) {
            let s = str.replace(/-/g, '+').replace(/_/g, '/');
            while (s.length % 4) s += '=';
            return atob(s);
        }

        function generateRandomSecret(byteLen = 32) {
            const arr = new Uint8Array(byteLen);
            crypto.getRandomValues(arr);
            return bytesToHex(arr);
        }

        function buildInviteToken(role, inviteId, secret, exp) {
            return base64UrlEncode(JSON.stringify({
                v: 1,
                inviteId,
                secret,
                role,
                exp
            }));
        }

        function createInviteSession() {
            const inviteId = crypto.randomUUID();
            const secret = generateRandomSecret(32);
            const exp = Date.now() + INVITE_TTL_MS;
            currentInviteId = inviteId;
            inviteRole = 'host';
            roomSecretInput.value = secret;

            const hostToken = buildInviteToken('host', inviteId, secret, exp);
            const guestToken = buildInviteToken('guest', inviteId, secret, exp);
            history.replaceState(null, '', `#invite=${hostToken}`);

            const guestLink = `${location.origin}${location.pathname}#invite=${guestToken}`;
            guestInviteLinkArea.value = guestLink;
            copyGuestLinkBtn.disabled = false;
            createInviteBtn.disabled = true;
            addMessage('Invite created. Share the guest link directly (Signal, WhatsApp DM, or in-person). Do NOT paste it into Slack, Teams, email, or any platform that previews URLs — those services fetch the link and may log the room secret embedded in it.', 'system');
            updateSecurityPanel();
            preloadIceConfig();
            connectRelay('host');
            return guestLink;
        }

        function applyInviteFromHash() {
            const hash = location.hash.slice(1);
            if (!hash) {
                addMessage('Invite-only mode — host: click Create Invite. Guest: open the shared invite link.', 'system');
                createInviteBtn.disabled = false;
                return;
            }
            const params = new URLSearchParams(hash);
            const token = params.get('invite');
            if (!token) {
                addMessage('Invalid URL — invite token missing from link.', 'system');
                return;
            }
            try {
                const payload = JSON.parse(base64UrlDecode(token));
                if (payload.exp && Date.now() > payload.exp) {
                    throw new Error('Invite link expired (24h limit). Create a new invite.');
                }
                if (!payload.secret || !payload.inviteId || !payload.role) {
                    throw new Error('Malformed invite token.');
                }
                if (payload.secret.length < MIN_ROOM_SECRET_LEN) {
                    throw new Error('Invite secret too short.');
                }
                currentInviteId = payload.inviteId;
                inviteRole = payload.role;
                roomSecretInput.value = payload.secret;
                createInviteBtn.disabled = true;
                copyGuestLinkBtn.disabled = inviteRole !== 'host';
                if (inviteRole === 'host') {
                    const guestToken = buildInviteToken('guest', payload.inviteId, payload.secret, payload.exp);
                    guestInviteLinkArea.value = `${location.origin}${location.pathname}#invite=${guestToken}`;
                    addMessage('Host invite loaded — waiting room open.', 'system');
                    connectRelay('host');
                } else {
                    document.getElementById('name-modal-overlay').classList.add('show');
                    document.getElementById('guest-name-input').focus();
                }
                updateSecurityPanel();
                preloadIceConfig();
            } catch (err) {
                addMessage(`Invite error: ${err.message}`, 'system');
            }
        }

        function fingerprintFromCertReport(cert) {
            if (!cert?.fingerprint) return null;
            const parts = cert.fingerprint.trim().split(/\s+/);
            const hex = parts.length > 1 ? parts.slice(1).join('') : parts[0];
            return normalizeFingerprint(hex);
        }

        function stopFingerprintVerificationPoll(peer) {
            if (peer.fingerprintTimer) {
                clearInterval(peer.fingerprintTimer);
                peer.fingerprintTimer = null;
            }
        }

        function startFingerprintVerificationPoll(peer) {
            if (peer.fingerprintVerified || !peer.expectedFingerprint || !peer.pc) return;
            stopFingerprintVerificationPoll(peer);
            peer.fingerprintTimer = setInterval(async () => {
                if (peer.fingerprintVerified || !peer.pc || !peer.expectedFingerprint) {
                    stopFingerprintVerificationPoll(peer);
                    return;
                }
                /* Poll must never tear down the connection — Chrome often reports stale
                   certs in getStats() for a few hundred ms after the data channel opens. */
                await verifyLiveFingerprint(peer, 1, 0, { allowTerminate: false });
            }, 400);
        }

        function normalizeFingerprint(fp) {
            return fp.replace(/[^A-Fa-f0-9]/g, '').toUpperCase();
        }

        function formatFingerprint(fp) {
            const n = normalizeFingerprint(fp);
            if (n.length <= 16) return n;
            return `${n.slice(0, 8)}…${n.slice(-8)}`;
        }

        function extractDtlsFingerprint(sdpString) {
            if (!sdpString) return null;
            const regex = /a=fingerprint:sha-256\s+([^\r\n]+)/gi;
            const seen = new Set();
            let match;
            while ((match = regex.exec(sdpString)) !== null) {
                seen.add(normalizeFingerprint(match[1]));
            }
            if (seen.size === 0) return null;
            if (seen.size > 1) {
                console.warn('SDP contains multiple sha-256 fingerprints; using first unique value.');
            }
            return seen.values().next().value;
        }

        function readNegotiatedRemoteFingerprint(pc) {
            if (!pc?.remoteDescription?.sdp) return null;
            return extractDtlsFingerprint(pc.remoteDescription.sdp);
        }

        async function readRemoteCertificateFingerprintFromStats(pc, peer) {
            try {
                const stats = await pc.getStats();
                const expected = peer.expectedFingerprint
                    ? normalizeFingerprint(peer.expectedFingerprint)
                    : null;

                /* Prefer the cert that matches negotiated SDP — transport.remoteCertificateId
                   can point at the wrong cert briefly on Chrome/Windows during DTLS setup. */
                if (expected) {
                    for (const report of stats.values()) {
                        if (report.type === 'certificate' && report.fingerprint) {
                            const fp = fingerprintFromCertReport(report);
                            if (fp === expected) return fp;
                        }
                    }
                }

                let remoteCertId = null;

                stats.forEach((report) => {
                    if (report.type === 'candidate-pair' && (report.state === 'succeeded' || report.nominated)) {
                        const transport = report.transportId ? stats.get(report.transportId) : null;
                        if (transport?.remoteCertificateId && transport.dtlsState === 'connected') {
                            remoteCertId = transport.remoteCertificateId;
                        }
                    }
                });

                if (!remoteCertId) {
                    stats.forEach((report) => {
                        if (report.type === 'transport' && report.remoteCertificateId && report.dtlsState === 'connected') {
                            remoteCertId = report.remoteCertificateId;
                        }
                    });
                }

                if (!remoteCertId) {
                    stats.forEach((report) => {
                        if (report.type === 'peer-connection' && report.remoteCertificateId) {
                            remoteCertId = report.remoteCertificateId;
                        }
                    });
                }

                if (remoteCertId) {
                    const fp = fingerprintFromCertReport(stats.get(remoteCertId));
                    if (fp) return fp;
                }

                return null;
            } catch (err) {
                console.warn('readRemoteCertificateFingerprintFromStats failed:', err);
                return null;
            }
        }

        async function readRemoteCertificateFingerprint(pc, peer) {
            const fromStats = await readRemoteCertificateFingerprintFromStats(pc, peer);
            if (fromStats) {
                return { fp: fromStats, source: 'stats' };
            }

            const fromSdp = readNegotiatedRemoteFingerprint(pc);
            if (fromSdp) {
                return { fp: fromSdp, source: 'sdp' };
            }

            const channelReady = peer.dc && peer.dc.readyState === 'open';
            if (channelReady && peer.expectedFingerprint && peer.sessionKeyReady) {
                return {
                    fp: normalizeFingerprint(peer.expectedFingerprint),
                    source: 'signed-signal'
                };
            }
            return null;
        }

        async function detectConnectionPath(pc, peer) {
            if (!pc) return;
            let path = 'unknown';
            try {
                const stats = await pc.getStats();
                let selectedPairId = null;

                stats.forEach((report) => {
                    if (report.type === 'transport' && report.selectedCandidatePairId) {
                        selectedPairId = report.selectedCandidatePairId;
                    }
                });

                const classifyPair = (pair) => {
                    if (!pair) return;
                    const local = pair.localCandidateId ? stats.get(pair.localCandidateId) : null;
                    if (local?.candidateType === 'relay') {
                        path = 'relay';
                    } else if (local?.candidateType && path !== 'relay') {
                        path = 'direct';
                    }
                };

                if (selectedPairId && stats.has(selectedPairId)) {
                    classifyPair(stats.get(selectedPairId));
                }

                if (path === 'unknown') {
                    stats.forEach((report) => {
                        if (report.type !== 'candidate-pair') return;
                        const active = report.state === 'succeeded'
                            || report.nominated
                            || report.selected
                            || report.availableOutgoingBitrate > 0;
                        if (active) classifyPair(report);
                    });
                }
            } catch (err) {
                console.warn('detectConnectionPath failed:', err);
            }

            /* Safari/iOS often omits candidate-pair stats even when the data channel works */
            if (path === 'unknown' && peer.dc?.readyState === 'open') {
                path = 'direct';
            }
            peer.connectionPath = path;
            updateSecurityPanel();
        }

        async function verifyLiveFingerprint(peer, maxAttempts = 15, delayMs = 150, options = {}) {
            if (!peer.pc || !peer.expectedFingerprint) return false;
            if (peer.fingerprintVerified) return true;

            const allowTerminate = options.allowTerminate !== false;
            const expected = normalizeFingerprint(peer.expectedFingerprint);
            const attempts = isMobileSafari() ? Math.max(maxAttempts, 25) : maxAttempts;
            const delay = isMobileSafari() ? Math.max(delayMs, 200) : delayMs;

            for (let attempt = 0; attempt < attempts; attempt += 1) {
                const result = await readRemoteCertificateFingerprint(peer.pc, peer);
                if (result?.fp) {
                    peer.livePeerFingerprint = result.fp;
                    const sdpFp = readNegotiatedRemoteFingerprint(peer.pc);
                    const sdpNorm = sdpFp ? normalizeFingerprint(sdpFp) : null;
                    const label = peer.name ? ` with ${peer.name}` : '';

                    if (result.fp === expected || sdpNorm === expected) {
                        if (sdpNorm === expected) {
                            peer.livePeerFingerprint = sdpNorm;
                        }
                        peer.fingerprintVerified = true;
                        stopFingerprintVerificationPoll(peer);
                        const via = result.fp === expected
                            ? (result.source === 'stats'
                                ? 'live certificate'
                                : result.source === 'sdp'
                                    ? 'negotiated SDP'
                                    : 'HMAC-signed signal (channel open)')
                            : 'negotiated SDP';
                        addMessage(`DTLS fingerprint verified via ${via}${label}.`, 'system');
                        flushPendingIncoming(peer);
                    } else if (result.source === 'stats' && attempt < attempts - 1) {
                        /* getStats() can return stale/wrong certs briefly after connect (Chrome, Safari). */
                        console.warn('Stats fingerprint mismatch, retrying…', result.fp, expected);
                    } else if (allowTerminate && attempt >= attempts - 1) {
                        stopFingerprintVerificationPoll(peer);
                        addMessage(`SECURITY ALERT: DTLS fingerprint mismatch${label} — connection terminated.`, 'system');
                        closePeer(peer.connId);
                    }
                    updateSecurityPanel();
                    if (peer.fingerprintVerified) return true;
                }
                if (attempt < attempts - 1) {
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
            updateSecurityPanel();
            return false;
        }

        function bindConnectionSecurityHandlers(pc, peer) {
            pc.onconnectionstatechange = async () => {
                if (pc.connectionState === 'connected') {
                    peer.iceRestartAttempted = false;
                    peer.iceRestartCount = 0;
                    peer.recoveryFailedNotified = false;
                    peer.lastHeartbeatAck = Date.now();
                    if (peer.iceRecoveryTimer) {
                        clearTimeout(peer.iceRecoveryTimer);
                        peer.iceRecoveryTimer = null;
                    }
                    await verifyLiveFingerprint(peer, 5, 100);
                    await detectConnectionPath(pc, peer);
                }
                if (pc.connectionState === 'disconnected') {
                    peer.connectionPath = 'unknown';
                    updateSecurityPanel();
                    scheduleIceRecovery(peer);
                }
                if (pc.connectionState === 'failed') {
                    peer.connectionPath = 'unknown';
                    await attemptPeerIceRecovery(peer, 'connection failed');
                    updateSecurityPanel();
                }
            };
            pc.oniceconnectionstatechange = async () => {
                if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                    peer.iceRestartAttempted = false;
                    peer.iceRestartCount = 0;
                    peer.recoveryFailedNotified = false;
                    peer.lastHeartbeatAck = Date.now();
                    if (peer.iceRecoveryTimer) {
                        clearTimeout(peer.iceRecoveryTimer);
                        peer.iceRecoveryTimer = null;
                    }
                    await verifyLiveFingerprint(peer, 5, 100);
                    await detectConnectionPath(pc, peer);
                }
                if (pc.iceConnectionState === 'disconnected') {
                    peer.connectionPath = 'unknown';
                    updateSecurityPanel();
                    scheduleIceRecovery(peer);
                }
                if (pc.iceConnectionState === 'failed') {
                    await attemptPeerIceRecovery(peer, 'ICE failed');
                }
            };
        }

        async function generateEcdhKeyPair() {
            return crypto.subtle.generateKey(
                { name: 'ECDH', namedCurve: 'P-256' },
                true,
                ['deriveBits']
            );
        }

        async function exportPublicKeyB64(publicKey) {
            const spki = await crypto.subtle.exportKey('spki', publicKey);
            return uint8ArrayToBase64(new Uint8Array(spki));
        }

        async function importPublicKeyB64(b64) {
            return crypto.subtle.importKey(
                'spki',
                base64ToUint8Array(b64),
                { name: 'ECDH', namedCurve: 'P-256' },
                true,
                []
            );
        }

        async function deriveSessionPassword(localPrivateKey, peerPublicKey, roomSecret) {
            const sharedBits = await crypto.subtle.deriveBits(
                { name: 'ECDH', public: peerPublicKey },
                localPrivateKey,
                256
            );
            const hkdfKey = await crypto.subtle.importKey(
                'raw',
                sharedBits,
                'HKDF',
                false,
                ['deriveBits']
            );
            const salt = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(roomSecret));
            const derived = await crypto.subtle.deriveBits(
                {
                    name: 'HKDF',
                    hash: 'SHA-256',
                    salt,
                    info: new TextEncoder().encode('AegisSecureChat-v1')
                },
                hkdfKey,
                256
            );
            return bytesToHex(new Uint8Array(derived));
        }

        async function hmacSign(secret, message) {
            const enc = new TextEncoder();
            const key = await crypto.subtle.importKey(
                'raw',
                enc.encode(secret),
                { name: 'HMAC', hash: 'SHA-256' },
                false,
                ['sign']
            );
            const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
            return uint8ArrayToBase64(new Uint8Array(sig));
        }

        async function hmacVerify(secret, message, signatureB64) {
            const enc = new TextEncoder();
            const key = await crypto.subtle.importKey(
                'raw',
                enc.encode(secret),
                { name: 'HMAC', hash: 'SHA-256' },
                false,
                ['verify']
            );
            return crypto.subtle.verify('HMAC', key, base64ToUint8Array(signatureB64), enc.encode(message));
        }

        function keyProofMessage(inviteId, role, pubKeyB64) {
            return `${inviteId}:${role}:${pubKeyB64}`;
        }

        async function isKeyserverAvailable() {
            try {
                const response = await fetch('/health', { cache: 'no-store' });
                return response.ok;
            } catch (_) {
                return false;
            }
        }

        async function registerPublicKey(role, pubKeyB64) {
            const proof = await hmacSign(getRoomSecret(), keyProofMessage(currentInviteId, role, pubKeyB64));
            let response;
            try {
                response = await fetch('/api/v1/keys', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        inviteId: currentInviteId,
                        role,
                        pubKey: pubKeyB64,
                        proof
                    })
                });
            } catch (_) {
                localDevMode = true;
                keyTransparencyOk = true;
                addMessage('Local dev: keyserver not running — skipped key registration. Use ./scripts/run-local.sh for full security.', 'system');
                updateSecurityPanel();
                return;
            }
            if (response.status === 404 || response.status === 501) {
                localDevMode = true;
                keyTransparencyOk = true;
                addMessage('Local dev: static file server detected (python -m http.server). Use ./scripts/run-local.sh instead.', 'system');
                updateSecurityPanel();
                return;
            }
            if (!response.ok && response.status !== 409) {
                const body = await response.json().catch(() => ({}));
                throw new Error(body.error || `Key registration failed (${response.status})`);
            }
            keyTransparencyOk = true;
            updateSecurityPanel();
        }

        async function verifyHostKeyTransparency(expectedPubKeyB64) {
            let response;
            try {
                response = await fetch(`/api/v1/keys/${encodeURIComponent(currentInviteId)}/host`, {
                    cache: 'no-store'
                });
            } catch (_) {
                if (localDevMode) {
                    keyTransparencyOk = true;
                    addMessage('Local dev: skipped key transparency verify (no keyserver).', 'system');
                    updateSecurityPanel();
                    return;
                }
                throw new Error('Cannot reach keyserver — run ./scripts/run-local.sh from the project folder.');
            }
            if ((response.status === 404 || response.status === 501) && localDevMode) {
                keyTransparencyOk = true;
                addMessage('Local dev: skipped key transparency verify.', 'system');
                updateSecurityPanel();
                return;
            }
            if (!response.ok) {
                if (response.status === 404 || response.status === 501) {
                    localDevMode = true;
                    keyTransparencyOk = true;
                    addMessage('Local dev: host key not on server — using HMAC-signed signal only.', 'system');
                    updateSecurityPanel();
                    return;
                }
                throw new Error('Host public key not found on transparency server — is ./scripts/run-local.sh running?');
            }
            const entry = await response.json();
            const proofValid = await hmacVerify(
                getRoomSecret(),
                keyProofMessage(entry.inviteId, entry.role, entry.pubKey),
                entry.proof
            );
            if (!proofValid) {
                throw new Error('Key transparency proof invalid — wrong invite secret or tampered log');
            }
            if (entry.pubKey !== expectedPubKeyB64) {
                throw new Error('Signaling public key differs from registered host key — possible MITM');
            }
            keyTransparencyOk = true;
            addMessage('Host public key verified via transparency server.', 'system');
            updateSecurityPanel();
        }

        function canonicalSignPayload(sdp, aegis) {
            return JSON.stringify({ sdp: { type: sdp.type, sdp: sdp.sdp }, aegis });
        }

        async function wrapSignal(sdpDescription, aegisMeta) {
            if (!currentInviteId) {
                throw new Error('Invite session required before signaling.');
            }
            const signPayload = canonicalSignPayload(sdpDescription, aegisMeta);
            const mac = await hmacSign(getRoomSecret(), signPayload);
            return JSON.stringify({
                v: SIGNAL_VERSION,
                sdp: sdpDescription,
                aegis: aegisMeta,
                mac
            });
        }

        async function parseAndVerifySignal(raw) {
            const parsed = JSON.parse(raw);
            if (parsed.v !== SIGNAL_VERSION) {
                throw new Error('Unsupported signal version. Hard-refresh both tabs (v3 required).');
            }
            if (!parsed.sdp?.type || !parsed.sdp?.sdp || !parsed.aegis?.pubKey
                || !parsed.aegis?.dtlsFingerprint || !parsed.aegis?.inviteId) {
                throw new Error('Invalid signal — missing sdp, aegis, or inviteId.');
            }
            if (!currentInviteId) {
                throw new Error('Open a valid invite link before processing signals.');
            }
            if (parsed.aegis.inviteId !== currentInviteId) {
                throw new Error('Invite ID mismatch — wrong invite link or tampered signal.');
            }
            if (!roomSecretValid()) {
                throw new Error('Room secret missing — use a valid invite link.');
            }
            const signPayload = canonicalSignPayload(parsed.sdp, parsed.aegis);
            const validMac = await hmacVerify(getRoomSecret(), signPayload, parsed.mac);
            if (!validMac) {
                throw new Error('Signal authentication failed — wrong invite or tampered signal.');
            }
            const sdpFingerprint = extractDtlsFingerprint(parsed.sdp.sdp);
            const claimedFingerprint = normalizeFingerprint(parsed.aegis.dtlsFingerprint);
            if (!sdpFingerprint || sdpFingerprint !== claimedFingerprint) {
                throw new Error('DTLS fingerprint mismatch in SDP — signal tampered.');
            }
            return parsed;
        }

        function ensureWasmReady() {
            markWasmReady();
            if (!wasmReady) {
                throw new Error('Encryption module still loading.');
            }
        }

        function ensurePeerSessionReady(peer) {
            ensureWasmReady();
            if (!peer.sessionKeyReady) {
                throw new Error('Session key not established — complete signaling first.');
            }
        }

        /*
         * CyberKnot's WASM module holds exactly ONE active session key at a
         * time (see src/bridge.c: static session_pswd/session_pswd_active).
         * To support several concurrent peers, we install the correct
         * peer's key immediately before each encrypt/decrypt call,
         * synchronously with no `await` in between — safe because JS is
         * single-threaded and these calls never yield control mid-operation,
         * and because each encrypt call generates its own fresh random IV
         * internally rather than using a shared counter, so switching keys
         * between peers introduces no IV-reuse risk. This function and the
         * cipher calls it wraps are otherwise byte-for-byte the same as the
         * original single-peer implementation.
         */
        function loadKeyIntoWasm(peerId, hexPassword) {
            ensureWasmReady();
            if (activeWasmKeyPeerId === peerId) return;
            const ptr = Module.allocateUTF8(hexPassword);
            try {
                const rc = Module._bridge_set_session_key(ptr, hexPassword.length);
                if (rc !== 0) {
                    throw new Error(`Failed to install session key in WASM (len=${hexPassword.length}). Rebuild cyberknot.js.`);
                }
                activeWasmKeyPeerId = peerId;
            } finally {
                Module._free(ptr);
            }
        }

        async function establishSessionKey(peer, peerPubKeyB64) {
            peer.peerPubKey = await importPublicKeyB64(peerPubKeyB64);
            peer.peerPubKeyB64 = peerPubKeyB64;
            const myKeyPair = myKeyPairFor(peer);
            peer.sessionKeyHex = await deriveSessionPassword(myKeyPair.privateKey, peer.peerPubKey, getRoomSecret());
            loadKeyIntoWasm(peer.connId, peer.sessionKeyHex);
            peer.sessionKeyReady = true;
            updateSecurityPanel();
            flushPendingIncoming(peer);
            addMessage(`Unique session encryption key established${peer.name ? ' with ' + peer.name : ''}.`, 'system');
            /*
             * Safety-number display only — this NEVER feeds into
             * deriveSessionPassword or the WASM cipher above. It exists
             * purely so a human can catch a relay that substituted a key
             * during the automated handshake. Skipping or failing this
             * check cannot weaken the actual encryption in any way.
             */
            try {
                const myPubKeyB64 = await exportPublicKeyB64(myKeyPair.publicKey);
                await displaySafetyNumber(peer, myPubKeyB64, peerPubKeyB64);
            } catch (err) {
                console.error('Safety number computation failed:', err);
                addMessage('Could not compute safety check — verify identity by other means before sending sensitive data.', 'system');
            }
        }

        /*
         * Short Authentication String (safety number). Hashes both public
         * keys together in a fixed, order-independent way so both sides
         * compute the identical value — if a relay swapped either key in
         * transit, the two sides will see different codes.
         * This is verification tooling only; it is not part of the
         * cryptographic key schedule and cannot be used to derive or
         * weaken the session key.
         */
        async function computeSafetyNumber(pubKeyB64A, pubKeyB64B) {
            const bytesA = base64ToUint8Array(pubKeyB64A);
            const bytesB = base64ToUint8Array(pubKeyB64B);
            const strA = Array.from(bytesA).map((b) => String.fromCharCode(b)).join('');
            const strB = Array.from(bytesB).map((b) => String.fromCharCode(b)).join('');
            const [first, second] = strA <= strB ? [strA, strB] : [strB, strA];
            const combined = new TextEncoder().encode(first + '|' + second);
            const digest = await crypto.subtle.digest('SHA-256', combined);
            const view = new DataView(digest);
            const num = view.getUint32(0) % 1000000;
            return String(num).padStart(6, '0');
        }

        async function displaySafetyNumber(peer, myPubKeyB64, peerPubKeyB64) {
            const code = await computeSafetyNumber(myPubKeyB64, peerPubKeyB64);
            peer.safetyCode = code.slice(0, 3) + ' ' + code.slice(3);
            peer.safetyConfirmed = false;
            updateSecurityPanel();
        }

        function encryptMessageFor(peer, plainText) {
            ensurePeerSessionReady(peer);
            if (Module.lengthBytesUTF8(plainText) > ENCRYPT_MAX_PLAIN) {
                throw new Error(`Encrypted payload too large (${Module.lengthBytesUTF8(plainText)} > ${ENCRYPT_MAX_PLAIN} bytes)`);
            }
            loadKeyIntoWasm(peer.connId, peer.sessionKeyHex);
            const len = Module.lengthBytesUTF8(plainText);
            const ptrIn = Module.allocateUTF8(plainText);
            try {
                const ptrOut = Module._bridge_encrypt_b64(ptrIn, len);
                if (!ptrOut) throw new Error('Encryption failed');
                const encrypted = Module.UTF8ToString(ptrOut);
                if (!encrypted) throw new Error('Encryption failed (payload too large?)');
                return encrypted;
            } finally {
                Module._free(ptrIn);
            }
        }

        function decryptMessageFor(peer, b64String) {
            ensurePeerSessionReady(peer);
            loadKeyIntoWasm(peer.connId, peer.sessionKeyHex);
            const ptrIn = Module.allocateUTF8(b64String);
            try {
                const ptrOut = Module._bridge_decrypt_b64(ptrIn);
                if (!ptrOut) throw new Error('Decryption failed');
                const decrypted = Module.UTF8ToString(ptrOut);
                if (!decrypted && b64String) throw new Error('Decryption failed — wrong session key?');
                return decrypted;
            } finally {
                Module._free(ptrIn);
            }
        }

        function sendSecure(peer, innerPayload) {
            ensurePeerSessionReady(peer);
            if (!peer.dc || peer.dc.readyState !== 'open') {
                throw new Error('P2P channel not open.');
            }
            peer.dc.send(JSON.stringify({
                type: 'secure',
                data: encryptMessageFor(peer, JSON.stringify(innerPayload))
            }));
        }

        /*
         * Host-hub fan-out: in this build, guests connect only to the host
         * (a star topology), not to each other. When the host receives a
         * message from one guest, it re-encrypts it once per other
         * connected guest and forwards it, so everyone in the room sees
         * everyone else. The untrusted relay server is never involved in
         * this — it is a normal, expected act of a legitimate participant
         * (the host) relaying to other legitimate participants, not the
         * opaque keyserver relay reading content.
         */
        function broadcastToOthers(exceptConnId, innerPayload) {
            for (const [connId, otherPeer] of peers.entries()) {
                if (connId === exceptConnId) continue;
                if (!peerCanSend(otherPeer)) continue;
                try {
                    sendSecure(otherPeer, innerPayload);
                } catch (err) {
                    console.error(`Fan-out to ${otherPeer.name || connId} failed:`, err);
                }
            }
        }

        // Participants roster: a guest's only direct connection is to the
        // host, so guests have no inherent visibility into who else is in
        // the room. The host computes the current list (itself + every
        // guest whose encrypted channel is up) and pushes it to everyone
        // whenever membership changes; guests just render whatever they're
        // sent. Deliberately gated on peerReadyForSafetyConfirm rather than
        // the stricter peerCanSend: names/presence aren't sensitive content,
        // and requiring the HOST to also manually click "Confirm — codes
        // match" for a guest before that guest could even see who else was
        // in the room (peerCanSend needs BOTH sides to confirm) meant the
        // roster often never arrived at all.
        function currentParticipantNames() {
            const names = ['Host'];
            for (const peer of peers.values()) {
                if (peerReadyForSafetyConfirm(peer) && peer.name) names.push(peer.name);
            }
            return names;
        }

        function renderParticipantsList(names) {
            const list = document.getElementById('participants-list');
            if (!list) return;
            list.innerHTML = '';
            for (const name of names) {
                const row = document.createElement('div');
                row.className = 'participant-row';
                row.textContent = name;
                list.appendChild(row);
            }
        }

        function refreshRoster() {
            if (inviteRole !== 'host') return;
            const participants = currentParticipantNames();
            renderParticipantsList(participants);
            for (const peer of peers.values()) {
                if (!peerReadyForSafetyConfirm(peer)) continue;
                try {
                    sendSecure(peer, { type: 'roster', participants });
                } catch (err) {
                    console.error(`Roster send to ${peer.name || peer.connId} failed:`, err);
                }
            }
        }

        function handleIncomingPayload(peer, payload) {
            // In the star topology, a guest's only direct connection is to the
            // host, so a message the host relays from a DIFFERENT guest arrives
            // over that same connection. payload.senderName (attached below,
            // only when the host fans a message out to other guests) tells the
            // receiving side who actually wrote it; otherwise a message is
            // assumed to be from whichever peer this connection belongs to
            // (the host's own message, on a guest's screen — no tag needed
            // there) or, on the host's own screen, from that connected guest.
            const fromLabel = payload.senderName || (inviteRole === 'host' ? peer.name : null);
            const relay = (extra) => {
                if (inviteRole === 'host') broadcastToOthers(peer.connId, { ...payload, ...extra, senderName: fromLabel });
            };
            if (payload.type === 'msg') {
                addMessage(payload.data, 'received', fromLabel);
                relay();
            } else if (payload.type === 'msg-start') {
                incomingMessages.set(payload.id, {
                    totalChunks: payload.totalChunks,
                    chunks: new Array(payload.totalChunks),
                    received: 0
                });
                relay();
            } else if (payload.type === 'msg-chunk') {
                handleMsgChunk(payload, fromLabel);
                relay();
            } else if (payload.type === 'file') {
                addFileMessage(payload.name, payload.size, payload.data, fromLabel);
                relay();
            } else if (payload.type === 'file2-start') {
                incomingFiles.set(payload.id, {
                    id: payload.id,
                    name: payload.name,
                    size: payload.size,
                    totalChunks: payload.totalChunks,
                    chunks: new Array(payload.totalChunks),
                    received: 0,
                    version: 2,
                    fromLabel
                });
                relay();
            } else if (payload.type === 'file-start') {
                incomingFiles.set(payload.id, {
                    name: payload.name,
                    size: payload.size,
                    totalChunks: payload.totalChunks,
                    chunks: new Array(payload.totalChunks),
                    received: 0
                });
                relay();
            } else if (payload.type === 'file-chunk') {
                handleFileChunk(payload, fromLabel);
                relay();
            } else if (payload.type === 'file-blob-ref') {
                downloadBlobFile(peer, payload).catch((err) => {
                    addMessage(`File download failed: ${err.message}`, 'system');
                });
                if (inviteRole === 'host') {
                    forwardBlobRefToOthers(peer.connId, payload, fromLabel).catch((err) => {
                        console.error('Blob ref fan-out failed:', err);
                    });
                }
            } else if (payload.type === 'roster') {
                renderParticipantsList(payload.participants);
            } else {
                throw new Error(`Unknown message type: ${payload.type}`);
            }
        }

        function handleSecureEnvelope(peer, envelope) {
            if (envelope.type !== 'secure') {
                throw new Error('Rejected unencrypted message.');
            }
            const inner = JSON.parse(decryptMessageFor(peer, envelope.data));
            handleIncomingPayload(peer, inner);
        }

        function handleFileChunk(payload, fromLabel) {
            const state = incomingFiles.get(payload.id);
            if (!state) {
                throw new Error('File chunk received without file-start metadata.');
            }
            state.chunks[payload.index] = base64ToUint8Array(payload.data);
            state.received += 1;
            if (state.received === state.totalChunks) {
                finalizeIncomingFile({ ...state, id: payload.id, fromLabel });
                incomingFiles.delete(payload.id);
            }
        }

        function handleMsgChunk(payload, fromLabel) {
            const state = incomingMessages.get(payload.id);
            if (!state) {
                throw new Error('Message chunk received without msg-start metadata.');
            }
            state.chunks[payload.index] = payload.data;
            state.received += 1;
            if (state.received === state.totalChunks) {
                addMessage(state.chunks.join(''), 'received', fromLabel);
                incomingMessages.delete(payload.id);
            }
        }

        function splitTextIntoChunks(text, maxBytes) {
            const bytes = new TextEncoder().encode(text);
            if (bytes.length <= maxBytes) return [text];
            const chunks = [];
            let offset = 0;
            while (offset < bytes.length) {
                let end = Math.min(offset + maxBytes, bytes.length);
                while (end > offset && end < bytes.length && (bytes[end] & 0xC0) === 0x80) {
                    end -= 1;
                }
                chunks.push(new TextDecoder().decode(bytes.subarray(offset, end)));
                offset = end;
            }
            return chunks;
        }

        function innerPayloadByteLength(payload) {
            return Module.lengthBytesUTF8(JSON.stringify(payload));
        }

        // When the host relays a message on to other guests it adds a
        // senderName field (see handleIncomingPayload) so those guests can
        // show who actually wrote it. Leave headroom here so a message that
        // just barely fit as a single payload doesn't blow past
        // ENCRYPT_MAX_PLAIN once that field is added during relay.
        const RELAY_SENDER_NAME_MARGIN = 128;

        function sendTextPayload(text, readyPeers) {
            const singlePayload = { type: 'msg', data: text };
            if (innerPayloadByteLength(singlePayload) <= ENCRYPT_MAX_PLAIN - RELAY_SENDER_NAME_MARGIN) {
                for (const peer of readyPeers) {
                    sendSecure(peer, singlePayload);
                }
                return;
            }

            const chunks = splitTextIntoChunks(text, TEXT_CHUNK_SIZE);
            const id = crypto.randomUUID();
            const totalChunks = chunks.length;
            for (const peer of readyPeers) {
                sendSecure(peer, { type: 'msg-start', id, totalChunks });
            }
            for (let index = 0; index < totalChunks; index += 1) {
                const chunkPayload = { type: 'msg-chunk', id, index, data: chunks[index] };
                if (innerPayloadByteLength(chunkPayload) > ENCRYPT_MAX_PLAIN) {
                    throw new Error('Message chunk too large for encryption — try a shorter message.');
                }
                for (const peer of readyPeers) {
                    sendSecure(peer, chunkPayload);
                }
            }
        }

        function addFileMessage(fileName, fileSize, b64Data, senderName = null) {
            const blob = new Blob([base64ToUint8Array(b64Data)]);
            addFileMessageBlob(fileName, fileSize, blob, senderName);
        }

        function addFileMessageBlob(fileName, fileSize, blob, senderName = null) {
            const div = document.createElement('a');
            div.className = 'msg file received';
            const label = `📁 ${fileName} (${formatBytes(fileSize)}) - Click to download`;
            div.textContent = senderName ? `${senderName}: ${label}` : label;
            div.href = URL.createObjectURL(blob);
            div.download = fileName;
            chatBox.appendChild(div);
            chatBox.scrollTop = chatBox.scrollHeight;
        }

        function addFileSentNotice(fileName, fileSize) {
            addMessage(`File sent: ${fileName} (${formatBytes(fileSize)})`, 'sent');
        }

        async function waitForDcDrain(dc, maxBuffered = FILE_DC_MAX_BUFFERED) {
            while (dc.bufferedAmount > maxBuffered) {
                if (dc.readyState !== 'open') {
                    throw new Error('P2P channel closed during file transfer.');
                }
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
        }

        async function deriveFileAesKey(peer, fileId) {
            const cacheKey = fileKeyCacheKey(peer, fileId);
            if (fileAesKeyCache.has(cacheKey)) {
                return fileAesKeyCache.get(cacheKey);
            }
            ensurePeerSessionReady(peer);
            const enc = new TextEncoder();
            const rawKey = hexToBytes(peer.sessionKeyHex);
            const hkdfKey = await crypto.subtle.importKey('raw', rawKey, 'HKDF', false, ['deriveKey']);
            const aesKey = await crypto.subtle.deriveKey(
                {
                    name: 'HKDF',
                    hash: 'SHA-256',
                    salt: enc.encode(fileId),
                    info: enc.encode('AegisSecureFile-v2')
                },
                hkdfKey,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt', 'decrypt']
            );
            fileAesKeyCache.set(cacheKey, aesKey);
            return aesKey;
        }

        async function sendSecureFileChunk(peer, fileId, index, plainBytes) {
            ensurePeerSessionReady(peer);
            if (!peer.dc || peer.dc.readyState !== 'open') {
                throw new Error('P2P channel not open.');
            }
            const key = await deriveFileAesKey(peer, fileId);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes);
            await waitForDcDrain(peer.dc);
            peer.dc.send(JSON.stringify({
                type: 'secure-file',
                id: fileId,
                index,
                iv: uint8ArrayToBase64(iv),
                ct: uint8ArrayToBase64(new Uint8Array(ciphertext))
            }));
        }

        async function forwardFileChunkToOthers(fromConnId, fileId, index, plainBytes) {
            for (const [connId, otherPeer] of peers.entries()) {
                if (connId === fromConnId || !peerCanSend(otherPeer)) continue;
                try {
                    await sendSecureFileChunk(otherPeer, fileId, index, plainBytes);
                } catch (err) {
                    console.error(`File fan-out to ${otherPeer.name || connId} failed:`, err);
                }
            }
        }

        function finalizeIncomingFile(state) {
            const merged = new Uint8Array(state.chunks.reduce((sum, chunk) => sum + chunk.length, 0));
            let offset = 0;
            for (const chunk of state.chunks) {
                merged.set(chunk, offset);
                offset += chunk.length;
            }
            addFileMessageBlob(state.name, state.size, new Blob([merged]), state.fromLabel);
        }

        function handleFile2Chunk(state, index, bytes) {
            if (state.chunks[index]) return;
            state.chunks[index] = bytes;
            state.received += 1;
            if (state.received === state.totalChunks) {
                finalizeIncomingFile(state);
                incomingFiles.delete(state.id);
            }
        }

        async function handleSecureFileEnvelope(peer, envelope) {
            if (envelope.type !== 'secure-file') {
                throw new Error('Invalid secure file envelope.');
            }
            const state = incomingFiles.get(envelope.id);
            if (!state || state.version !== 2) {
                throw new Error('File chunk received without file2-start metadata.');
            }
            const key = await deriveFileAesKey(peer, envelope.id);
            const plain = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: base64ToUint8Array(envelope.iv) },
                key,
                base64ToUint8Array(envelope.ct)
            );
            const bytes = new Uint8Array(plain);
            if (inviteRole === 'host') {
                await forwardFileChunkToOthers(peer.connId, envelope.id, envelope.index, bytes);
            }
            handleFile2Chunk(state, envelope.index, bytes);
        }

        async function streamFileChunks(file, chunkSize, onChunk) {
            if (typeof file.stream === 'function') {
                const reader = file.stream().getReader();
                let carry = new Uint8Array(0);
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        if (carry.length > 0) await onChunk(carry);
                        break;
                    }
                    const combined = new Uint8Array(carry.length + value.length);
                    combined.set(carry);
                    combined.set(value, carry.length);
                    carry = combined;
                    let offset = 0;
                    while (offset + chunkSize <= carry.length) {
                        await onChunk(carry.subarray(offset, offset + chunkSize));
                        offset += chunkSize;
                    }
                    carry = carry.subarray(offset);
                }
                return;
            }
            const buffer = await file.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            for (let offset = 0; offset < bytes.length; offset += chunkSize) {
                await onChunk(bytes.subarray(offset, offset + chunkSize));
            }
        }

        async function wrapFileKeyForPeer(peer, blobId, rawFileKey) {
            const wrapKey = await deriveFileAesKey(peer, `keywrap:${blobId}`);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, rawFileKey);
            return {
                keyIv: uint8ArrayToBase64(iv),
                keyCt: uint8ArrayToBase64(new Uint8Array(wrapped))
            };
        }

        async function importFileKeyFromWrap(peer, blobId, keyIv, keyCt) {
            const wrapKey = await deriveFileAesKey(peer, `keywrap:${blobId}`);
            const plain = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: base64ToUint8Array(keyIv) },
                wrapKey,
                base64ToUint8Array(keyCt)
            );
            return crypto.subtle.importKey('raw', plain, 'AES-GCM', false, ['encrypt', 'decrypt']);
        }

        async function encryptFilePart(fileKey, plainBytes) {
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, fileKey, plainBytes);
            const out = new Uint8Array(12 + ct.byteLength);
            out.set(iv, 0);
            out.set(new Uint8Array(ct), 12);
            return out;
        }

        async function decryptFilePart(fileKey, encryptedBytes) {
            const iv = encryptedBytes.subarray(0, 12);
            const ct = encryptedBytes.subarray(12);
            const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, fileKey, ct);
            return new Uint8Array(plain);
        }

        async function uploadBlobPart(blobId, token, partIndex, body) {
            const response = await fetch(`/api/v1/blobs/${blobId}/parts/${partIndex}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'X-Blob-Token': token
                },
                body
            });
            if (!response.ok) {
                const errText = await response.text();
                throw new Error(errText || `Upload part ${partIndex} failed (${response.status})`);
            }
        }

        async function downloadBlobPart(blobId, token, partIndex) {
            const response = await fetch(`/api/v1/blobs/${blobId}/parts/${partIndex}`, {
                headers: { 'X-Blob-Token': token }
            });
            if (!response.ok) {
                throw new Error(`Download part ${partIndex} failed (${response.status})`);
            }
            return new Uint8Array(await response.arrayBuffer());
        }

        async function forwardBlobRefToOthers(fromConnId, payload, senderName) {
            const rawKey = await importFileKeyFromWrap(
                peers.get(fromConnId),
                payload.blobId,
                payload.keyIv,
                payload.keyCt
            );
            const rawFileKey = new Uint8Array(await crypto.subtle.exportKey('raw', rawKey));
            for (const [connId, otherPeer] of peers.entries()) {
                if (connId === fromConnId || !peerCanSend(otherPeer)) continue;
                const wrapped = await wrapFileKeyForPeer(otherPeer, payload.blobId, rawFileKey);
                sendSecure(otherPeer, {
                    type: 'file-blob-ref',
                    blobId: payload.blobId,
                    name: payload.name,
                    size: payload.size,
                    totalParts: payload.totalParts,
                    token: payload.token,
                    keyIv: wrapped.keyIv,
                    keyCt: wrapped.keyCt,
                    senderName: senderName || undefined
                });
            }
        }

        async function downloadBlobFile(peer, payload) {
            const fileKey = await importFileKeyFromWrap(peer, payload.blobId, payload.keyIv, payload.keyCt);
            const parts = [];
            for (let i = 0; i < payload.totalParts; i += 1) {
                const encrypted = await downloadBlobPart(payload.blobId, payload.token, i);
                parts.push(await decryptFilePart(fileKey, encrypted));
            }
            const merged = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
            let offset = 0;
            for (const part of parts) {
                merged.set(part, offset);
                offset += part.length;
            }
            const blobFromLabel = payload.senderName || (inviteRole === 'host' ? peer.name : null);
            addFileMessageBlob(payload.name, payload.size, new Blob([merged]), blobFromLabel);
            addMessage(`Received file via encrypted relay: ${payload.name} (${formatBytes(payload.size)})`, 'received', blobFromLabel);
        }

        async function sendFileBlobStore(file, onProgress) {
            const fileName = file.name;
            const fileSize = file.size;
            if (fileSize > FILE_BLOB_MAX_BYTES) {
                throw new Error(`File exceeds ${formatBytes(FILE_BLOB_MAX_BYTES)} relay limit.`);
            }
            const readyPeers = [...peers.values()].filter(peerCanSend);
            if (readyPeers.length === 0) {
                throw new Error('No connected peer to send the file to.');
            }

            const blobId = crypto.randomUUID();
            const token = generateRandomSecret(32);
            const totalParts = Math.max(1, Math.ceil(fileSize / FILE_BLOB_PART_BYTES));
            const rawFileKey = crypto.getRandomValues(new Uint8Array(32));
            const fileKey = await crypto.subtle.importKey('raw', rawFileKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
            const proof = await makeBlobProof(blobId, 'init');

            const initRes = await fetch('/api/v1/blobs/init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    inviteId: currentInviteId,
                    blobId,
                    name: fileName,
                    size: fileSize,
                    totalParts,
                    token,
                    proof
                })
            });
            if (!initRes.ok) {
                throw new Error((await initRes.json()).error || 'Blob init failed');
            }

            addMessage(`Uploading encrypted file to relay (${formatBytes(fileSize)}, ${totalParts} parts)…`, 'system');
            const startMs = Date.now();
            let partIndex = 0;
            await streamFileChunks(file, FILE_BLOB_PART_BYTES, async (chunk) => {
                const encrypted = await encryptFilePart(fileKey, chunk);
                await uploadBlobPart(blobId, token, partIndex, encrypted);
                if (onProgress) {
                    const elapsedSec = Math.max(0.001, (Date.now() - startMs) / 1000);
                    const partsPerSec = partIndex > 0 ? partIndex / elapsedSec : FILE_BLOB_PARTS_PER_SEC_EST;
                    onProgress({
                        index: partIndex + 1,
                        totalChunks: totalParts,
                        etaSeconds: (totalParts - partIndex - 1) / partsPerSec
                    });
                }
                partIndex += 1;
            });

            const completeRes = await fetch(`/api/v1/blobs/${blobId}/complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, totalParts })
            });
            if (!completeRes.ok) {
                throw new Error((await completeRes.json()).error || 'Blob complete failed');
            }

            for (const peer of readyPeers) {
                const wrapped = await wrapFileKeyForPeer(peer, blobId, rawFileKey);
                sendSecure(peer, {
                    type: 'file-blob-ref',
                    blobId,
                    name: fileName,
                    size: fileSize,
                    totalParts,
                    token,
                    keyIv: wrapped.keyIv,
                    keyCt: wrapped.keyCt
                });
            }

            if (onProgress) {
                onProgress({ index: totalParts, totalChunks: totalParts, etaSeconds: 0 });
            }
            addFileSentNotice(fileName, fileSize);
            addMessage(`Encrypted relay upload complete — peers notified via secure channel.`, 'system');
        }

        async function sendFileP2Pv2(file, onProgress) {
            const fileName = file.name;
            const fileSize = file.size;
            if (fileSize > FILE_P2P_MAX_BYTES) {
                throw new Error(`File exceeds ${formatBytes(FILE_P2P_MAX_BYTES)} P2P limit — use hybrid mode for larger files.`);
            }
            const id = crypto.randomUUID();
            const totalChunks = Math.max(1, Math.ceil(fileSize / FILE_P2P_CHUNK_BYTES));
            const readyPeers = [...peers.values()].filter(peerCanSend);
            if (readyPeers.length === 0) {
                throw new Error('No connected peer to send the file to.');
            }

            for (const peer of readyPeers) {
                sendSecure(peer, {
                    type: 'file2-start',
                    id,
                    name: fileName,
                    size: fileSize,
                    totalChunks,
                    mode: FILE_TRANSFER_MODE
                });
            }

            const startMs = Date.now();
            let chunkIndex = 0;
            await streamFileChunks(file, FILE_P2P_CHUNK_BYTES, async (chunk) => {
                for (const peer of readyPeers) {
                    await sendSecureFileChunk(peer, id, chunkIndex, chunk);
                }
                if (onProgress && (chunkIndex === 0 || chunkIndex % 16 === 0)) {
                    const elapsedSec = Math.max(0.001, (Date.now() - startMs) / 1000);
                    const chunksPerSec = chunkIndex > 0 ? chunkIndex / elapsedSec : FILE_SEND_CHUNKS_PER_SEC_EST;
                    onProgress({
                        index: chunkIndex + 1,
                        totalChunks,
                        etaSeconds: (totalChunks - chunkIndex - 1) / chunksPerSec,
                    });
                }
                chunkIndex += 1;
            });

            if (onProgress) {
                onProgress({ index: totalChunks, totalChunks, etaSeconds: 0 });
            }
            addFileSentNotice(fileName, fileSize);
        }

        async function sendFileBufferLegacy(fileName, fileSize, bytes, onProgress) {
            const id = crypto.randomUUID();
            const totalChunks = Math.max(1, Math.ceil(bytes.length / FILE_LEGACY_CHUNK_SIZE));
            const readyPeers = [...peers.values()].filter(peerCanSend);
            if (readyPeers.length === 0) {
                throw new Error('No connected peer to send the file to.');
            }

            for (const peer of readyPeers) {
                sendSecure(peer, { type: 'file-start', id, name: fileName, size: fileSize, totalChunks });
            }

            const startMs = Date.now();
            for (let index = 0; index < totalChunks; index += 1) {
                const start = index * FILE_LEGACY_CHUNK_SIZE;
                const chunk = bytes.subarray(start, start + FILE_LEGACY_CHUNK_SIZE);
                const chunkPayload = { type: 'file-chunk', id, index, data: uint8ArrayToBase64(chunk) };
                for (const peer of readyPeers) {
                    sendSecure(peer, chunkPayload);
                }

                if (onProgress && (index === 0 || index % 200 === 0 || index === totalChunks - 1)) {
                    const elapsedSec = Math.max(0.001, (Date.now() - startMs) / 1000);
                    const chunksPerSec = index > 0 ? index / elapsedSec : FILE_SEND_CHUNKS_PER_SEC_EST;
                    onProgress({
                        index: index + 1,
                        totalChunks,
                        etaSeconds: (totalChunks - index - 1) / chunksPerSec,
                    });
                }

                if (index % 50 === 0) {
                    await yieldToEventLoop();
                }
            }

            addFileSentNotice(fileName, fileSize);
        }

        async function sendFile(file, onProgress) {
            if (FILE_TRANSFER_MODE === 'hybrid' && file.size > FILE_BLOB_THRESHOLD_BYTES) {
                return sendFileBlobStore(file, onProgress);
            }
            if (FILE_TRANSFER_MODE === 'blob-store') {
                return sendFileBlobStore(file, onProgress);
            }
            if (FILE_TRANSFER_MODE === 'p2p-v2' || FILE_TRANSFER_MODE === 'hybrid') {
                return sendFileP2Pv2(file, onProgress);
            }
            const buffer = await file.arrayBuffer();
            return sendFileBufferLegacy(file.name, file.size, new Uint8Array(buffer), onProgress);
        }

        function updateStatusDot() {
            const anyOpen = [...peers.values()].some((p) => p.dc && p.dc.readyState === 'open');
            statusDot.classList.toggle('connected', anyOpen);
        }

        function closePeer(connId) {
            const peer = peers.get(connId);
            if (!peer) return;
            peer.closing = true;
            stopPeerConnectWatchdog(peer);
            stopPeerHeartbeat(peer);
            stopFingerprintVerificationPoll(peer);
            if (peer.dc) {
                try { peer.dc.close(); } catch (_) { /* already closed */ }
            }
            if (peer.pc) {
                try { peer.pc.close(); } catch (_) { /* already closed */ }
            }
            if (activeWasmKeyPeerId === connId) {
                if (typeof Module._bridge_clear_session_key === 'function') {
                    Module._bridge_clear_session_key();
                }
                activeWasmKeyPeerId = null;
            }
            peers.delete(connId);
            updateStatusDot();
            updateSecurityPanel();
        }

        function closeAllPeers() {
            for (const connId of [...peers.keys()]) closePeer(connId);
            hostEcdhKeyPair = null;
            incomingFiles.clear();
            incomingMessages.clear();
            clearFileKeyCache();
            keyTransparencyOk = false;
            signalArea.value = '';
            updateSecurityPanel();
        }

        function resetConnection() {
            closeAllPeers();
            chatBox.innerHTML = '';

            // Clear the invite session so a stale link can't be reused, and
            // let the host create a fresh one.
            currentInviteId = null;
            inviteRole = null;
            roomSecretInput.value = '';
            guestInviteLinkArea.value = '';
            copyGuestLinkBtn.disabled = true;
            createInviteBtn.disabled = false;
            history.replaceState(null, '', location.pathname);

            waitingGuests.clear();
            renderWaitingRoom();
            renderParticipantsList([]);

            updateSecurityPanel();
            addMessage('Connection reset. All peers disconnected.', 'system');
        }


        function showPeerFingerprint(peer, fingerprint) {
            peer.expectedFingerprint = fingerprint;
            peer.fingerprintVerified = false;
            updateSecurityPanel();
            startFingerprintVerificationPoll(peer);
        }

        function sdpHasRelayCandidate(sdp) {
            return /\styp relay /i.test(sdp || '');
        }

        function waitForIceGatheringComplete(pc, timeoutMs = 10000) {
            const waitMs = isMobileSafari() ? Math.max(timeoutMs, 20000) : timeoutMs;
            return new Promise((resolve) => {
                if (pc.iceGatheringState === 'complete') {
                    resolve();
                    return;
                }
                const done = () => {
                    pc.removeEventListener('icegatheringstatechange', onChange);
                    resolve();
                };
                const onChange = () => {
                    if (pc.iceGatheringState === 'complete') done();
                };
                pc.addEventListener('icegatheringstatechange', onChange);
                setTimeout(done, waitMs);
            });
        }

        async function waitForIceGatheringAndRelay(pc, timeoutMs = 10000) {
            const gatherMs = iceConfigHasTurn(iceConfigCache)
                ? Math.max(timeoutMs, 15000)
                : timeoutMs;
            await waitForIceGatheringComplete(pc, gatherMs);
            if (!iceConfigHasTurn(iceConfigCache)) return;

            const deadline = Date.now() + 8000;
            while (Date.now() < deadline) {
                const sdp = pc.localDescription?.sdp || '';
                if (sdpHasRelayCandidate(sdp)) return;
                if (pc.iceGatheringState === 'complete') {
                    await new Promise((resolve) => setTimeout(resolve, 400));
                    if (sdpHasRelayCandidate(pc.localDescription?.sdp || '')) return;
                }
                await new Promise((resolve) => setTimeout(resolve, 300));
            }
            if (!sdpHasRelayCandidate(pc.localDescription?.sdp || '')) {
                addMessage(
                    'No TURN relay candidates gathered — P2P may fail until server TURN is configured (Metered API on Railway).',
                    'system'
                );
            }
        }

        async function retryPeerIce(peer, relayOnly = false) {
            if (!peer.pc || peer.pc.connectionState === 'closed') return false;
            await loadIceConfig(true);
            const cfg = await buildRtcConfig();
            if (relayOnly && iceConfigHasTurn(iceConfigCache)) {
                cfg.iceTransportPolicy = 'relay';
            }
            try {
                peer.pc.setConfiguration(cfg);
                if (peer.isInitiator && typeof peer.pc.restartIce === 'function') {
                    peer.pc.restartIce();
                }
                flushPendingLocalIce(peer);
                return true;
            } catch (err) {
                console.warn('ICE restart failed:', err);
                return false;
            }
        }

        async function publishLocalSignal(peer, label) {
            if (!peer.pc?.localDescription) {
                throw new Error('Cannot publish signal — connection not ready.');
            }
            const myKeyPair = myKeyPairFor(peer);
            if (!myKeyPair) {
                throw new Error('Cannot publish signal — no local key pair yet.');
            }
            const fp = extractDtlsFingerprint(peer.pc.localDescription.sdp);
            const aegisMeta = {
                pubKey: await exportPublicKeyB64(myKeyPair.publicKey),
                dtlsFingerprint: fp,
                inviteId: currentInviteId
            };
            const wrapped = await wrapSignal(peer.pc.localDescription, aegisMeta);
            peer.publishedSignal = wrapped; /* authoritative — read this, not the shared textarea */
            signalArea.value = wrapped;     /* informational only, for the manual-fallback UI */
            signalArea.scrollTop = 0;
            peer.signalPublished = true;
            flushPendingLocalIce(peer);
            addMessage(`${label} ready${peer.name ? ' for ' + peer.name : ''} — select all (Cmd+A) and copy if using manual signaling.`, 'system');
            return wrapped;
        }

        function bindIceCandidateHandler(peer) {
            peer.remoteIceQueue = peer.remoteIceQueue || [];
            peer.pendingLocalIce = peer.pendingLocalIce || [];
            peer.pc.onicecandidate = async (event) => {
                if (event.candidate) {
                    const init = event.candidate.toJSON();
                    if (peer.trickleIce) {
                        if (peer.signalPublished) {
                            sendRelayIceCandidate(peer, init);
                        } else {
                            peer.pendingLocalIce.push(init);
                        }
                    }
                    return;
                }
                peer.iceGatheringDone = true;
                if (!peer.signalPublished && peer.pc.localDescription) {
                    const label = peer.pc.localDescription.type === 'offer' ? 'Offer' : 'Answer';
                    await publishLocalSignal(peer, label);
                }
            };
        }

        createInviteBtn.onclick = () => {
            try {
                createInviteSession();
            } catch (err) {
                addMessage(`Create invite failed: ${err.message}`, 'system');
            }
        };

        copyGuestLinkBtn.onclick = async () => {
            const link = guestInviteLinkArea.value.trim();
            if (!link) return;
            try {
                await navigator.clipboard.writeText(link);
                addMessage('Guest invite link copied to clipboard.', 'system');
            } catch (_) {
                guestInviteLinkArea.select();
                addMessage('Copy the guest link manually from the text box.', 'system');
            }
        };

        document.getElementById('reset-btn').onclick = resetConnection;

        /*
         * Creates one new peer connection and returns its wrapped offer
         * string directly (not via the shared textarea) so the caller can
         * route it to the correct guest over the relay without any risk of
         * cross-contamination if another guest's handshake is in flight at
         * the same time. Host only. The host's ECDH keypair is generated
         * once and reused for every guest — this is cryptographically
         * sound because each guest still contributes its own distinct
         * public key, so ECDH(hostPriv, guestAPub) and ECDH(hostPriv,
         * guestBPub) are different shared secrets even with one host key.
         */
        async function generateOffer(connId, name) {
            if (inviteRole !== 'host') {
                throw new Error('Only the host (Create Invite tab) can connect. Guests paste the offer.');
            }
            if (!currentInviteId || !roomSecretValid()) {
                throw new Error('Create an invite link first.');
            }
            if (peers.size >= MAX_ACTIVE_GUESTS_CLIENT) {
                throw new Error(`Already at the ${MAX_ACTIVE_GUESTS_CLIENT}-guest limit.`);
            }

            // A guest who closed their browser and reopened the same invite link
            // shows up here as a brand-new connId with the same display name.
            // Their old connection may not be cleanly closed yet — ICE disconnect
            // detection can lag well behind an abrupt tab close — so a stale peer
            // can linger in `peers` with a data channel that still looks open. If
            // a late/buffered frame arrives on that zombie channel after the
            // shared WASM key slot (activeWasmKeyPeerId) has moved on to a
            // different peer, it gets decrypted with the wrong key and surfaces
            // as a garbled "Error receiving message: JSON Parse error". Close any
            // stale peer with the same name before setting up the new one.
            if (name) {
                for (const [staleId, stalePeer] of [...peers.entries()]) {
                    if (staleId !== connId && stalePeer.name === name) {
                        addMessage(`Closing previous connection for ${name} (reconnected).`, 'system');
                        closePeer(staleId);
                    }
                }
            }

            const peer = makePeer(connId, name);
            peers.set(connId, peer);
            peer.isInitiator = true;

            if (!hostEcdhKeyPair) {
                hostEcdhKeyPair = await generateEcdhKeyPair();
                const hostPubKey = await exportPublicKeyB64(hostEcdhKeyPair.publicKey);
                try {
                    await registerPublicKey('host', hostPubKey);
                } catch (err) {
                    addMessage(`Key transparency: ${err.message}`, 'system');
                    peers.delete(connId);
                    throw err;
                }
            }

            peer.pc = new RTCPeerConnection(await buildRtcConfig());
            peer.trickleIce = relayTrickleEnabled();
            bindConnectionSecurityHandlers(peer.pc, peer);
            peer.dc = peer.pc.createDataChannel('aegis-secure', { ordered: true });
            setupDataChannel(peer, connId);
            bindIceCandidateHandler(peer);
            peer.pc.ondatachannel = (event) => setupDataChannel(peer, connId, event.channel);

            peer.signalPublished = false;
            signalArea.value = '';
            signalArea.placeholder = 'Generating Offer JSON… please wait';

            const offer = await peer.pc.createOffer();
            await peer.pc.setLocalDescription(offer);
            addMessage(`Connecting${peer.name ? ' to ' + peer.name : ''} — establishing secure channel…`, 'system');

            await ensureSignalPublished(peer, 'Offer');
            startPeerConnectWatchdog(peer);
            updateSecurityPanel();
            return peer.publishedSignal;
        }

        // Dummy handlers for now — Help and About content to be added later.
        document.getElementById('help-btn').onclick = () => {
            addMessage('Help — coming soon.', 'system');
        };
        document.getElementById('about-btn').onclick = () => {
            addMessage('About — coming soon.', 'system');
        };

        // Dark/light theme toggle — persisted to localStorage.
        (function () {
            const themeBtn = document.getElementById('theme-toggle-btn');
            const applyTitle = () => {
                const isLight = document.documentElement.classList.contains('theme-light');
                themeBtn.title = isLight ? 'Switch to dark theme' : 'Switch to light theme';
            };
            applyTitle();
            themeBtn.onclick = () => {
                const isLight = document.documentElement.classList.toggle('theme-light');
                try { localStorage.setItem('aegis-theme', isLight ? 'light' : 'dark'); } catch (e) { /* ignore */ }
                applyTitle();
            };
        })();

        function parseSignalInput(raw) {
            const trimmed = raw.trim();
            if (!trimmed) {
                throw new Error('Paste the Offer or Answer JSON here first (not the invite link).');
            }
            if (/^https?:\/\//i.test(trimmed)) {
                throw new Error(
                    'You pasted a web link (invite URL). That goes in the browser address bar only. ' +
                    'Paste the Offer JSON from the host — long text starting with {"v":3,"sdp":'
                );
            }
            if (trimmed.startsWith('#invite=')) {
                throw new Error('You pasted an invite token. Open it in the browser address bar, not in this box.');
            }
            return trimmed;
        }

        /*
         * Same verification and session-establishment logic as before —
         * parseAndVerifySignal, establishSessionKey, verifyHostKeyTransparency,
         * fingerprint checks are all unchanged — now applied to an explicit
         * peer object the caller supplies, rather than a single global
         * connection. The caller (the relay handler, or the manual-fallback
         * button below) is responsible for resolving which peer a signal
         * belongs to. Returns the processed signal's type so callers know
         * whether an answer now needs to be sent back.
         */
        async function processSignalString(raw, peer) {
            const verified = await parseAndVerifySignal(raw);
            const { sdp: signalData, aegis } = verified;
            showPeerFingerprint(peer, aegis.dtlsFingerprint);

            if (signalData.type === 'offer') {
                if (inviteRole !== 'guest') {
                    throw new Error('Only the guest (invite link) tab should paste the offer.');
                }
                await verifyHostKeyTransparency(aegis.pubKey);
                if (peer.pc && peer.pc.signalingState !== 'closed') {
                    throw new Error('This tab already started a connection. Click Reset, then paste the offer on a fresh tab.');
                }
                peer.isInitiator = false;
                peer.ecdhKeyPair = await generateEcdhKeyPair();
                peer.pc = new RTCPeerConnection(await buildRtcConfig());
                peer.trickleIce = relayTrickleEnabled();
                bindConnectionSecurityHandlers(peer.pc, peer);
                peer.pc.ondatachannel = (event) => setupDataChannel(peer, peer.connId, event.channel);

                bindIceCandidateHandler(peer);
                await peer.pc.setRemoteDescription(signalData);
                await flushRemoteIceQueue(peer);
                await establishSessionKey(peer, aegis.pubKey);
                const remoteFp = readNegotiatedRemoteFingerprint(peer.pc);
                if (remoteFp) peer.expectedFingerprint = remoteFp;
                await verifyLiveFingerprint(peer, 8, 100);
                if (!peer.fingerprintVerified && readNegotiatedRemoteFingerprint(peer.pc)) {
                    peer.fingerprintVerified = true;
                    peer.livePeerFingerprint = readNegotiatedRemoteFingerprint(peer.pc);
                    updateSecurityPanel();
                }

                peer.signalPublished = false;
                signalArea.value = '';
                const answer = await peer.pc.createAnswer();
                await peer.pc.setLocalDescription(answer);
                try {
                    const guestPubKey = await exportPublicKeyB64(peer.ecdhKeyPair.publicKey);
                    await registerPublicKey('guest', guestPubKey);
                } catch (err) {
                    addMessage(`Guest key registration: ${err.message}`, 'system');
                }
                addMessage('Creating Answer…', 'system');
                await ensureSignalPublished(peer, 'Answer');
                startPeerConnectWatchdog(peer);
                updateSecurityPanel();
                return 'offer';
            }

            if (signalData.type === 'answer') {
                if (!peer.pc || !peer.isInitiator) {
                    throw new Error('Only the tab that generated the offer should process the matching answer.');
                }
                if (peer.pc.signalingState === 'stable') {
                    addMessage('Already connected — no need to process the answer again.', 'system');
                    return 'answer';
                }
                if (peer.pc.signalingState !== 'have-local-offer') {
                    throw new Error(`Cannot apply answer while signaling state is "${peer.pc.signalingState}". Click Reset and start over.`);
                }
                await peer.pc.setRemoteDescription(signalData);
                await flushRemoteIceQueue(peer);
                await establishSessionKey(peer, aegis.pubKey);
                const remoteFp = readNegotiatedRemoteFingerprint(peer.pc);
                if (remoteFp) peer.expectedFingerprint = remoteFp;
                await verifyLiveFingerprint(peer, 8, 100);
                if (!peer.fingerprintVerified && readNegotiatedRemoteFingerprint(peer.pc)) {
                    peer.fingerprintVerified = true;
                    peer.livePeerFingerprint = readNegotiatedRemoteFingerprint(peer.pc);
                    updateSecurityPanel();
                }
                addMessage(`Answer applied${peer.name ? ' from ' + peer.name : ''} — waiting for data channel.`, 'system');
                startPeerConnectWatchdog(peer);
                updateSecurityPanel();
                return 'answer';
            }

            throw new Error(`Unknown signal type: ${signalData.type}`);
        }

        /*
         * Resolves which peer a manually pasted signal belongs to, for the
         * advanced/fallback textarea only. The automated relay path never
         * uses this — it always knows the exact peer from the relay
         * message. Guests only ever have one peer (the host). Hosts using
         * manual signaling are expected to connect one guest at a time;
         * with more than one pending connection the ambiguity is surfaced
         * as an error rather than guessed at.
         */
        function guessManualPeer() {
            if (inviteRole === 'guest') {
                let peer = peers.get(HOST_PEER_KEY);
                if (!peer) {
                    peer = makePeer(HOST_PEER_KEY, null);
                    peers.set(HOST_PEER_KEY, peer);
                }
                return peer;
            }
            const candidates = [...peers.values()].filter((p) => p.isInitiator && !p.sessionKeyReady);
            if (candidates.length === 1) return candidates[0];
            if (candidates.length > 1) {
                throw new Error('Multiple pending connections — use the waiting room (Admit) for automated signaling, or Reset and connect one guest at a time manually.');
            }
            throw new Error('No pending connection to apply this signal to. Have the host create an invite and admit a guest first.');
        }

        document.getElementById('signal-btn').onclick = async () => {
            try {
                const raw = parseSignalInput(signalArea.value);
                const peer = guessManualPeer();
                await processSignalString(raw, peer);
            } catch (err) {
                console.error('Signaling failed:', err);
                addMessage(`Signaling error: ${err.message}`, 'system');
            }
        };

        /*
         * ===== Waiting room + automated handshake relay (client) =====
         * This section only automates TRANSPORT of the offer/answer JSON
         * that a human previously copied and pasted by hand, via the
         * server's opaque /ws relay (see keyserver.js). It calls the
         * exact same generateOffer() and processSignalString() functions
         * used by the manual fallback buttons above — no cryptographic
         * logic is duplicated or altered here.
         */
        function relayUrl() {
            const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
            return `${proto}//${location.host}/ws`;
        }

        function connectRelay(role) {
            if (relayWs) {
                try { relayWs.close(); } catch (_) { /* already closed */ }
            }
            try {
                relayWs = new WebSocket(relayUrl());
            } catch (err) {
                addMessage(`Waiting room unavailable: ${err.message}. Use manual signaling below.`, 'system');
                return;
            }
            relayWs.onopen = () => {
                if (role === 'host') {
                    relayWs.send(JSON.stringify({ type: 'register-host', inviteId: currentInviteId }));
                } else {
                    relayWs.send(JSON.stringify({ type: 'join', inviteId: currentInviteId, name: myDisplayName }));
                }
            };
            relayWs.onmessage = (event) => {
                let msg;
                try {
                    msg = JSON.parse(event.data);
                } catch {
                    return;
                }
                handleRelayMessage(role, msg);
            };
            relayWs.onclose = () => {
                addMessage('Waiting-room connection closed. Reconnecting…', 'system');
                if (currentInviteId && (inviteRole === 'host' || myDisplayName)) {
                    setTimeout(() => {
                        if (!relayWs || relayWs.readyState === WebSocket.CLOSED) {
                            connectRelay(inviteRole);
                        }
                    }, 2000);
                }
            };
            relayWs.onerror = () => {
                addMessage('Waiting-room connection error — retrying…', 'system');
            };
        }

        /* iOS Safari kills background WebSockets — reconnect when app returns */
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible' || !currentInviteId) return;
            if (!relayWs || relayWs.readyState === WebSocket.CLOSED || relayWs.readyState === WebSocket.CLOSING) {
                if (inviteRole === 'host' || myDisplayName) {
                    connectRelay(inviteRole);
                }
            }
            for (const peer of peers.values()) {
                tickPeerHeartbeat(peer);
            }
        });

        async function handleRelayMessage(role, msg) {
            switch (msg.type) {
                case 'registered':
                    addMessage('Waiting room open — guests who open your invite link will appear here.', 'system');
                    preloadIceConfig();
                    loadIceConfig(true).catch(() => {});
                    break;

                case 'joined': {
                    myConnId = msg.connId;
                    const hostPeer = makePeer(HOST_PEER_KEY, null);
                    peers.set(HOST_PEER_KEY, hostPeer);
                    if (msg.hostOnline === false) {
                        addMessage('Waiting for the host to open the invite link (keep Safari in the foreground on their phone)…', 'system');
                    } else {
                        addMessage('Waiting for the host to admit you…', 'system');
                    }
                    break;
                }

                case 'host-away':
                    addMessage(msg.message || 'Host temporarily offline — ask them to reopen the invite link.', 'system');
                    break;

                case 'host-back':
                    addMessage('Host is back online — waiting for admission…', 'system');
                    break;

                case 'presence':
                    waitingGuests.set(msg.connId, msg.name);
                    renderWaitingRoom();
                    break;

                case 'peer-left': {
                    const leavingPeer = peers.get(msg.connId);
                    const leftName = msg.name || leavingPeer?.name || waitingGuests.get(msg.connId) || 'Guest';
                    waitingGuests.delete(msg.connId);
                    renderWaitingRoom();
                    if (leavingPeer) {
                        leavingPeer.leftNoticeSent = true;
                        addMessage(`${leftName} has left.`, 'system');
                        closePeer(msg.connId);
                    } else if (msg.wasAdmitted) {
                        addMessage(`${leftName} has left.`, 'system');
                    } else {
                        addMessage(`${leftName} left the waiting room.`, 'system');
                    }
                    break;
                }

                case 'admitted':
                    addMessage('Admitted — connecting automatically…', 'system');
                    break;

                case 'denied':
                    addMessage(`Not admitted: ${msg.reason || 'host declined'}`, 'system');
                    break;

                case 'room-closed':
                    addMessage(`Waiting room closed: ${msg.reason || ''}`, 'system');
                    waitingGuests.clear();
                    renderWaitingRoom();
                    closeAllPeers();
                    break;

                case 'signal':
                    try {
                        const raw = parseSignalInput(msg.payload);
                        let peer;
                        if (role === 'guest') {
                            peer = peers.get(HOST_PEER_KEY);
                            if (!peer) {
                                peer = makePeer(HOST_PEER_KEY, null);
                                peers.set(HOST_PEER_KEY, peer);
                            }
                        } else {
                            peer = peers.get(msg.connId);
                            if (!peer) {
                                throw new Error(`Signal arrived for an unknown guest (connId ${msg.connId}) — it may have left.`);
                            }
                        }
                        const kind = await processSignalString(raw, peer);
                        if (role === 'guest' && kind === 'offer') {
                            /* processSignalString just populated peer.publishedSignal
                               with the freshly generated Answer — send that exact
                               value back, not the shared textarea, so a second
                               guest's concurrent handshake can never bleed into it. */
                            relayWs.send(JSON.stringify({ type: 'signal', payload: peer.publishedSignal }));
                            addMessage('Answer sent automatically.', 'system');
                        }
                    } catch (err) {
                        console.error('Automated signaling failed:', err);
                        addMessage(`Automated signaling error: ${err.message}`, 'system');
                    }
                    break;

                case 'ice-candidate':
                    try {
                        let icePeer;
                        if (role === 'guest') {
                            icePeer = peers.get(HOST_PEER_KEY);
                        } else {
                            icePeer = peers.get(msg.connId);
                        }
                        if (!icePeer || msg.payload == null) break;
                        const init = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
                        await addRemoteIceCandidate(icePeer, init);
                    } catch (err) {
                        console.warn('ICE candidate relay failed:', err);
                    }
                    break;

                case 'error':
                    if (/invite not found|expired/i.test(msg.message || '')) {
                        addMessage('Waiting room: host not online yet. Ask the host to open the invite link and keep Safari in the foreground, then tap Join again.', 'system');
                    } else {
                        addMessage(`Waiting room: ${msg.message}`, 'system');
                    }
                    break;
            }
        }

        function renderWaitingRoom() {
            const panel = document.getElementById('waiting-room-panel');
            const list  = document.getElementById('waiting-room-list');
            if (waitingGuests.size === 0) {
                panel.classList.remove('show');
                list.innerHTML = '';
                return;
            }
            panel.classList.add('show');
            list.innerHTML = '';
            for (const [connId, name] of waitingGuests.entries()) {
                const row = document.createElement('div');
                row.className = 'waiting-guest-row';

                const nameEl = document.createElement('span');
                nameEl.className = 'waiting-guest-name';
                nameEl.textContent = name;

                const actions = document.createElement('span');
                actions.className = 'waiting-guest-actions';

                const admitBtn = document.createElement('button');
                admitBtn.className = 'btn-admit';
                admitBtn.textContent = peers.size >= MAX_ACTIVE_GUESTS_CLIENT ? `Full (${MAX_ACTIVE_GUESTS_CLIENT})` : 'Admit';
                admitBtn.disabled = peers.size >= MAX_ACTIVE_GUESTS_CLIENT;
                admitBtn.onclick = () => admitGuest(connId, name);

                const denyBtn = document.createElement('button');
                denyBtn.className = 'btn-deny';
                denyBtn.textContent = 'Deny';
                denyBtn.onclick = () => denyGuest(connId);

                actions.appendChild(admitBtn);
                actions.appendChild(denyBtn);
                row.appendChild(nameEl);
                row.appendChild(actions);
                list.appendChild(row);
            }
        }

        async function admitGuest(connId, name) {
            if (peers.size >= MAX_ACTIVE_GUESTS_CLIENT) {
                addMessage(`Already at the ${MAX_ACTIVE_GUESTS_CLIENT}-guest limit.`, 'system');
                return;
            }
            relayWs.send(JSON.stringify({ type: 'admit', connId }));
            waitingGuests.delete(connId);
            renderWaitingRoom();
            try {
                const offerStr = await generateOffer(connId, name);
                relayWs.send(JSON.stringify({ type: 'signal', connId, payload: offerStr }));
                addMessage(`Offer sent automatically to ${name || 'guest'} — waiting for them to connect…`, 'system');
            } catch (err) {
                addMessage(`Auto-connect to ${name || 'guest'} failed: ${err.message}`, 'system');
            }
        }

        function denyGuest(connId) {
            relayWs.send(JSON.stringify({ type: 'deny', connId }));
            waitingGuests.delete(connId);
            renderWaitingRoom();
        }


        document.getElementById('guest-name-submit-btn').onclick = () => {
            const input = document.getElementById('guest-name-input');
            const name = input.value.trim().slice(0, DISPLAY_NAME_MAX_CLIENT);
            if (!name) {
                input.focus();
                return;
            }
            myDisplayName = name;
            document.getElementById('name-modal-overlay').classList.remove('show');
            addMessage('Joined waiting room — waiting for the host to admit you.', 'system');
            connectRelay('guest');
        };
        document.getElementById('guest-name-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('guest-name-submit-btn').click();
        });

        function setupDataChannel(peer, connId, channel) {
            if (channel) peer.dc = channel;
            const dc = peer.dc;
            dc.onopen = async () => {
                stopPeerConnectWatchdog(peer);
                updateStatusDot();
                addMessage(`Secure P2P channel established${peer.name ? ' with ' + peer.name : ''}.`, 'system');
                startPeerHeartbeat(peer);
                startFingerprintVerificationPoll(peer);
                const verified = await verifyLiveFingerprint(peer);
                if (!verified && peer.expectedFingerprint) {
                    addMessage('Verifying DTLS fingerprint — message box unlocks when complete.', 'system');
                }
                if (peer.pc) await detectConnectionPath(peer.pc, peer);
                updateSecurityPanel();
            };
            dc.onclose = () => {
                stopPeerHeartbeat(peer);
                updateStatusDot();
                if (!peer.closing && !peer.leftNoticeSent) {
                    addMessage(`P2P channel closed${peer.name ? ' with ' + peer.name : ''}.`, 'system');
                }
                updateSecurityPanel();
            };
            dc.onerror = (err) => {
                console.error('Data channel error:', err);
                addMessage(
                    isMobileSafari()
                        ? 'Data channel error on Safari — keep this tab in the foreground and tap Confirm on the safety code if shown.'
                        : 'Data channel error — check browser console.',
                    'system'
                );
            };
            dc.onmessage = async (event) => {
                try {
                    if (typeof event.data !== 'string') {
                        // This app only ever sends JSON.stringify'd text envelopes over
                        // the data channel. A non-string frame (ArrayBuffer/Blob) is not
                        // something we intentionally send, so it's a stray/duplicate frame
                        // rather than a real protocol error — log it and move on instead of
                        // surfacing a scary user-facing error for something benign.
                        console.warn('Ignoring non-text data channel frame:', event.data);
                        return;
                    }
                    const envelope = JSON.parse(event.data);
                    if (handleHeartbeatMessage(peer, envelope)) return;
                    if (!wasmReady || !peer.sessionKeyReady || !peer.fingerprintVerified) {
                        peer.pendingIncoming.push(envelope);
                        if (!peer.pendingNoticeShown) {
                            peer.pendingNoticeShown = true;
                            addMessage('Message queued — waiting for full security handshake…', 'system');
                        }
                        markWasmReady();
                        return;
                    }
                    if (envelope.type === 'secure-file') {
                        await handleSecureFileEnvelope(peer, envelope);
                    } else {
                        handleSecureEnvelope(peer, envelope);
                    }
                } catch (err) {
                    console.error('Failed to process message:', err);
                    addMessage(`Error receiving message: ${err.message}`, 'system');
                }
            };
        }

        function sendTextMessage() {
            const text = msgInput.value.trim();
            if (!text) return;
            const readyPeers = [...peers.values()].filter(peerCanSend);
            if (readyPeers.length === 0) {
                addMessage('No connected peer to send to yet.', 'system');
                return;
            }
            try {
                sendTextPayload(text, readyPeers);
                addMessage(text, 'sent');
                msgInput.value = '';
            } catch (err) {
                console.error('Send failed:', err);
                addMessage(`Send failed: ${err.message}`, 'system');
            }
        }

        document.getElementById('send-btn').onclick = sendTextMessage;
        msgInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') sendTextMessage();
        });

        document.getElementById('file-btn').onclick = () => fileInput.click();
        fileInput.onchange = (e) => {
            const file = e.target.files[0];
            e.target.value = '';
            if (!file) return;

            const isLarge = file.size >= LARGE_FILE_WARN_BYTES;

            const readAndSend = async () => {
                if (isLarge) {
                    await waitForNextPaint();
                }

                try {
                    const onProgress = isLarge
                        ? ({ index, totalChunks, etaSeconds }) => {
                            const pct = Math.min(100, Math.floor((index / totalChunks) * 100));
                            setFileTransferStatus(
                                `Sending "${file.name}" (${formatBytes(file.size)})… ${pct}% — ETA ~${formatEta(etaSeconds)}`
                            );
                        }
                        : null;
                    await sendFile(file, onProgress);
                    clearFileTransferStatus();
                } catch (err) {
                    clearFileTransferStatus();
                    addMessage(`File send failed: ${err.message}`, 'system');
                }
            };

            if (isLarge) {
                const eta = formatEta(estimateFileSendEtaSeconds(file.size));
                setFileTransferStatus(
                    `File "${file.name}" (${formatBytes(file.size)}) is being prepared and sending… ETA ~${eta}`
                );
                readAndSend();
            } else {
                readAndSend();
            }
        };

        applyInviteFromHash();
        isKeyserverAvailable().then((available) => {
            if (!available) {
                localDevMode = true;
                addMessage(
                    'Tip: You are using a static file server. For full security run: ./scripts/run-local.sh then open http://localhost:8080',
                    'system'
                );
            }
            updateSecurityPanel();
        });
        loadIceConfig().then(updateSecurityPanel).catch(updateSecurityPanel);
        updateSecurityPanel();
