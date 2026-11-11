// End-to-end test: three browsers with fake cameras join one meeting.
//
//   npm install            (installs the local PeerJS server used here)
//   node tests/meet.test.mjs
//
// Needs Playwright's Chromium. Runs a local PeerJS server and the site, so
// nothing goes to the public call server or to Deluxe Main.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const { chromium } = require('playwright');
const peerModule = process.env.PEER_MODULE || 'peer';
const { ExpressPeerServer } = require(peerModule);
const express = createRequire(require.resolve(peerModule))('express');
const http = require('node:http');

const SITE = 8091, PEERPORT = 9091;
{
  const app = express();
  const server = http.createServer(app);
  app.use('/', ExpressPeerServer(server, { path: '/' }));
  server.listen(PEERPORT, '127.0.0.1');
}
const site = spawn(process.execPath, [path.join(repo, 'tools/serve.mjs'), String(SITE)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));

const config = `window.MEET_CONFIG = { peer: { host: '127.0.0.1', port: ${PEERPORT}, path: '/', secure: false }, iceServers: [] };`;
// A stand-in for Deluxe Main's deluxe.js: a guest, with the same API.
const deluxeLocal = process.env.DELUXE_JS && fs.existsSync(process.env.DELUXE_JS) ? fs.readFileSync(process.env.DELUXE_JS, 'utf8') : '';

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
let failed = 0;
async function step(name, fn) {
  try { await fn(); console.log('ok', name); } catch (e) { failed++; console.log('FAIL', name, '\n ', e.message); }
}

async function person(name) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 }, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] page error:`, e.message));
  await page.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: config }));
  await page.route('https://deluxe-main.vercel.app/**', (r) => (deluxeLocal ? r.fulfill({ contentType: 'text/javascript', body: deluxeLocal }) : r.abort()));
  return { name, page, ctx };
}

const code = 'abc-defg-hij';
const a = await person('Ana');
const b = await person('Ben');
const c = await person('Cy');

async function join(p) {
  await p.page.goto(`http://127.0.0.1:${SITE}/${code}`);
  await p.page.waitForSelector('#prejoin:not([hidden])');
  await p.page.fill('#pre-name', p.name);
  await p.page.click('#join-now');
  await p.page.waitForSelector('#call:not([hidden])');
}
const tiles = (p) => p.page.locator('#stage .tile').count();
async function waitTiles(p, n, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await tiles(p)) === n && (await p.page.locator('#stage .tile .connecting').count()) === 0) return;
    await p.page.waitForTimeout(250);
  }
  throw new Error(`${p.name} sees ${await tiles(p)} tiles, wanted ${n}`);
}
const videoPlaying = (p, peerName) => p.page.evaluate((n) => {
  const t = [...document.querySelectorAll('#stage .tile')].find((x) => x.querySelector('.label').textContent.startsWith(n));
  const v = t && t.querySelector('video');
  return !!v && v.readyState >= 2 && v.videoWidth > 0;
}, peerName);
const videoInfo = (p, peerName) => p.page.evaluate((n) => {
  const t = [...document.querySelectorAll('#stage .tile')].find((x) => x.querySelector('.label').textContent.startsWith(n));
  const v = t && t.querySelector('video');
  return v && { rs: v.readyState, w: v.videoWidth, paused: v.paused, tracks: v.srcObject && v.srcObject.getTracks().map((x) => x.kind + ':' + x.readyState + ':' + x.muted) };
}, peerName);

await step('home page loads', async () => {
  await a.page.goto(`http://127.0.0.1:${SITE}/`);
  await a.page.waitForSelector('#home:not([hidden])');
  await a.page.fill('#join-code', 'https://x.example/ABC-DEFG-HIJ');
  await a.page.click('#join-go');
  await a.page.waitForSelector('#prejoin:not([hidden])');
  assert.equal(await a.page.textContent('#pre-room'), code);
});

await step('three people join and see each other', async () => {
  await join(a);
  await join(b);
  await join(c);
  for (const p of [a, b, c]) await waitTiles(p, 3);
  await a.page.waitForTimeout(1500);
  for (const [p, other] of [[a, 'Ben'], [a, 'Cy'], [b, 'Ana'], [b, 'Cy'], [c, 'Ana'], [c, 'Ben']]) {
    let ok = false;
    for (let i = 0; i < 20 && !ok; i++) { ok = await videoPlaying(p, other); if (!ok) await p.page.waitForTimeout(250); }
    assert.ok(ok, `${p.name} sees ${other}'s video ${JSON.stringify(await videoInfo(p, other))}`);
  }
  assert.equal(await a.page.textContent('#bar-count'), '3');
});

await step('chat reaches everyone', async () => {
  await b.page.click('#b-chat');
  await b.page.fill('#chat-input', 'Hello from Ben');
  await b.page.press('#chat-input', 'Enter');
  for (const p of [a, c]) await p.page.waitForFunction(() => document.querySelector('#messages').textContent.includes('Hello from Ben'), null, { timeout: 5000 });
  assert.equal(await a.page.isVisible('#chat-dot'), true, 'unread dot');
});

await step('mute and camera off show to others', async () => {
  await a.page.click('#b-mic');
  await a.page.click('#b-cam');
  await b.page.waitForFunction(() => {
    const t = [...document.querySelectorAll('#stage .tile')].find((x) => x.querySelector('.label').textContent.startsWith('Ana'));
    return t && t.classList.contains('mic-off') && t.classList.contains('no-video');
  }, null, { timeout: 5000 });
  await a.page.click('#b-cam');
  await b.page.waitForFunction(() => {
    const t = [...document.querySelectorAll('#stage .tile')].find((x) => x.querySelector('.label').textContent.startsWith('Ana'));
    return t && !t.classList.contains('no-video');
  }, null, { timeout: 5000 });
});

await step('raise hand', async () => {
  await c.page.click('#b-hand');
  await a.page.waitForFunction(() => document.querySelector('#stage').textContent.includes('Hand raised'), null, { timeout: 5000 });
});

await step('the first person leaves; the rest stay, and a newcomer still finds them', async () => {
  await a.page.click('#b-leave');
  await a.page.waitForSelector('#left:not([hidden])');
  await waitTiles(b, 2);
  await waitTiles(c, 2);
  const d = await person('Dee');
  await join(d);
  await waitTiles(d, 3, 30000);
  await waitTiles(b, 3, 30000);
  await d.ctx.close();
});

await step('history saved for the guest', async () => {
  await a.page.click('a[href="/"]');
  await a.page.waitForSelector('#home:not([hidden])');
  await a.page.waitForFunction(() => document.querySelector('#recent-list').textContent.includes('abc-defg-hij'), null, { timeout: 5000 });
});

await step('phone layout has no sideways scroll', async () => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  await page.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: config }));
  await page.route('https://deluxe-main.vercel.app/**', (r) => r.abort());
  for (const url of ['/', `/${code}`]) {
    await page.goto(`http://127.0.0.1:${SITE}${url}`);
    await page.waitForTimeout(800);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no overflow on ${url}`);
  }
  await ctx.close();
});

if (process.env.SHOTS) {
  fs.mkdirSync(process.env.SHOTS, { recursive: true });
  await b.page.screenshot({ path: path.join(process.env.SHOTS, 'call.png') });
  await a.page.screenshot({ path: path.join(process.env.SHOTS, 'home.png') });
}

await browser.close();
site.kill();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
