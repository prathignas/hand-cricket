// Two-player call test: two separate browser profiles (like a normal + incognito window)
// with Chrome's fake camera and mic. Run with the server on BASE_URL:
//   PORT=3123 npm start   then   npm run test:e2e   (runs this and friend-match.mjs)
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL ?? 'http://localhost:3123';
const CALL_TIMEOUT_MS = 30000;
const errors = [];
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

async function newProfile(label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, permissions: ['camera', 'microphone'] });
  // Keep a handle on each RTCPeerConnection so the test can read its stats.
  await context.addInitScript(() => {
    const Original = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = function (...args) {
      const pc = new Original(...args);
      window.__pcs.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = Original.prototype;
  });
  const watch = (page) => {
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${label} console: ${m.text()}`));
    return page;
  };
  return { context, page: watch(await context.newPage()), newPage: async () => watch(await context.newPage()) };
}

const waitForCall = (page, state) =>
  page.waitForFunction((s) => document.getElementById('conn-chip')?.dataset.state === s, state, {
    timeout: CALL_TIMEOUT_MS,
    polling: 200,
  });

async function mediaFromFriend(page) {
  await page.waitForTimeout(1500); // let some packets flow
  return page.evaluate(async () => {
    const pc = window.__pcs.filter((p) => p.connectionState !== 'closed').at(-1);
    const video = document.getElementById('friend-video');
    const bytes = { audio: 0, video: 0 };
    for (const report of (await pc.getStats()).values()) {
      if (report.type === 'inbound-rtp') bytes[report.kind] += report.bytesReceived;
    }
    return { width: video.videoWidth, playing: !video.paused, bytes };
  });
}

function assertMediaFlows(media, who) {
  assert.ok(media.width > 0 && media.playing, `${who} should see the friend's video`);
  assert.ok(media.bytes.audio > 0, `${who} should receive audio`);
  assert.ok(media.bytes.video > 0, `${who} should receive video`);
}

async function step(name, fn) {
  const started = Date.now();
  await fn();
  console.log(`✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

try {
  const host = await newProfile('host');
  const guest = await newProfile('guest');
  let code;
  let guestPage = guest.page;

  await step('lobby → both ready → both open the game screen', async () => {
    await host.page.goto(BASE);
    await host.page.fill('#name-input', 'Asha');
    await host.page.click('[data-action=friend]');
    await host.page.click('[data-action=create]');
    code = (await host.page.textContent('.room-code')).replace(/\s/g, '');
    await guestPage.goto(`${BASE}/?room=${code}`);
    await guestPage.fill('#name-input', 'Ravi');
    await guestPage.keyboard.press('Enter');
    await host.page.waitForFunction(() => document.body.textContent.includes('Ravi'));
    await host.page.keyboard.press('Space');
    await guestPage.click('[data-action=ready]');
    await Promise.all([host.page.waitForURL('**/friend.html?room=*'), guestPage.waitForURL('**/friend.html?room=*')]);
  });

  await step('call connects; video + audio flow both ways', async () => {
    await Promise.all([waitForCall(host.page, 'connected'), waitForCall(guestPage, 'connected')]);
    assertMediaFlows(await mediaFromFriend(host.page), 'host');
    assertMediaFlows(await mediaFromFriend(guestPage), 'guest');
    assert.equal(await host.page.textContent('#friend-name-card'), 'RAVI');
  });

  await step('server controls the sightscreen: down for the toss, no T key any more', async () => {
    await host.page.waitForFunction(() => document.getElementById('sightscreen').classList.contains('is-down'));
    await host.page.keyboard.press('t');
    assert.equal(await host.page.$eval('#sightscreen', (e) => e.classList.contains('is-down')), true);
  });

  await step('M mutes and unmutes the mic', async () => {
    const micEnabled = () =>
      host.page.evaluate(() => document.getElementById('my-video').srcObject.getAudioTracks()[0].enabled);
    await host.page.keyboard.press('m');
    assert.equal(await micEnabled(), false);
    assert.ok(await host.page.isVisible('#mic-chip'));
    await host.page.keyboard.press('m');
    assert.equal(await micEnabled(), true);
  });

  await step('page fits 1280×720 without scrolling', async () => {
    const scrolls = await host.page.evaluate(() => document.documentElement.scrollHeight > innerHeight);
    assert.equal(scrolls, false);
  });

  await step('friend closes the tab → "Friend left"', async () => {
    await guestPage.close();
    await waitForCall(host.page, 'left');
    assert.match(await host.page.textContent('#friend-overlay-text'), /Friend left/);
  });

  await step('friend reopens the link → call comes back', async () => {
    guestPage = await guest.newPage();
    await guestPage.goto(`${BASE}/?room=${code}`);
    await guestPage.waitForURL('**/friend.html?room=*');
    await Promise.all([waitForCall(host.page, 'connected'), waitForCall(guestPage, 'connected')]);
    assertMediaFlows(await mediaFromFriend(host.page), 'host');
  });

  await step('host refreshes → call comes back', async () => {
    await host.page.reload();
    await Promise.all([waitForCall(host.page, 'connected'), waitForCall(guestPage, 'connected')]);
    assertMediaFlows(await mediaFromFriend(guestPage), 'guest');
  });

  await step('Leave → back home; the match ends, so the friend goes back to the lobby', async () => {
    await host.page.click('[data-action=leave]');
    await host.page.waitForURL(`${BASE}/`);
    await guestPage.waitForURL(`**/?room=${code}`);
  });

  assert.deepEqual(errors, [], 'no page errors');
  console.log('All call checks passed.');
} finally {
  await browser.close();
}
