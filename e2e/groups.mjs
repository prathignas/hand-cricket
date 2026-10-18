// Groups + leaderboard: create a group, join from a second profile with the invite link,
// play three quick friend matches in dev mode, then check both boards.
// Run with the server on BASE_URL (no Supabase env → in-memory store):
//   PORT=3123 npm start   then   node e2e/groups.mjs
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL ?? 'http://localhost:3123';
const errors = [];
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

async function newProfile(label) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${label} console: ${m.text()}`));
  return { label, page };
}

const text = async (page, selector) => (await page.textContent(selector)).replace(/\s+/g, ' ').trim();
const waitText = (page, selector, pattern, timeout = 20000) =>
  page.waitForFunction(
    ([sel, source]) => new RegExp(source).test(document.querySelector(sel)?.textContent ?? ''),
    [selector, pattern.source],
    { timeout, polling: 100 }
  );
const boardRows = (page) =>
  page.$$eval('.board-table tbody tr', (rows) =>
    rows.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim()))
  );

async function step(name, fn) {
  const started = Date.now();
  await fn();
  console.log(`✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

/** One short match. `winner` is the profile that should win. */
async function quickMatch(asha, ravi, winner) {
  const pages = [asha.page, ravi.page];
  await Promise.all(pages.map((p) => waitText(p, '#panel', /THE TOSS/)));
  await asha.page.waitForTimeout(300);
  const caller = (await asha.page.isVisible('[data-action=call-heads]')) ? asha : ravi;
  await caller.page.click('[data-action=call-heads]');
  await Promise.all(pages.map((p) => waitText(p, '#panel', /WON THE TOSS/)));
  const setter = (await asha.page.isVisible('[data-action=choose-bat]')) ? asha : ravi;
  const chaser = setter === asha ? ravi : asha;
  await setter.page.click('[data-action=choose-bat]');
  await waitText(setter.page, '#message-main', /YOUR BAT/);

  // 1st innings: 2 runs, then out.
  await setter.page.keyboard.press('2');
  await chaser.page.keyboard.press('1');
  await setter.page.keyboard.press('Space');
  await waitText(setter.page, '#message-main', /^\+2$/);
  await chaser.page.keyboard.press('2');
  await waitText(setter.page, '#panel', /OUT!/);
  await setter.page.keyboard.press('Space');
  await chaser.page.keyboard.press('Space');
  await waitText(chaser.page, '#message-main', /YOUR BAT/);

  // 2nd innings: chaser hits 3 to win, or is out first ball.
  await setter.page.keyboard.press('1');
  await chaser.page.keyboard.press(winner === chaser ? '3' : '1');
  await chaser.page.keyboard.press('Space');
  await waitText(winner.page, '#panel', /YOU WON!/);
  return { winner };
}

try {
  const asha = await newProfile('Asha');
  const ravi = await newProfile('Ravi');
  let groupCode;

  await step('home shows "My groups"; create "CSE Gang" → group page', async () => {
    await asha.page.goto(`${BASE}/?dev=1`);
    await asha.page.fill('#name-input', 'Asha');
    await asha.page.waitForSelector('#groups-panel:not([hidden])');
    assert.match(await text(asha.page, '#groups-panel'), /No groups yet/);
    await asha.page.fill('#group-name-input', 'CSE Gang');
    await asha.page.click('[data-group-form=create] button');
    await asha.page.waitForURL('**/group.html?code=*');
    groupCode = new URL(asha.page.url()).searchParams.get('code');
    assert.match(groupCode, /^[A-HJKMNP-Z2-9]{6}$/);
    await waitText(asha.page, '#group-name', /CSE Gang/);
    await waitText(asha.page, '#standing-line', /No games this week yet/);
    await asha.page.click('#copy-invite');
    assert.equal(await asha.page.evaluate(() => navigator.clipboard.readText()), `${BASE}/?group=${groupCode}`);
  });

  await step('invite link in a second profile: enter name → joins → group page', async () => {
    await ravi.page.goto(`${BASE}/?group=${groupCode}&dev=1`);
    await waitText(ravi.page, '#screen', new RegExp(`JOIN GROUP ${groupCode}`));
    assert.equal(await ravi.page.isHidden('#groups-panel'), true);
    await ravi.page.fill('#name-input', 'Ravi');
    await ravi.page.keyboard.press('Enter');
    await ravi.page.waitForURL(`**/group.html?code=${groupCode}`);
    await ravi.page.waitForSelector('.board-table');
    assert.deepEqual((await boardRows(ravi.page)).map((r) => r[1]).sort(), ['Asha', 'RaviYOU']);
  });

  await step('play three friend matches: Ravi wins, then Asha wins twice', async () => {
    await asha.page.goto(BASE);
    await asha.page.click('[data-action=friend]');
    await asha.page.click('[data-action=create]');
    const roomCode = (await asha.page.textContent('.room-code')).replace(/\s/g, '');
    await ravi.page.goto(`${BASE}/?room=${roomCode}`);
    await asha.page.waitForFunction(() => document.body.textContent.includes('Ravi'));
    await asha.page.keyboard.press('Space');
    await ravi.page.click('[data-action=ready]');
    await Promise.all([asha.page.waitForURL('**/friend.html*'), ravi.page.waitForURL('**/friend.html*')]);

    await quickMatch(asha, ravi, ravi);
    await waitText(ravi.page, '#panel', /\+1 win in CSE Gang/);
    await waitText(asha.page, '#panel', /\+1 played in CSE Gang/);
    for (const winner of [asha, asha]) {
      await asha.page.keyboard.press('Space');
      await ravi.page.keyboard.press('Space');
      await quickMatch(asha, ravi, winner);
    }
    await waitText(asha.page, '#panel', /\+1 win in CSE Gang/);
  });

  await step('THIS WEEK board: ranks, wins, win %, streak 🔥, my row, "wins behind" line', async () => {
    await ravi.page.goto(`${BASE}/group.html?code=${groupCode}`);
    await ravi.page.waitForSelector('.board-table');
    const rows = await boardRows(ravi.page);
    assert.deepEqual(rows, [
      ['👑 1', 'Asha', '3', '2', '67%', '🔥 2'],
      ['2', 'RaviYOU', '3', '1', '33%', '—'],
    ]);
    assert.equal(await ravi.page.$eval('tr.is-me td:nth-child(2)', (td) => td.textContent.includes('Ravi')), true);
    assert.equal(await text(ravi.page, '#standing-line'), 'You’re 1 win behind Asha');
    const fits = await ravi.page.evaluate(() => document.documentElement.scrollHeight <= innerHeight);
    assert.equal(fits, true, 'group page fits 1280×720');
  });

  await step('ALL TIME tab shows the same totals (all games are this week)', async () => {
    await ravi.page.click('#tab-all');
    await ravi.page.waitForFunction(() => document.getElementById('tab-all').getAttribute('aria-selected') === 'true');
    await ravi.page.waitForTimeout(300);
    assert.deepEqual((await boardRows(ravi.page))[0], ['👑 1', 'Asha', '3', '2', '67%', '🔥 2']);
  });

  await step('home "My groups" shows the group and the standing line', async () => {
    await asha.page.goto(BASE);
    await waitText(asha.page, '#groups-panel', /CSE Gang/);
    assert.match(await text(asha.page, '#groups-panel'), /2 members · 👑/);
    assert.match(await text(asha.page, '#groups-panel'), /You’re #1 👑 — defend it/);
    const fits = await asha.page.evaluate(() => document.documentElement.scrollHeight <= innerHeight);
    assert.equal(fits, true, 'home fits 1280×720');
  });

  await step('each match was saved exactly once (both players reconnecting doesn\'t double count)', async () => {
    const played = await asha.page.evaluate(async (code) => {
      const res = await fetch(`/api/groups/${code}/leaderboard?range=all`, {
        headers: { 'x-player-id': localStorage.getItem('handCricket.playerId') },
      });
      return (await res.json()).rows.map((r) => r.played);
    }, groupCode);
    assert.deepEqual(played, [3, 3]);
  });

  assert.deepEqual(errors, [], 'no page errors');
  console.log('All group checks passed.');
} finally {
  await browser.close();
}
