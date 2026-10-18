import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createGameServer } from '../server.js';

let server;
let url;
const sockets = [];

before(async () => {
  server = createGameServer({
    env: {},
    // Fast clock so the match test runs in well under a second.
    gameTiming: { coinFlipMs: 20, countdownLeadMs: 10, countdownStepMs: 20, pickGraceMs: 200, revealMs: 30, nextBallMs: 20, earlyPickToleranceMs: 1000 },
  });
  await new Promise((resolve) => server.httpServer.listen(0, resolve));
  url = `http://localhost:${server.httpServer.address().port}`;
});

after(async () => {
  for (const s of sockets) s.disconnect();
  server.io.close();
});

function client() {
  const socket = connect(url, { transports: ['websocket'], forceNew: true });
  sockets.push(socket);
  socket.request = (event, payload) => socket.timeout(2000).emitWithAck(event, payload);
  // Resolves with the first room-update matching `predicate` (updates can arrive in any order vs acks).
  socket.waitForUpdate = (predicate) =>
    new Promise((resolve) => {
      const onUpdate = (room) => {
        if (!predicate(room)) return;
        socket.off('room-update', onUpdate);
        resolve(room);
      };
      socket.on('room-update', onUpdate);
    });
  return socket;
}

test('create, join, ready, full room and friend leaving over Socket.io', async () => {
  const a = client();
  const b = client();
  const c = client();

  const created = await a.request('create-room', { playerId: 'player-aaaa-0001', name: 'Asha' });
  assert.equal(created.ok, true);
  const { code } = created.room;

  const aSeesJoin = a.waitForUpdate((room) => room.players.length === 2);
  const joined = await b.request('join-room', { code, playerId: 'player-bbbb-0002', name: 'Ravi' });
  assert.equal(joined.ok, true);
  assert.deepEqual((await aSeesJoin).players.map((p) => p.name), ['Asha', 'Ravi']);

  const full = await c.request('join-room', { code, playerId: 'player-cccc-0003', name: 'Zed' });
  assert.deepEqual(full, { ok: false, error: 'Room is full.' });

  await a.request('set-ready', { ready: true });
  const bothReady = b.waitForUpdate((room) => room.players.every((p) => p.ready));
  await b.request('set-ready', { ready: true });
  await bothReady;

  const aSeesLeft = a.waitForUpdate((room) => room.players[1]?.connected === false);
  b.disconnect();
  await aSeesLeft;

  const b2 = client();
  const aSeesBack = a.waitForUpdate((room) => room.players[1]?.connected === true);
  const rejoined = await b2.request('join-room', { code, playerId: 'player-bbbb-0002', name: 'Ravi' });
  assert.equal(rejoined.ok, true);
  const back = await aSeesBack;
  assert.equal(back.players[1].connected, true);
  assert.equal(back.players[1].name, 'Ravi');
});

test('offer / answer / ice-candidate are relayed only to the other player in the room', async () => {
  const a = client();
  const b = client();
  const outsider = client();
  const { room } = await a.request('create-room', { playerId: 'player-relay-a01', name: 'A' });
  await b.request('join-room', { code: room.code, playerId: 'player-relay-b02', name: 'B' });
  await outsider.request('create-room', { playerId: 'player-relay-c03', name: 'C' });

  let outsiderGotSignal = false;
  for (const event of ['offer', 'answer', 'ice-candidate']) outsider.on(event, () => { outsiderGotSignal = true; });

  const offer = new Promise((resolve) => b.once('offer', resolve));
  a.emit('offer', { callId: 'c1', description: { type: 'offer', sdp: 'x' } });
  assert.deepEqual(await offer, { callId: 'c1', description: { type: 'offer', sdp: 'x' } });

  const answer = new Promise((resolve) => a.once('answer', resolve));
  b.emit('answer', { callId: 'c1', description: { type: 'answer', sdp: 'y' } });
  assert.equal((await answer).callId, 'c1');

  const candidate = new Promise((resolve) => a.once('ice-candidate', resolve));
  b.emit('ice-candidate', { callId: 'c1', candidate: { candidate: 'z' } });
  assert.equal((await candidate).candidate.candidate, 'z');

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(outsiderGotSignal, false);
});

test('/ice gives STUN only without TURN env vars, and adds TURN when set', async () => {
  const { iceConfigFromEnv } = await import('../server.js');
  assert.equal(iceConfigFromEnv({}).iceServers.length, 1);
  const withTurn = iceConfigFromEnv({ TURN_URL: 'turn:a:3478, turns:a:443', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' });
  assert.deepEqual(withTurn.iceServers[1], { urls: ['turn:a:3478', 'turns:a:443'], username: 'u', credential: 'p' });

  const response = await fetch(`${url}/ice`);
  assert.equal(response.status, 200);
  assert.ok(Array.isArray((await response.json()).iceServers));
});

test('/health answers 200', async () => {
  const response = await fetch(`${url}/health`);
  assert.equal(response.status, 200);
});

test('the backend still serves the frontend, including config.js and the shared rules', async () => {
  for (const file of ['/config.js', '/socket.js', '/shared/rules.js']) {
    const response = await fetch(`${url}${file}`);
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get('content-type'), /javascript/, file);
  }
});

test('ALLOWED_ORIGINS: listed origins and same-origin pages may call the server; other sites may not', async () => {
  const { allowedOriginsFromEnv } = await import('../server.js');
  const parsed = allowedOriginsFromEnv({ ALLOWED_ORIGINS: ' https://hc.vercel.app/ ,http://localhost:3000,' });
  assert.deepEqual([...parsed], ['https://hc.vercel.app', 'http://localhost:3000']);

  const split = createGameServer({ env: { ALLOWED_ORIGINS: 'https://hc.vercel.app' } });
  await new Promise((resolve) => split.httpServer.listen(0, resolve));
  const splitUrl = `http://localhost:${split.httpServer.address().port}`;
  const opened = [];
  // Resolves 'connected' or the connect error's message.
  const tryConnect = (origin) =>
    new Promise((resolve) => {
      const socket = connect(splitUrl, { forceNew: true, reconnection: false, extraHeaders: origin ? { origin } : {} });
      opened.push(socket);
      socket.on('connect', () => resolve('connected'));
      socket.on('connect_error', (error) => resolve(error.message));
    });
  try {
    const preflight = await fetch(`${splitUrl}/api/me/groups`, {
      method: 'OPTIONS',
      headers: { origin: 'https://hc.vercel.app', 'access-control-request-headers': 'x-player-id' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://hc.vercel.app');
    assert.match(preflight.headers.get('access-control-allow-headers'), /x-player-id/);

    const ice = await fetch(`${splitUrl}/ice`, { headers: { origin: 'https://hc.vercel.app' } });
    assert.equal(ice.status, 200);
    assert.equal(ice.headers.get('access-control-allow-origin'), 'https://hc.vercel.app');

    const evil = await fetch(`${splitUrl}/ice`, { headers: { origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);

    const sameOrigin = await fetch(`${splitUrl}/health`, { headers: { origin: splitUrl } });
    assert.equal(sameOrigin.status, 200);
    assert.equal((await fetch(`${splitUrl}/health`)).status, 200); // curl, no Origin

    // Socket.io (long-polling first, like a browser): allowed origin connects, another site is refused.
    assert.equal(await tryConnect('https://hc.vercel.app'), 'connected');
    assert.equal(await tryConnect(splitUrl), 'connected');
    assert.notEqual(await tryConnect('https://evil.example'), 'connected');
  } finally {
    for (const socket of opened) socket.disconnect();
    split.io.close();
  }
});

test('friend match over sockets: server runs the toss and the ball, ignores the wrong player', async () => {
  const a = client();
  const b = client();
  const ids = { a: 'player-game-a01', b: 'player-game-b02' };
  const states = { a: [], b: [] };
  a.on('game-state', (state) => states.a.push(state));
  b.on('game-state', (state) => states.b.push(state));
  const waitForState = (socket, predicate) =>
    new Promise((resolve) => {
      const onState = (state) => {
        if (!predicate(state)) return;
        socket.off('game-state', onState);
        resolve(state);
      };
      socket.on('game-state', onState);
    });

  const { room } = await a.request('create-room', { playerId: ids.a, name: 'Asha', view: 'game' });
  await b.request('join-room', { code: room.code, playerId: ids.b, name: 'Ravi', view: 'game' });
  const tossReady = waitForState(a, (s) => s.phase === 'toss' && !s.paused);
  await a.request('set-ready', { ready: true });
  await b.request('set-ready', { ready: true });
  const toss = await tossReady;

  const caller = toss.toss.callerId === ids.a ? a : b;
  const other = caller === a ? b : a;
  other.emit('toss-call', { call: 'heads' }); // not the caller: ignored
  const choosing = waitForState(a, (s) => s.toss?.stage === 'choose');
  caller.emit('toss-call', { call: 'heads' });
  const chosen = await choosing;
  assert.equal(chosen.toss.call, 'heads');

  const winner = chosen.toss.winnerId === ids.a ? a : b;
  const idle = waitForState(b, (s) => s.phase === 'idle');
  winner.emit('toss-choose', { choice: 'bat' });
  const idleState = await idle;
  const batter = idleState.match.batterId === ids.a ? a : b;
  const bowler = batter === a ? b : a;

  bowler.emit('start-ball', {}); // bowler's Space: ignored
  const countdown = waitForState(a, (s) => s.phase === 'countdown');
  batter.emit('start-ball', {});
  const { ballNo } = (await countdown).countdown;

  const reveal = waitForState(a, (s) => s.phase === 'reveal');
  const bRevealArrives = waitForState(b, (s) => s.phase === 'reveal');
  batter.emit('my-number', { ballNo, number: 4 });
  bowler.emit('my-number', { ballNo, number: 2 });
  const revealed = await reveal;
  assert.equal(revealed.match.scores[idleState.match.batterId], 4);
  assert.equal(revealed.sightscreenDown, true);
  // Both players got the same result.
  const bReveal = await bRevealArrives;
  assert.deepEqual(bReveal.lastBall, revealed.lastBall);
  assert.equal(states.a.some((s) => s.phase === 'countdown' && s.ballNo === 0), false);
});

const api = (path, { playerId, method = 'GET', body } = {}) =>
  fetch(`${url}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(playerId ? { 'x-player-id': playerId } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => ({ status: res.status, ...(await res.json()) }));

test('groups API: create, join, list, leaderboard; members only', async () => {
  const asha = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const ravi = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const outsider = 'cccccccc-3333-4333-8333-cccccccccccc';

  assert.equal((await api('/me', { method: 'POST', playerId: asha, body: { name: 'Asha' } })).ok, true);
  const created = await api('/groups', { method: 'POST', playerId: asha, body: { name: 'CSE Gang', playerName: 'Asha' } });
  assert.equal(created.ok, true);
  const { code } = created.group;
  const joined = await api('/groups/join', { method: 'POST', playerId: ravi, body: { code, playerName: 'Ravi' } });
  assert.deepEqual(joined.group, { code, name: 'CSE Gang' });

  const mine = await api('/me/groups', { playerId: ravi });
  assert.equal(mine.groups[0].members, 2);
  const board = await api(`/groups/${code}/leaderboard?range=all`, { playerId: ravi });
  assert.equal(board.range, 'all');
  assert.deepEqual(board.rows.map((r) => r.name).sort(), ['Asha', 'Ravi']);

  assert.equal((await api(`/groups/${code}/leaderboard`, { playerId: outsider })).status, 403);
  assert.equal((await api('/me/groups')).status, 400, 'no player id');
  assert.equal((await api('/groups/join', { method: 'POST', playerId: ravi, body: { code: 'ZZZZZZ', playerName: 'R' } })).status, 404);
  const badJson = await fetch(`${url}/api/groups`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(badJson.status, 400);
});

test('Supabase unreachable: API says "offline" (503), and the service key never reaches the browser', async () => {
  const SECRET = 'super-secret-service-role-key';
  const offline = createGameServer({
    env: { SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: SECRET },
  });
  await new Promise((resolve) => offline.httpServer.listen(0, resolve));
  const base = `http://localhost:${offline.httpServer.address().port}`;
  try {
    const res = await fetch(`${base}/api/me/groups`, { headers: { 'x-player-id': 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' } });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /offline/);
    for (const path of ['/', '/home.js', '/group.html', '/group.js', '/friend.js', '/ice', '/api/me/groups']) {
      const text = await (await fetch(`${base}${path}`)).text();
      assert.equal(text.includes(SECRET), false, `${path} must not contain the key`);
    }
  } finally {
    offline.io.close();
  }
});

test(
  'heartbeat: a 3 s stall is not a disconnect; a silent drop is noticed in about 10 s',
  { skip: process.platform === 'win32' && 'needs SIGSTOP', timeout: 30000 },
  async (t) => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['test/fixtures/frozen-client.mjs', url, 'player-frozen-0001'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      const code = await new Promise((resolve) => child.stdout.once('data', (data) => resolve(String(data).trim())));
      const watcher = client();
      await watcher.request('join-room', { code, playerId: 'player-watch-0002', name: 'Watcher' });
      let droppedAt = null;
      watcher.on('room-update', (room) => {
        if (droppedAt === null && room.players[0]?.connected === false) droppedAt = Date.now();
      });

      // Like a phone in a tunnel for 3 s: pongs come late but within the 5 s timeout.
      child.kill('SIGSTOP');
      await new Promise((resolve) => setTimeout(resolve, 3000));
      child.kill('SIGCONT');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal(droppedAt, null, 'a 3 s stall must not look like leaving');

      // Now the network is really gone.
      const frozenAt = Date.now();
      child.kill('SIGSTOP');
      await new Promise((resolve) => {
        const poll = setInterval(() => droppedAt !== null && (clearInterval(poll), resolve()), 100);
      });
      const detectedIn = droppedAt - frozenAt;
      t.diagnostic(`silent drop noticed in ${detectedIn} ms`);
      assert.ok(detectedIn <= 11000, `noticed in ${detectedIn} ms`);
    } finally {
      child.kill('SIGKILL');
    }
  }
);
