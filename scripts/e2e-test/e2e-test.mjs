#!/usr/bin/env node
/**
 * Aegis Secure Chat — automated end-to-end test (Host + Guest in Playwright).
 *
 * Covers the current waiting-room flow:
 *   Host creates invite -> Guest opens link, enters name, joins waiting room
 *   -> Host admits -> both sides confirm the safety code -> chat + file transfer.
 *
 * Usage:
 *   node e2e-test.mjs
 *   node e2e-test.mjs --base http://localhost:8080
 *   node e2e-test.mjs --base https://chat.zetaegis.com --headed
 *
 * Env: E2E_BASE (default http://localhost:8080)
 */

import { chromium } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.join(__dirname, 'reports');

const args = process.argv.slice(2);
const BASE = args.includes('--base')
  ? args[args.indexOf('--base') + 1]
  : process.env.E2E_BASE || 'http://localhost:8080';
const HEADED = args.includes('--headed');

const GUEST_NAME = `E2E-Guest-${Date.now() % 100000}`;
const HOST_MSG = `E2E host ping ${Date.now()}`;
const GUEST_MSG = `E2E guest pong ${Date.now()}`;
const FILE_NAME = `aegis-e2e-test-${Date.now()}.txt`;
const FILE_CONTENT = `Aegis E2E file transfer test\nTimestamp: ${new Date().toISOString()}\n`;

// Only these remain static top-level checks; per-peer status (signaling,
// session key, DTLS fingerprint, P2P channel) now lives in dynamic
// .peer-card elements rendered per connection, checked separately below.
const SEC_IDS = ['sec-wasm', 'sec-room', 'sec-invite', 'sec-transparency'];

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function pass(name, detail = '') {
  return { name, ok: true, detail };
}

function fail(name, detail = '') {
  return { name, ok: false, detail };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function healthCheck(base) {
  const res = await fetch(`${base}/health`);
  if (!res.ok) throw new Error(`Server not healthy at ${base}/health (${res.status})`);
  return res.json();
}

async function waitForWasm(page) {
  await page.waitForFunction(
    () => document.getElementById('sec-wasm')?.innerHTML?.includes('✓'),
    { timeout: 90_000 }
  );
}

async function waitForChatReady(page) {
  await page.waitForFunction(
    () => {
      const input = document.getElementById('msg-input');
      return input && !input.disabled;
    },
    { timeout: 180_000 }
  );
}

async function waitForChatMessage(page, text) {
  await page.waitForFunction(
    (t) => document.getElementById('chat-box')?.innerText?.includes(t),
    text,
    { timeout: 60_000 }
  );
}

async function getSecurityPanel(page) {
  return page.evaluate((ids) => {
    const out = {};
    for (const id of ids) {
      out[id] = document.getElementById(id)?.innerText?.trim() || '';
    }
    return out;
  }, SEC_IDS);
}

function securityAllGreen(panel) {
  const failures = [];
  for (const [id, text] of Object.entries(panel)) {
    if (!text.includes('✓')) failures.push(`${id}: ${text}`);
  }
  return failures;
}

async function getPeerCardLines(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.peer-card .peer-status-line')].map((el) => el.innerText.trim())
  );
}

function peerCardAllGreen(lines) {
  return lines.filter((line) => line.includes('✗'));
}

async function getSafetyCode(page) {
  return page.locator('.peer-safety-code').first().innerText();
}

async function captureDiagnostics(host, guest) {
  const diag = {};
  for (const [label, page] of [['host', host], ['guest', guest]]) {
    diag[label] = await page.evaluate(() => ({
      chat: document.getElementById('chat-box')?.innerText?.slice(-500),
      security: ['sec-wasm', 'sec-room', 'sec-invite', 'sec-transparency']
        .map((id) => document.getElementById(id)?.innerText),
      peerCard: [...document.querySelectorAll('.peer-card .peer-status-line')].map((el) => el.innerText),
      msgDisabled: document.getElementById('msg-input')?.disabled
    }));
  }
  return diag;
}

async function chatHasSendFailure(page) {
  return (await page.locator('#chat-box').innerText()).includes('Send failed');
}

// Small-file P2P messages render as <a class="msg file ..."> with a
// blob: object URL for a href — fetch it from inside the page context
// (blob URLs only resolve within the page/worker that created them).
async function readBlobHref(page, href) {
  return page.evaluate(async (url) => {
    const res = await fetch(url);
    return res.text();
  }, href);
}

async function runE2E() {
  const started = new Date().toISOString();
  const results = [];
  let error = null;

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = path.join(REPORTS_DIR, `e2e-report-${stamp()}.json`);

  const tmpFile = path.join(os.tmpdir(), FILE_NAME);
  fs.writeFileSync(tmpFile, FILE_CONTENT, 'utf8');

  console.log('==> Aegis E2E automated test');
  console.log(`    Base URL: ${BASE}`);
  console.log(`    Mode: ${HEADED ? 'headed' : 'headless'}`);
  console.log('');

  try {
    const health = await healthCheck(BASE);
    results.push(pass('server_health', JSON.stringify(health)));

    const browser = await chromium.launch({
      headless: !HEADED,
      args: ['--use-fake-ui-for-media-stream']
    });

    const hostContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
    const guestContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    host.setDefaultTimeout(120_000);
    guest.setDefaultTimeout(120_000);

    try {
      // ── Host: create invite ──
      console.log('… Host: loading app');
      await host.goto(BASE);
      await waitForWasm(host);
      results.push(pass('host_wasm_loaded'));

      await host.click('#create-invite-btn');
      await host.waitForFunction(
        () => (document.getElementById('guest-invite-link')?.value || '').includes('#invite='),
        { timeout: 15_000 }
      );
      const guestLink = await host.inputValue('#guest-invite-link');
      if (!guestLink) throw new Error('Guest invite link empty');
      results.push(pass('host_create_invite', guestLink.slice(0, 80) + '…'));

      // ── Guest: open invite link, enter name, join waiting room ──
      console.log('… Guest: opening invite link');
      await guest.goto(guestLink);
      await waitForWasm(guest);
      await guest.waitForSelector('#name-modal-overlay.show', { timeout: 30_000 });
      await guest.fill('#guest-name-input', GUEST_NAME);
      await guest.click('#guest-name-submit-btn');
      results.push(pass('guest_join_waiting_room', GUEST_NAME));

      // ── Host: admit the waiting guest ──
      console.log('… Host: admitting guest from waiting room');
      await host.waitForSelector('#waiting-room-panel.show', { timeout: 30_000 });
      const guestRow = host.locator('.waiting-guest-row', { hasText: GUEST_NAME });
      await guestRow.locator('.btn-admit').click({ timeout: 30_000 });
      results.push(pass('host_admit_guest'));

      // ── Safety code: wait for both sides to derive it, confirm on both ──
      console.log('… Safety code: waiting for peer connection + confirming both sides');
      await host.waitForSelector('.peer-safety-code', { timeout: 60_000 });
      await guest.waitForSelector('.peer-safety-code', { timeout: 60_000 });
      const hostCode = (await getSafetyCode(host)).replace(/\s+/g, '');
      const guestCode = (await getSafetyCode(guest)).replace(/\s+/g, '');
      if (hostCode && hostCode === guestCode) {
        results.push(pass('safety_codes_match', hostCode));
      } else {
        results.push(fail('safety_codes_match', `host=${hostCode} guest=${guestCode}`));
      }

      // .click() auto-waits for the button to become enabled, which happens
      // once the DTLS fingerprint is verified live and the P2P channel is open.
      await host.locator('.peer-safety-confirm-btn').click({ timeout: 60_000 });
      await guest.locator('.peer-safety-confirm-btn').click({ timeout: 60_000 });
      results.push(pass('safety_confirmed_both_sides'));

      await Promise.all([waitForChatReady(host), waitForChatReady(guest)]).catch(async (err) => {
        const diag = await captureDiagnostics(host, guest);
        throw new Error(`${err.message}\nDiagnostics: ${JSON.stringify(diag, null, 2)}`);
      });
      results.push(pass('p2p_channel_ready'));

      // ── Security panel + peer-card checks ──
      const hostSec = await getSecurityPanel(host);
      const guestSec = await getSecurityPanel(guest);
      const hostSecFails = securityAllGreen(hostSec);
      const guestSecFails = securityAllGreen(guestSec);
      results.push(hostSecFails.length
        ? fail('host_security_panel', hostSecFails.join('; '))
        : pass('host_security_panel', 'all checks green'));
      results.push(guestSecFails.length
        ? fail('guest_security_panel', guestSecFails.join('; '))
        : pass('guest_security_panel', 'all checks green'));

      const hostPeerFails = peerCardAllGreen(await getPeerCardLines(host));
      const guestPeerFails = peerCardAllGreen(await getPeerCardLines(guest));
      results.push(hostPeerFails.length
        ? fail('host_peer_card', hostPeerFails.join('; '))
        : pass('host_peer_card', 'signaling/session/DTLS/channel all green'));
      results.push(guestPeerFails.length
        ? fail('guest_peer_card', guestPeerFails.join('; '))
        : pass('guest_peer_card', 'signaling/session/DTLS/channel all green'));

      // ── Chat: host → guest ──
      console.log('… Chat: host → guest');
      await host.fill('#msg-input', HOST_MSG);
      await host.click('#send-btn');
      await sleep(500);
      if (await chatHasSendFailure(host)) {
        results.push(fail('host_send_message', 'Send failed on host'));
      } else {
        await waitForChatMessage(guest, HOST_MSG);
        results.push(pass('host_to_guest_message', HOST_MSG));
      }

      // ── Chat: guest → host ──
      console.log('… Chat: guest → host');
      await guest.fill('#msg-input', GUEST_MSG);
      await guest.click('#send-btn');
      await sleep(500);
      if (await chatHasSendFailure(guest)) {
        results.push(fail('guest_send_message', 'Send failed on guest'));
      } else {
        await waitForChatMessage(host, GUEST_MSG);
        results.push(pass('guest_to_host_message', GUEST_MSG));
      }

      // ── File: host → guest ──
      console.log('… File: host → guest');
      await host.setInputFiles('#file-input', tmpFile);
      await sleep(2000);

      if ((await host.locator('#chat-box').innerText()).includes('File send failed')) {
        results.push(fail('host_send_file', 'File send failed on host'));
      } else {
        await guest.waitForFunction(
          (name) => document.getElementById('chat-box')?.innerText?.includes(name),
          FILE_NAME,
          { timeout: 60_000 }
        );
        const fileLink = guest.locator(`a.msg.file:has-text("${FILE_NAME}")`);
        const href = await fileLink.getAttribute('href');
        if (!href || !href.startsWith('blob:')) {
          results.push(fail('guest_receive_file', 'No blob download link on guest'));
        } else {
          const decoded = await readBlobHref(guest, href);
          if (decoded === FILE_CONTENT) {
            results.push(pass('host_to_guest_file', `${FILE_NAME} (${FILE_CONTENT.length} bytes verified)`));
          } else {
            results.push(fail('guest_file_integrity', 'Decoded content mismatch'));
          }
        }
      }

      // ── File: guest → host ──
      console.log('… File: guest → host');
      const tmpFile2 = path.join(os.tmpdir(), `guest-${FILE_NAME}`);
      const guestFileContent = `Guest file reply ${Date.now()}\n`;
      fs.writeFileSync(tmpFile2, guestFileContent, 'utf8');
      const guestFileName = path.basename(tmpFile2);

      await guest.setInputFiles('#file-input', tmpFile2);
      await sleep(2000);

      if ((await guest.locator('#chat-box').innerText()).includes('File send failed')) {
        results.push(fail('guest_send_file', 'File send failed on guest'));
      } else {
        await host.waitForFunction(
          (name) => document.getElementById('chat-box')?.innerText?.includes(name),
          guestFileName,
          { timeout: 60_000 }
        );
        const hostFileLink = host.locator(`a.msg.file:has-text("${guestFileName}")`);
        const hostHref = await hostFileLink.getAttribute('href');
        if (!hostHref || !hostHref.startsWith('blob:')) {
          results.push(fail('host_receive_file', 'No blob download link on host'));
        } else {
          const decoded = await readBlobHref(host, hostHref);
          if (decoded === guestFileContent) {
            results.push(pass('guest_to_host_file', `${guestFileName} (${guestFileContent.length} bytes verified)`));
          } else {
            results.push(fail('host_file_integrity', 'Decoded content mismatch'));
          }
        }
      }

      fs.unlinkSync(tmpFile2);
    } finally {
      await host.close().catch(() => {});
      await guest.close().catch(() => {});
      await hostContext.close().catch(() => {});
      await guestContext.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  } catch (err) {
    error = err.message || String(err);
    results.push(fail('fatal_error', error));
  } finally {
    fs.unlinkSync(tmpFile);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const overall = failed === 0 && !error;

  const report = {
    overall: overall ? 'PASS' : 'FAIL',
    base: BASE,
    started,
    finished: new Date().toISOString(),
    passed,
    failed,
    results,
    error
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('');
  console.log('=== E2E Results ===');
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log('');
  console.log(`Overall: ${report.overall} (${passed} passed, ${failed} failed)`);
  console.log(`Report:  ${reportPath}`);

  process.exit(overall ? 0 : 1);
}

runE2E();
