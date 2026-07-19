'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BLOB_TTL_MS = Number(process.env.BLOB_TTL_MS || 72 * 60 * 60 * 1000);
const BLOB_MAX_BYTES = Number(process.env.BLOB_MAX_BYTES || 500 * 1024 * 1024);
const BLOB_MAX_PART_BYTES = Number(process.env.BLOB_MAX_PART_BYTES || 6 * 1024 * 1024);

function isValidProof(proof) {
  return typeof proof === 'string' && proof.length > 0 && proof.length <= 512;
}

function createBlobStore({ dataDir, rateLimit, rateLimitParts }) {
  // Fall back to the strict limiter if a looser one wasn't supplied, so this
  // module still works standalone / in tests.
  const partLimit = rateLimitParts || rateLimit;
  const blobRoot = path.join(dataDir, 'blobs');
  const manifestFile = path.join(blobRoot, 'manifest.json');
  /** @type {Map<string, object>} */
  const manifests = new Map();

  if (!fs.existsSync(blobRoot)) {
    fs.mkdirSync(blobRoot, { recursive: true });
  }

  function loadManifests() {
    if (!fs.existsSync(manifestFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      for (const [blobId, meta] of Object.entries(parsed)) {
        manifests.set(blobId, meta);
      }
    } catch (err) {
      console.warn('blob manifest load failed:', err.message);
    }
  }

  function saveManifests() {
    const obj = Object.fromEntries(manifests.entries());
    fs.writeFileSync(manifestFile, JSON.stringify(obj));
  }

  function blobDir(blobId) {
    return path.join(blobRoot, blobId);
  }

  function partPath(blobId, partIndex) {
    return path.join(blobDir(blobId), `part-${String(partIndex).padStart(5, '0')}.bin`);
  }

  function pruneExpiredBlobs() {
    const now = Date.now();
    for (const [blobId, meta] of manifests.entries()) {
      if (now - meta.createdAt > BLOB_TTL_MS) {
        try {
          fs.rmSync(blobDir(blobId), { recursive: true, force: true });
        } catch (_) { /* already gone */ }
        manifests.delete(blobId);
      }
    }
    saveManifests();
  }

  loadManifests();
  pruneExpiredBlobs();
  setInterval(pruneExpiredBlobs, 60 * 60 * 1000).unref();

  function getManifest(blobId) {
    return manifests.get(blobId) || null;
  }

  function assertToken(meta, token) {
    if (!meta || typeof token !== 'string' || token.length < 32) return false;
    try {
      const a = Buffer.from(meta.token, 'utf8');
      const b = Buffer.from(token, 'utf8');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  function mount(app, express) {
    app.post('/api/v1/blobs/init', rateLimit, (req, res) => {
      const { inviteId, blobId, name, size, totalParts, token, proof } = req.body || {};
      if (!UUID_V4_RE.test(inviteId || '') || !UUID_V4_RE.test(blobId || '')) {
        return res.status(400).json({ error: 'inviteId and blobId must be UUID v4' });
      }
      if (!name || typeof name !== 'string' || name.length > 255) {
        return res.status(400).json({ error: 'invalid name' });
      }
      if (!Number.isInteger(size) || size <= 0 || size > BLOB_MAX_BYTES) {
        return res.status(400).json({ error: `size must be 1..${BLOB_MAX_BYTES}` });
      }
      if (!Number.isInteger(totalParts) || totalParts <= 0 || totalParts > 10000) {
        return res.status(400).json({ error: 'invalid totalParts' });
      }
      if (typeof token !== 'string' || token.length < 32 || token.length > 128) {
        return res.status(400).json({ error: 'invalid token' });
      }
      if (!isValidProof(proof)) {
        return res.status(400).json({ error: 'invalid proof' });
      }
      if (manifests.has(blobId)) {
        return res.status(409).json({ error: 'blobId already exists' });
      }

      fs.mkdirSync(blobDir(blobId), { recursive: true });
      const meta = {
        inviteId,
        blobId,
        name,
        size,
        totalParts,
        token,
        proof,
        partsReceived: [],
        complete: false,
        createdAt: Date.now()
      };
      manifests.set(blobId, meta);
      saveManifests();
      res.status(201).json({ ok: true, blobId, totalParts, ttlMs: BLOB_TTL_MS });
    });

    app.put('/api/v1/blobs/:blobId/parts/:partIndex', express.raw({
      type: 'application/octet-stream',
      limit: BLOB_MAX_PART_BYTES
    }), partLimit, (req, res) => {
      const { blobId, partIndex } = req.params;
      const token = req.get('x-blob-token') || '';
      const index = Number(partIndex);
      const meta = getManifest(blobId);
      if (!meta) return res.status(404).json({ error: 'blob not found' });
      if (!assertToken(meta, token)) return res.status(403).json({ error: 'invalid token' });
      if (!Number.isInteger(index) || index < 0 || index >= meta.totalParts) {
        return res.status(400).json({ error: 'invalid part index' });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'empty part body' });
      }
      if (req.body.length > BLOB_MAX_PART_BYTES) {
        return res.status(413).json({ error: 'part too large' });
      }

      fs.writeFileSync(partPath(blobId, index), req.body);
      if (!meta.partsReceived.includes(index)) {
        meta.partsReceived.push(index);
        meta.partsReceived.sort((a, b) => a - b);
        saveManifests();
      }
      res.json({ ok: true, partIndex: index, bytes: req.body.length });
    });

    app.post('/api/v1/blobs/:blobId/complete', rateLimit, (req, res) => {
      const { blobId } = req.params;
      const { token, totalParts } = req.body || {};
      const meta = getManifest(blobId);
      if (!meta) return res.status(404).json({ error: 'blob not found' });
      if (!assertToken(meta, token)) return res.status(403).json({ error: 'invalid token' });
      if (Number.isInteger(totalParts) && totalParts !== meta.totalParts) {
        return res.status(400).json({ error: 'totalParts mismatch' });
      }
      if (meta.partsReceived.length !== meta.totalParts) {
        return res.status(409).json({
          error: 'missing parts',
          received: meta.partsReceived.length,
          expected: meta.totalParts
        });
      }
      meta.complete = true;
      saveManifests();
      res.json({ ok: true, blobId, complete: true });
    });

    app.get('/api/v1/blobs/:blobId/parts/:partIndex', partLimit, (req, res) => {
      const { blobId, partIndex } = req.params;
      const token = req.get('x-blob-token') || req.query.token || '';
      const index = Number(partIndex);
      const meta = getManifest(blobId);
      if (!meta) return res.status(404).json({ error: 'blob not found' });
      if (!assertToken(meta, token)) return res.status(403).json({ error: 'invalid token' });
      if (!meta.complete) return res.status(409).json({ error: 'upload not complete' });
      if (!Number.isInteger(index) || index < 0 || index >= meta.totalParts) {
        return res.status(400).json({ error: 'invalid part index' });
      }
      const filePath = partPath(blobId, index);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'part not found' });
      res.type('application/octet-stream');
      res.sendFile(filePath);
    });

    app.get('/api/v1/blobs/:blobId/meta', partLimit, (req, res) => {
      const { blobId } = req.params;
      const token = req.get('x-blob-token') || req.query.token || '';
      const meta = getManifest(blobId);
      if (!meta) return res.status(404).json({ error: 'blob not found' });
      if (!assertToken(meta, token)) return res.status(403).json({ error: 'invalid token' });
      res.json({
        blobId: meta.blobId,
        name: meta.name,
        size: meta.size,
        totalParts: meta.totalParts,
        complete: meta.complete,
        createdAt: meta.createdAt
      });
    });

    app.delete('/api/v1/blobs/:blobId', rateLimit, (req, res) => {
      const { blobId } = req.params;
      const token = req.get('x-blob-token') || (req.body && req.body.token) || '';
      const meta = getManifest(blobId);
      if (!meta) return res.status(404).json({ error: 'blob not found' });
      if (!assertToken(meta, token)) return res.status(403).json({ error: 'invalid token' });
      try {
        fs.rmSync(blobDir(blobId), { recursive: true, force: true });
      } catch (_) { /* ignore */ }
      manifests.delete(blobId);
      saveManifests();
      res.json({ ok: true });
    });
  }

  return { mount, pruneExpiredBlobs };
}

module.exports = { createBlobStore };
