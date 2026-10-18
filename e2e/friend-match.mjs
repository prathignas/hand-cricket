// Full friend match in dev mode (keys 1–6 instead of the camera), two browser profiles.
// Run with the server on BASE_URL:   PORT=3123 npm start   then   node e2e/friend-match.mjs
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL ?? 'http://localhost:3123';
const errors = [];
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

async function newProfile(label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, permissions: ['camera', 'microphone'] });
  // Keep a handle on each RTCPeerConnection so the test can look at what is being sent and received.
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
  return { label, context, page: watch(await context.newPage()), newPage: async () => watch(await context.newPage()) };
}

const banner = async (page) => `${await page.textContent('#message-main')} | ${await page.textContent('#message-sub')}`;
const panelText = async (page) => (await page.textContent('#panel')).replace(/\s+/g, ' ').trim();
const waitBanner = (page, pattern, timeout = 15000) =>
  page.waitForFunction(
    (source) => new RegExp(source).test(document.getElementById('message-main').textContent),
    pattern.source,
    { timeout, polling: 100 }
  );
const waitPanel = (page, pattern, timeout = 15000) =>
  page.waitForFunction(
    (source) => new RegExp(source).test(document.getElementById('panel').textContent),
    pattern.source,
    { timeout, polling: 100 }
  );
const score = async (page) => `${await page.textContent('#score-me')}-${await page.textContent('#score-opp')}`;
const setNumber = (page, n) => page.keyboard.press(String(n));

/** What this page sends and receives right now. */
const media = (page) =>
  page.evaluate(async () => {
    // The live call, or the last one if the friend just left and it was closed.
    const pc = window.__pcs.filter((p) => p.connectionState !== 'closed').at(-1) ?? window.__pcs.at(-1);
    const sentVideo = pc?.getSenders().find((s) => s.track?.kind === 'video')?.track;
    const preview = document.getElementById('my-video').srcObject?.getVideoTracks()[0];
    // Average brightness of the friend's video as received (0 = black).
    const video = document.getElementById('friend-video');
    const canvas = Object.assign(document.createElement('canvas'), { width: 32, height: 24 });
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, 32, 24);
    const pixels = ctx.getImageData(0, 0, 32, 24).data;
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
    let audioBytes = 0;
    if (pc && pc.connectionState !== 'closed') {
      for (const r of (await pc.getStats()).values()) if (r.type === 'inbound-rtp' && r.kind === 'audio') audioBytes += r.bytesReceived;
    }
    return {
      sendingVideo: sentVideo?.enabled ?? null,
      previewOn: preview?.enabled ?? null,
      friendBrightness: Math.round(sum / (pixels.length / 4) / 3),
      audioBytes,
    };
  });

let debugPages = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
  } catch (error) {
    console.log('  ERRORS', errors);
    for (const p of debugPages) {
      if (!p.isClosed()) console.log('  DEBUG', await banner(p), '| panel:', (await panelText(p)).slice(0, 80), '| score', await score(p));
    }
    throw error;
  }
  console.log(`✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

try {
  const host = await newProfile('Asha');
  const guest = await newProfile('Ravi');
  debugPages = [host.page, guest.page];
  let code;
  let batter; // { page, label } of whoever bats first
  let bowler;

  await step('lobby → game screen in dev mode', async () => {
    await host.page.goto(`${BASE}/?dev=1`);
    await host.page.fill('#name-input', 'Asha');
    await host.page.click('[data-action=friend]');
    await host.page.click('[data-action=create]');
    code = (await host.page.textContent('.room-code')).replace(/\s/g, '');
    await guest.page.goto(`${BASE}/?room=${code}&dev=1`);
    await guest.page.fill('#name-input', 'Ravi');
    await guest.page.keyboard.press('Enter');
    await host.page.waitForFunction(() => document.body.textContent.includes('Ravi'));
    await host.page.keyboard.press('Space');
    await guest.page.click('[data-action=ready]');
    await Promise.all([host.page.waitForURL('**/friend.html?room=*'), guest.page.waitForURL('**/friend.html?room=*')]);
    for (const p of [host.page, guest.page]) assert.match(await p.textContent('#dev-chip'), /DEV/);
  });

  await step('toss: server picks the caller; the other sees "<name> is calling…"', async () => {
    await Promise.all([waitPanel(host.page, /THE TOSS/), waitPanel(guest.page, /THE TOSS/)]);
    await host.page.waitForTimeout(300);
    const hostCalls = await host.page.isVisible('[data-action=call-heads]');
    const [caller, watcher] = hostCalls ? [host, guest] : [guest, host];
    assert.match(await panelText(watcher.page), new RegExp(`${caller.label} is calling`));
    await caller.page.click('[data-action=call-heads]');
    await Promise.all([waitPanel(host.page, /WON THE TOSS/), waitPanel(guest.page, /WON THE TOSS/)]);
    const hostWon = await host.page.isVisible('[data-action=choose-bat]');
    const [winner, loser] = hostWon ? [host, guest] : [guest, host];
    assert.match(await panelText(loser.page), new RegExp(`${winner.label} is choosing`));
    assert.equal((await panelText(loser.page)).match(/IT’S (HEADS|TAILS)/)[1], (await panelText(winner.page)).match(/IT’S (HEADS|TAILS)/)[1]);
    await winner.page.click('[data-action=choose-bat]');
    [batter, bowler] = [winner, loser];
    await waitBanner(batter.page, /YOUR BAT/);
    assert.match(await banner(bowler.page), new RegExp(`Waiting for ${batter.label}`));
  });

  await step("bowler's Space is ignored; only the batter has a Start button", async () => {
    assert.equal(await bowler.page.isVisible('#message-action'), false);
    assert.equal(await batter.page.isVisible('#message-action'), true);
    await bowler.page.keyboard.press('Space');
    await bowler.page.waitForTimeout(1000);
    assert.match(await banner(bowler.page), /BOWLING/);
  });

  await step('runs: synced countdown, sightscreen drops, both numbers on both screens', async () => {
    await setNumber(batter.page, 4);
    await setNumber(bowler.page, 2);
    await batter.page.keyboard.press('Space');
    await Promise.all([waitBanner(batter.page, /BALL INCOMING/), waitBanner(bowler.page, /BALL INCOMING/)]);
    // The 3·2·1 starts at the server's start time, a moment after the banner changes.
    const shownAt = await Promise.all(
      [batter.page, bowler.page].map(async (p) => {
        await p.waitForSelector('#countdown:not([hidden])', { timeout: 3000 });
        return Date.now();
      })
    );
    assert.ok(Math.abs(shownAt[0] - shownAt[1]) < 300, `countdowns in sync (${shownAt[0] - shownAt[1]} ms apart)`);

    // Anti-peek: during the countdown nobody sends video; previews and audio carry on.
    const audioAtStart = (await media(bowler.page)).audioBytes;
    await batter.page.waitForTimeout(900);
    const during = await Promise.all([batter.page, bowler.page].map(media));
    for (const m of during) {
      assert.equal(m.sendingVideo, false, 'outgoing video off during the countdown');
      assert.equal(m.previewOn, true, 'own preview (and hand detection) unaffected');
      assert.ok(m.friendBrightness < 8, `friend's video arrives black (brightness ${m.friendBrightness})`);
    }
    assert.ok(during[1].audioBytes > audioAtStart, 'audio keeps flowing during the countdown');
    await Promise.all([waitBanner(batter.page, /^\+4$/), waitBanner(bowler.page, /^\+4$/)]);
    for (const p of [batter.page, bowler.page]) {
      assert.equal(await p.$eval('#sightscreen', (e) => e.classList.contains('is-down')), true);
    }
    assert.equal(await batter.page.textContent('#reveal-me'), '4');
    assert.equal(await batter.page.textContent('#reveal-friend'), '2');
    assert.equal(await bowler.page.textContent('#reveal-me'), '2');
    assert.equal(await bowler.page.textContent('#reveal-friend'), '4');
    assert.equal(await score(batter.page), '4-0');
    assert.equal(await score(bowler.page), '0-4');
    await batter.page.waitForTimeout(700); // a few frames
    for (const m of await Promise.all([batter.page, bowler.page].map(media))) {
      assert.equal(m.sendingVideo, true, 'video back on at the reveal');
      assert.ok(m.friendBrightness > 20, `friend visible at the reveal (brightness ${m.friendBrightness})`);
    }
  });

  await step('next ball starts by itself; sightscreen goes back up', async () => {
    await waitBanner(batter.page, /NEXT BALL IN 1/);
    assert.equal(await bowler.page.$eval('#sightscreen', (e) => e.classList.contains('is-down')), false);
    await waitBanner(batter.page, /\+4/); // ball 2: same numbers
  });

  await step('NO BALL, then two in a row pauses; batter continues with Space', async () => {
    await setNumber(bowler.page, 0); // no hand
    await waitBanner(bowler.page, /NO BALL/, 20000);
    assert.match(await banner(bowler.page), /Couldn’t read your hand/);
    assert.match(await banner(batter.page), /Ravi|Asha/);
    await waitBanner(batter.page, /HAND NOT SEEN/, 15000);
    assert.equal(await batter.page.isVisible('#message-action'), true);
    assert.equal(await bowler.page.isVisible('#message-action'), false);
    assert.equal(await score(batter.page), '8-0', 'no balls never count');
  });

  await step('FIFTY! 🔥 at 50, then play carries on', async () => {
    await setNumber(batter.page, 6);
    await setNumber(bowler.page, 1);
    await batter.page.keyboard.press('Space');
    await Promise.all([waitBanner(batter.page, /FIFTY/, 90000), waitBanner(bowler.page, /FIFTY/, 90000)]);
    assert.equal(await score(batter.page), '50-0');
  });

  await step('OUT → innings break; sightscreen stays down; needs both Ready', async () => {
    await setNumber(bowler.page, 6); // still inside the FIFTY pause, so the very next ball is OUT
    await Promise.all([waitPanel(batter.page, /OUT!/), waitPanel(bowler.page, /OUT!/)]);
    assert.match(await panelText(bowler.page), new RegExp(`${batter.label} scored 50\\. You need 51 to win`));
    assert.equal(await bowler.page.$eval('#sightscreen', (e) => e.classList.contains('is-down')), true);
    await batter.page.keyboard.press('Space');
    await bowler.page.waitForFunction(() => /Ready ✓/.test(document.getElementById('panel').textContent));
    await waitPanel(batter.page, /Waiting for/);
    await bowler.page.keyboard.press('Space');
    await waitBanner(bowler.page, /YOUR BAT/);
    [batter, bowler] = [bowler, batter];
  });

  await step('friend drops mid-ball → paused; rejoins → score kept, batter continues', async () => {
    await setNumber(batter.page, 5);
    await setNumber(bowler.page, 1);
    await batter.page.keyboard.press('Space');
    await waitBanner(batter.page, /\+5/);
    await waitBanner(batter.page, /BALL INCOMING/);
    const leaver = bowler;
    await leaver.page.close();
    await waitBanner(batter.page, /PAUSED/);
    assert.match(await banner(batter.page), new RegExp(`${leaver.label}’s connection dropped — reconnecting`));
    assert.equal((await media(batter.page)).sendingVideo, true, 'video back on when the game pauses mid-countdown');
    await batter.page.waitForTimeout(3000);
    assert.equal(await score(batter.page), '5-50', 'no balls while paused');

    leaver.page = await leaver.newPage();
    await leaver.page.goto(`${BASE}/?room=${code}&dev=1`);
    await leaver.page.waitForURL('**/friend.html?room=*');
    await waitBanner(leaver.page, /BACK IN THE GAME/);
    assert.equal(await score(leaver.page), '50-5');
    await waitBanner(batter.page, /BACK IN THE GAME/);
    bowler = leaver;
  });

  await step('chase: passing the target ends the match early → result + record', async () => {
    await setNumber(bowler.page, 1);
    await setNumber(batter.page, 6);
    await batter.page.keyboard.press('Space');
    await Promise.all([waitPanel(batter.page, /YOU WON!/, 120000), waitPanel(bowler.page, /YOU LOST/, 120000)]);
    assert.match(await panelText(batter.page), new RegExp(`You beat ${bowler.label} \\d+ to 50`));
    assert.match(await panelText(batter.page), /1 won, 0 lost/);
    assert.match(await panelText(bowler.page), /0 won, 1 lost/);
  });

  await step('play again (both Ready) → new toss → tie', async () => {
    await batter.page.keyboard.press('Space');
    await bowler.page.keyboard.press('Space');
    await Promise.all([waitPanel(host.page, /THE TOSS/), waitPanel(guest.page, /THE TOSS/)]);
    await host.page.waitForTimeout(300);
    const caller = (await host.page.isVisible('[data-action=call-heads]')) ? host : guest;
    await caller.page.click('[data-action=call-heads]');
    await Promise.all([waitPanel(host.page, /WON THE TOSS/), waitPanel(guest.page, /WON THE TOSS/)]);
    const winner = (await host.page.isVisible('[data-action=choose-bat]')) ? host : guest;
    const other = winner === host ? guest : host;
    await winner.page.click('[data-action=choose-bat]');
    await waitBanner(winner.page, /YOUR BAT/);
    // 1st innings: 3 then out. 2nd innings: 3 then out → tie.
    await setNumber(winner.page, 3);
    await setNumber(other.page, 1);
    await winner.page.keyboard.press('Space');
    await waitBanner(winner.page, /\+3/);
    await setNumber(other.page, 3);
    await waitPanel(winner.page, /OUT!/);
    await winner.page.keyboard.press('Space');
    await other.page.keyboard.press('Space');
    await waitBanner(other.page, /YOUR BAT/);
    await setNumber(winner.page, 1);
    await other.page.keyboard.press('Space');
    await waitBanner(other.page, /\+3/);
    await setNumber(winner.page, 3);
    await Promise.all([waitPanel(host.page, /TIE!/), waitPanel(guest.page, /TIE!/)]);
    assert.match(await panelText(host.page), /tied on 3/);
    assert.match(await panelText(host.page), /1 tied/);
  });

  await step('mic meter moves; friend "talking" chip lights up', async () => {
    const sawMyLevel = await host.page.waitForFunction(
      () => Number(document.getElementById('mic-meter-fill').style.transform.match(/[\d.]+/)?.[0]) > 0,
      null,
      { timeout: 10000, polling: 50 }
    );
    assert.ok(sawMyLevel);
    await host.page.waitForFunction(() => !document.getElementById('talking-chip').hidden, null, {
      timeout: 10000,
      polling: 50,
    });
  });

  await step('Back to home → friend goes back to the lobby', async () => {
    await host.page.click('[data-action=back-home]');
    await host.page.waitForURL(`${BASE}/`);
    await guest.page.waitForURL(`**/?room=${code}`);
  });

  assert.deepEqual(errors, [], 'no page errors');
  console.log('All friend match checks passed.');
} finally {
  await browser.close();
}
