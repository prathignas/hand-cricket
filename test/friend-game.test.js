import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { FriendGame, PHASE, TOSS_STAGE, IDLE_REASON, DEFAULT_TIMING as T } from '../friend-game.js';

const A = 'player-a';
const B = 'player-b';
const COUNTDOWN_MS = T.countdownLeadMs + T.countdownSteps * T.countdownStepMs;

beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'] }));
afterEach(() => mock.timers.reset());

/** A game with both players present. random() always returns `r` (0 → A calls, heads). */
function makeGame({ r = 0 } = {}) {
  const snapshots = [];
  const game = new FriendGame({
    playerIds: [A, B],
    names: { [A]: 'Asha', [B]: 'Ravi' },
    random: () => r,
    onChange: (s) => snapshots.push(s),
  });
  game.setPresence(new Set([A, B]));
  game.startToss();
  return { game, snapshots, last: () => snapshots.at(-1) };
}

/** Toss so that `batter` bats first. A is the caller (random 0) and heads always wins. */
function tossTo(game, batter) {
  game.tossCall(A, 'heads');
  mock.timers.tick(T.coinFlipMs);
  game.tossChoose(A, batter === A ? 'bat' : 'bowl');
}

/** Play one ball from idle or next: wait for the countdown, both submit, resolve. */
function playBall(game, numbers) {
  if (game.phase === PHASE.IDLE) game.startBall(game.match.batterId);
  if (game.phase === PHASE.NEXT) mock.timers.tick(T.nextBallMs);
  assert.equal(game.phase, PHASE.COUNTDOWN);
  mock.timers.tick(COUNTDOWN_MS);
  for (const [id, n] of Object.entries(numbers)) game.submitNumber(id, game.ballNo, n);
}

test('toss: only the caller calls, only the winner chooses, both see the same result', () => {
  const { game, last } = makeGame();
  assert.equal(last().toss.callerId, A);
  assert.equal(game.tossCall(B, 'heads'), false, 'non-caller ignored');
  assert.equal(game.tossCall(A, 'edge'), false, 'bad call ignored');
  assert.equal(game.tossCall(A, 'heads'), true);
  assert.equal(last().toss.stage, TOSS_STAGE.FLIPPING);
  mock.timers.tick(T.coinFlipMs);
  assert.deepEqual([last().toss.stage, last().toss.coin, last().toss.winnerId], [TOSS_STAGE.CHOOSE, 'heads', A]);
  assert.equal(game.tossChoose(B, 'bat'), false, 'loser cannot choose');
  assert.equal(game.tossChoose(A, 'bowl'), true);
  assert.equal(last().phase, PHASE.IDLE);
  assert.equal(last().match.batterId, B);
  assert.equal(last().sightscreenDown, false);
});

test('toss loser can win the flip: caller calls tails, coin lands heads → other player chooses', () => {
  const { game, last } = makeGame();
  game.tossCall(A, 'tails');
  mock.timers.tick(T.coinFlipMs);
  assert.equal(last().toss.winnerId, B);
});

test('only the batter starts a ball; countdown is shared with a start time', () => {
  const { game, last } = makeGame();
  tossTo(game, A);
  assert.equal(game.startBall(B), false, "bowler's Space ignored");
  assert.equal(game.phase, PHASE.IDLE);
  const before = Date.now();
  assert.equal(game.startBall(A), true);
  const { countdown } = last();
  assert.equal(countdown.startAt, before + T.countdownLeadMs);
  assert.equal(countdown.lockAt, countdown.startAt + 3 * T.countdownStepMs);
  assert.deepEqual(last().picked, { [A]: false, [B]: false });
});

test('numbers stay secret in the countdown; early or wrong-ball numbers are ignored', () => {
  const { game, last } = makeGame();
  tossTo(game, A);
  game.startBall(A);
  assert.equal(game.submitNumber(A, game.ballNo, 4), false, 'too early');
  mock.timers.tick(COUNTDOWN_MS);
  assert.equal(game.submitNumber(A, game.ballNo + 1, 4), false, 'wrong ball');
  assert.equal(game.submitNumber(A, game.ballNo, 4), true);
  assert.equal(game.submitNumber(A, game.ballNo, 5), false, 'second pick ignored');
  assert.equal(JSON.stringify(last()).includes('"numbers":{'), false, 'no numbers leaked yet');
  assert.deepEqual(last().picked, { [A]: true, [B]: false });
});

test('runs: reveal drops the sightscreen, then it goes up and the next ball starts by itself', () => {
  const { game, last } = makeGame();
  tossTo(game, A);
  playBall(game, { [A]: 4, [B]: 2 });
  assert.equal(last().phase, PHASE.REVEAL);
  assert.equal(last().sightscreenDown, true);
  assert.deepEqual(last().lastBall.numbers, { [A]: 4, [B]: 2 });
  assert.equal(last().match.scores[A], 4);
  mock.timers.tick(T.revealMs);
  assert.equal(last().phase, PHASE.NEXT);
  assert.equal(last().sightscreenDown, false);
  mock.timers.tick(T.nextBallMs);
  assert.equal(last().phase, PHASE.COUNTDOWN);
  assert.equal(last().ballNo, 2);
});

test('missing number = NO BALL (waits max 1 s); two in a row pauses for the batter', () => {
  const { game, last } = makeGame();
  tossTo(game, A);
  game.startBall(A);
  mock.timers.tick(COUNTDOWN_MS);
  game.submitNumber(A, game.ballNo, 3);
  mock.timers.tick(T.pickGraceMs - 1);
  assert.equal(game.phase, PHASE.COUNTDOWN, 'still waiting for B');
  mock.timers.tick(1);
  assert.equal(last().phase, PHASE.NO_BALL);
  assert.deepEqual(last().lastBall.invalidIds, [B]);
  assert.equal(last().match.scores[A], 0);

  mock.timers.tick(T.noBallMs);
  playBall(game, { [A]: null, [B]: 2 }); // fist from the batter
  assert.equal(last().phase, PHASE.IDLE);
  assert.equal(last().idleReason, IDLE_REASON.HAND_NOT_SEEN);
  assert.equal(game.startBall(B), false);
  assert.equal(game.startBall(A), true);
});

test('OUT → innings break (no timer) → both Ready → 2nd innings → chase win ends early', () => {
  const { game, last } = makeGame();
  tossTo(game, A);
  playBall(game, { [A]: 5, [B]: 1 });
  mock.timers.tick(T.revealMs);
  playBall(game, { [A]: 3, [B]: 3 });
  assert.equal(last().phase, PHASE.BREAK);
  assert.equal(last().sightscreenDown, true);
  assert.equal(last().match.target, 6);
  mock.timers.tick(60_000);
  assert.equal(game.phase, PHASE.BREAK, 'no timer at the break');

  game.setReady(A);
  assert.equal(game.phase, PHASE.BREAK, 'needs both');
  game.setReady(B);
  assert.equal(last().phase, PHASE.IDLE);
  assert.equal(last().match.batterId, B);
  assert.equal(game.startBall(A), false);

  playBall(game, { [B]: 4, [A]: 1 });
  mock.timers.tick(T.revealMs);
  playBall(game, { [B]: 2, [A]: 1 });
  assert.equal(last().phase, PHASE.OVER);
  assert.equal(last().match.winnerId, B);
});

test('tie, then both Ready plays again with a new toss', () => {
  const { game, last } = makeGame();
  tossTo(game, A);
  playBall(game, { [A]: 2, [B]: 1 });
  mock.timers.tick(T.revealMs);
  playBall(game, { [A]: 6, [B]: 6 });
  game.setReady(A);
  game.setReady(B);
  playBall(game, { [B]: 2, [A]: 5 });
  mock.timers.tick(T.revealMs);
  playBall(game, { [B]: 4, [A]: 4 });
  assert.equal(last().match.isTie, true);
  game.setReady(A);
  game.setReady(B);
  assert.equal(last().phase, PHASE.TOSS);
  assert.equal(last().matchNo, 2);
  assert.equal(last().match, null);
});

test('reaching 50 flags a milestone and holds the reveal for 3 s', () => {
  const { game, last } = makeGame();
  tossTo(game, A);
  for (let i = 0; i < 8; i++) {
    playBall(game, { [A]: 6, [B]: 1 });
    assert.equal(last().lastBall.milestone, false);
    mock.timers.tick(T.revealMs);
  }
  playBall(game, { [A]: 6, [B]: 1 }); // 54
  assert.equal(last().lastBall.milestone, true);
  mock.timers.tick(T.revealMs);
  assert.equal(game.phase, PHASE.REVEAL, 'still celebrating');
  mock.timers.tick(T.milestoneMs - T.revealMs);
  assert.equal(game.phase, PHASE.NEXT);
});

test('a player dropping mid-ball pauses; inputs are ignored until they are back; score is kept', () => {
  const { game, last } = makeGame();
  tossTo(game, A);
  playBall(game, { [A]: 4, [B]: 2 });
  mock.timers.tick(T.revealMs + T.nextBallMs); // next countdown running
  game.setPresence(new Set([A]));
  assert.equal(last().paused, true);
  assert.equal(last().phase, PHASE.IDLE);
  assert.equal(last().idleReason, IDLE_REASON.RESUME);
  mock.timers.tick(10_000);
  assert.equal(game.phase, PHASE.IDLE, 'no ball played while paused');
  assert.equal(game.startBall(A), false);

  game.setPresence(new Set([A, B]));
  assert.equal(last().paused, false);
  assert.equal(last().match.scores[A], 4);
  assert.equal(game.startBall(A), true);
});

test('dropping during the break keeps the break, but un-readies the missing player', () => {
  const { game, last } = makeGame();
  tossTo(game, A);
  playBall(game, { [A]: 1, [B]: 1 });
  game.setReady(A);
  game.setPresence(new Set([B]));
  assert.equal(last().phase, PHASE.BREAK);
  assert.equal(last().ready[A], false);
  assert.equal(game.setReady(B), false, 'ignored while paused');
});

test('recent balls: last 6 of the current innings, W for out, reset for the 2nd innings', () => {
  const { game, last } = makeGame();
  tossTo(game, A);
  for (const runs of [1, 2, 3, 4, 5, 6, 4]) {
    playBall(game, { [A]: runs, [B]: runs === 1 ? 2 : 1 });
    mock.timers.tick(T.revealMs);
  }
  assert.deepEqual(last().recentBalls.map((b) => b.runs), [2, 3, 4, 5, 6, 4]);
  playBall(game, { [A]: 3, [B]: 3 });
  assert.deepEqual(last().recentBalls.at(-1), { runs: 0, out: true });
  game.setReady(A);
  game.setReady(B);
  assert.deepEqual(last().recentBalls, []);
});

test('onMatchOver fires once per match with the result and a stable match id', () => {
  const results = [];
  const game = new FriendGame({
    playerIds: [A, B],
    names: { [A]: 'Asha', [B]: 'Ravi' },
    random: () => 0,
    onMatchOver: (result) => results.push(result),
  });
  game.setPresence(new Set([A, B]));
  game.startToss();
  tossTo(game, A);
  playBall(game, { [A]: 3, [B]: 3 });
  game.setReady(A);
  game.setReady(B);
  playBall(game, { [B]: 5, [A]: 1 });
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].scores, { [A]: 0, [B]: 5 });
  assert.equal(results[0].winnerId, B);
  assert.match(results[0].matchId, /^[0-9a-f-]{36}$/);
  game.setPresence(new Set([A]));
  game.setPresence(new Set([A, B])); // reconnecting doesn't fire it again
  assert.equal(results.length, 1);
  game.setReady(A);
  game.setReady(B);
  assert.notEqual(game.matchId, results[0].matchId, 'next match gets a new id');
});
