import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GroupsService, GroupsError, toUuid } from '../groups.js';
import { MemoryStore, SupabaseStore } from '../stores.js';

const ASHA = '11111111-1111-4111-8111-111111111111';
const RAVI = '22222222-2222-4222-8222-222222222222';
const CHEN = '33333333-3333-4333-8333-333333333333';
const quietLog = { warn() {}, error() {} };

function service(options = {}) {
  const store = new MemoryStore();
  return { store, groups: new GroupsService({ store, retryDelaysMs: [1, 1], log: quietLog, ...options }) };
}

const NAMES = { [ASHA]: 'Asha', [RAVI]: 'Ravi', [CHEN]: 'Chen' };
const match = (id, a, b, scoreA, scoreB, winnerId) => ({
  id,
  roomCode: 'ABCD',
  players: [{ id: a, name: NAMES[a] }, { id: b, name: NAMES[b] }],
  scores: { [a]: scoreA, [b]: scoreB },
  winnerId,
});

test('player ids: dashed or plain UUIDs only', () => {
  assert.equal(toUuid(ASHA.toUpperCase()), ASHA);
  assert.equal(toUuid(ASHA.replace(/-/g, '')), ASHA);
  assert.equal(toUuid('player-one-0001'), null);
});

test('create a group (6-char code, creator joins), join it, list my groups', async () => {
  const { groups } = service();
  const group = await groups.createGroup(ASHA, 'Asha', '  CSE   Gang ');
  assert.equal(group.name, 'CSE Gang');
  assert.match(group.code, /^[A-HJKMNP-Z2-9]{6}$/);
  await groups.joinGroup(RAVI, 'Ravi', group.code.toLowerCase());
  await groups.joinGroup(RAVI, 'Ravi', group.code); // joining twice is fine
  const mine = await groups.myGroups(RAVI);
  assert.deepEqual(mine.map((g) => [g.code, g.name, g.members]), [[group.code, 'CSE Gang', 2]]);
  await assert.rejects(groups.joinGroup(CHEN, 'Chen', 'ZZZZZZ'), (e) => e instanceof GroupsError && e.status === 404);
  await assert.rejects(groups.createGroup(ASHA, 'Asha', '   '), (e) => e.status === 400);
  await assert.rejects(groups.myGroups('not-a-uuid'), (e) => e.status === 400);
});

test('leaderboard: only members may view; only matches between members count; week vs all', async () => {
  const now = new Date('2026-10-21T12:00:00Z'); // a Wednesday
  const { groups } = service({ now: () => now });
  const { code } = await groups.createGroup(ASHA, 'Asha', 'CSE Gang');
  await groups.joinGroup(RAVI, 'Ravi', code);

  await groups.recordMatch(match('aaaaaaaa-0000-4000-8000-000000000001', ASHA, RAVI, 9, 4, ASHA));
  await groups.recordMatch(match('aaaaaaaa-0000-4000-8000-000000000002', ASHA, CHEN, 5, 3, ASHA)); // Chen isn't a member
  const board = await groups.leaderboard(RAVI, code, 'week');
  assert.deepEqual(board.rows.map((r) => [r.name, r.played, r.wins]), [['Asha', 1, 1], ['Ravi', 1, 0]]);
  assert.equal(board.line, 'You’re 1 win behind Asha');
  assert.equal(board.since, '2026-10-18T18:30:00.000Z');
  await assert.rejects(groups.leaderboard(CHEN, code, 'all'), (e) => e.status === 403);

  // Chen joins later: the old Asha–Chen match now counts too.
  await groups.joinGroup(CHEN, 'Chen', code);
  const all = await groups.leaderboard(ASHA, code, 'all');
  assert.deepEqual(all.rows[0], { playerId: ASHA, name: 'Asha', played: 2, wins: 2, winPct: 100, streak: 2, rank: 1 });
  assert.deepEqual(await groups.sharedGroups(ASHA, CHEN), [{ code, name: 'CSE Gang' }]);
});

test('a match is written once even if saved twice (both players reconnecting, retries)', async () => {
  const { groups, store } = service();
  const result = match('bbbbbbbb-0000-4000-8000-000000000001', ASHA, RAVI, 3, 3, null);
  assert.equal(await groups.recordMatch(result), true);
  assert.equal(await groups.recordMatch(result), true);
  assert.equal(store.matches.size, 1);
  assert.equal([...store.matches.values()][0].winner, null, 'tie = null winner');
});

test('Supabase down: the write is retried, then given up without throwing', async () => {
  const store = new MemoryStore();
  let calls = 0;
  store.insertMatch = async () => {
    calls += 1;
    throw new Error('connection refused');
  };
  const groups = new GroupsService({ store, retryDelaysMs: [1, 1, 1], log: quietLog });
  assert.equal(await groups.recordMatch(match('cccccccc-0000-4000-8000-000000000001', ASHA, RAVI, 1, 0, ASHA)), false);
  assert.equal(calls, 4, 'first try + 3 retries');

  // Recovers on a retry.
  let failuresLeft = 2;
  const store2 = new MemoryStore();
  const realInsert = store2.insertMatch.bind(store2);
  store2.insertMatch = async (row) => {
    if (failuresLeft-- > 0) throw new Error('timeout');
    return realInsert(row);
  };
  const groups2 = new GroupsService({ store: store2, retryDelaysMs: [1, 1, 1], log: quietLog });
  assert.equal(await groups2.recordMatch(match('cccccccc-0000-4000-8000-000000000002', ASHA, RAVI, 1, 0, ASHA)), true);
  assert.equal(store2.matches.size, 1);
});

test('the real SupabaseStore turns an unreachable database into errors the service handles', async () => {
  const store = new SupabaseStore({
    url: 'http://127.0.0.1:9',
    key: 'test-key',
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  });
  const groups = new GroupsService({ store, retryDelaysMs: [1], log: quietLog });
  assert.equal(await groups.recordMatch(match('dddddddd-0000-4000-8000-000000000001', ASHA, RAVI, 1, 0, ASHA)), false);
  await assert.rejects(groups.myGroups(ASHA), /Supabase|fetch failed/);
});
