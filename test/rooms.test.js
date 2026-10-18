import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoomStore, RoomError, ROOM_CODE_ALPHABET, EMPTY_ROOM_TTL_MS, REJOIN_WINDOW_MS, isValidCode,
} from '../rooms.js';

const P1 = 'player-one-0001';
const P2 = 'player-two-0002';
const P3 = 'player-three-03';

function makeStore() {
  let time = 1_000_000;
  const store = new RoomStore({ now: () => time });
  return { store, advance: (ms) => { time += ms; } };
}

test('room codes are 4 letters without I, L or O', () => {
  const { store } = makeStore();
  for (let i = 0; i < 200; i++) {
    const room = store.createRoom({ socketId: `s${i}`, playerId: P1, name: 'A' });
    assert.ok(isValidCode(room.code), room.code);
    assert.doesNotMatch(room.code, /[ILO]/);
  }
  assert.equal(ROOM_CODE_ALPHABET.length, 23);
});

test('two players join, a third gets "Room is full"', () => {
  const { store } = makeStore();
  const { code } = store.createRoom({ socketId: 's1', playerId: P1, name: '  Asha  ' });
  const { room } = store.joinRoom({ code: code.toLowerCase(), socketId: 's2', playerId: P2, name: 'Ravi' });
  assert.deepEqual(store.publicView(room).players.map((p) => p.name), ['Asha', 'Ravi']);
  assert.throws(() => store.joinRoom({ code, socketId: 's3', playerId: P3, name: 'Zed' }), /Room is full/);
  assert.throws(() => store.joinRoom({ code: 'ZZZZ', socketId: 's3', playerId: P3, name: 'Zed' }), RoomError);
  assert.throws(() => store.joinRoom({ code, socketId: 's3', playerId: P3, name: '   ' }), /enter your name/);
});

test('ready flags, and they reset when the line-up changes', () => {
  const { store } = makeStore();
  const { code } = store.createRoom({ socketId: 's1', playerId: P1, name: 'A' });
  store.joinRoom({ code, socketId: 's2', playerId: P2, name: 'B' });
  store.setReady('s1', true);
  const room = store.setReady('s2', true);
  assert.ok(room.players.every((p) => p.ready));
  store.disconnect('s2');
  assert.ok(room.players.every((p) => !p.ready));
});

test('disconnect holds the slot; same playerId rejoins into it', () => {
  const { store } = makeStore();
  const { code } = store.createRoom({ socketId: 's1', playerId: P1, name: 'A' });
  store.joinRoom({ code, socketId: 's2', playerId: P2, name: 'B' });
  const room = store.disconnect('s2');
  assert.equal(room.players[1].connected, false);
  const { room: again } = store.joinRoom({ code, socketId: 's2b', playerId: P2, name: 'B' });
  assert.equal(again.players[1].playerId, P2);
  assert.equal(again.players[1].connected, true);
  assert.equal(store.roomOf('s2b').code, code);
});

test('rejoin from a second tab replaces the old connection', () => {
  const { store } = makeStore();
  const { code } = store.createRoom({ socketId: 's1', playerId: P1, name: 'A' });
  const { replacedSocketId } = store.joinRoom({ code, socketId: 's1b', playerId: P1, name: 'A' });
  assert.equal(replacedSocketId, 's1');
  assert.equal(store.roomOf('s1'), null);
  assert.equal(store.rooms.get(code).players.length, 1);
});

test('a new player can take a disconnected slot', () => {
  const { store } = makeStore();
  const { code } = store.createRoom({ socketId: 's1', playerId: P1, name: 'A' });
  store.joinRoom({ code, socketId: 's2', playerId: P2, name: 'B' });
  store.disconnect('s2');
  const { room } = store.joinRoom({ code, socketId: 's3', playerId: P3, name: 'C' });
  assert.deepEqual(room.players.map((p) => p.name), ['A', 'C']);
});

test('leave frees the slot immediately', () => {
  const { store } = makeStore();
  const { code } = store.createRoom({ socketId: 's1', playerId: P1, name: 'A' });
  store.joinRoom({ code, socketId: 's2', playerId: P2, name: 'B' });
  const room = store.leaveRoom('s2');
  assert.equal(room.players.length, 1);
  assert.equal(store.roomOf('s2'), null);
});

test('disconnected slots expire after the rejoin window; empty rooms are deleted after 5 minutes', () => {
  const { store, advance } = makeStore();
  const { code } = store.createRoom({ socketId: 's1', playerId: P1, name: 'A' });
  store.joinRoom({ code, socketId: 's2', playerId: P2, name: 'B' });
  store.disconnect('s2');
  advance(REJOIN_WINDOW_MS);
  store.sweep();
  assert.equal(store.rooms.get(code).players.length, 1);

  store.disconnect('s1');
  advance(EMPTY_ROOM_TTL_MS - 1000);
  assert.deepEqual(store.sweep().deleted, []);
  store.joinRoom({ code, socketId: 's1b', playerId: P1, name: 'A' }); // creator came back in time
  store.leaveRoom('s1b');
  advance(EMPTY_ROOM_TTL_MS);
  assert.deepEqual(store.sweep().deleted, [code]);
  assert.equal(store.rooms.has(code), false);
});

test('room starts "playing" once both are ready and stays started through a disconnect', () => {
  const { store } = makeStore();
  const { code } = store.createRoom({ socketId: 's1', playerId: P1, name: 'A' });
  store.joinRoom({ code, socketId: 's2', playerId: P2, name: 'B' });
  store.setReady('s1', true);
  assert.equal(store.rooms.get(code).stage, 'lobby');
  store.setReady('s2', true);
  assert.equal(store.rooms.get(code).stage, 'playing');
  store.disconnect('s2');
  const { room } = store.joinRoom({ code, socketId: 's2b', playerId: P2, name: 'B', view: 'game' });
  assert.equal(store.publicView(room).stage, 'playing');
  assert.equal(store.publicView(room).players[1].view, 'game');
});

test('every join gets a new session; peerSocketId finds the other connected player', () => {
  const { store } = makeStore();
  const { code } = store.createRoom({ socketId: 's1', playerId: P1, name: 'A' });
  assert.equal(store.peerSocketId('s1'), null);
  const first = store.joinRoom({ code, socketId: 's2', playerId: P2, name: 'B' }).room.players[1].session;
  assert.equal(store.peerSocketId('s1'), 's2');
  assert.equal(store.peerSocketId('s2'), 's1');
  store.disconnect('s2');
  assert.equal(store.peerSocketId('s1'), null);
  const second = store.joinRoom({ code, socketId: 's2b', playerId: P2, name: 'B' }).room.players[1].session;
  assert.notEqual(first, second);
});

test('room version goes up on every change, so clients can ignore stale snapshots', () => {
  const { store } = makeStore();
  const room = store.createRoom({ socketId: 's1', playerId: P1, name: 'A' });
  const seen = [store.publicView(room).version];
  store.joinRoom({ code: room.code, socketId: 's2', playerId: P2, name: 'B' }); seen.push(room.version);
  store.setReady('s1', true); seen.push(room.version);
  store.disconnect('s2'); seen.push(room.version);
  store.joinRoom({ code: room.code, socketId: 's2b', playerId: P2, name: 'B' }); seen.push(room.version);
  store.leaveRoom('s2b'); seen.push(room.version);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], `version ${seen}`);
});

test('leaving or being replaced ends the match (back to lobby); a plain disconnect does not', () => {
  const { store, advance } = makeStore();
  const start = () => {
    const room = store.createRoom({ socketId: 's1', playerId: P1, name: 'A' });
    store.joinRoom({ code: room.code, socketId: 's2', playerId: P2, name: 'B' });
    store.setReady('s1', true);
    store.setReady('s2', true);
    assert.equal(room.stage, 'playing');
    return room;
  };

  let room = start();
  store.disconnect('s2');
  assert.equal(room.stage, 'playing');
  store.leaveRoom('s1');
  assert.equal(room.stage, 'lobby');

  room = start();
  store.disconnect('s2');
  store.joinRoom({ code: room.code, socketId: 's3', playerId: P3, name: 'C' });
  assert.equal(room.stage, 'lobby');

  room = start();
  store.disconnect('s2');
  advance(REJOIN_WINDOW_MS);
  const { changed } = store.sweep();
  assert.ok(changed.includes(room));
  assert.equal(room.stage, 'lobby');
});
