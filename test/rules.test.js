import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as rules from '../shared/rules.js';

const A = 'a';
const B = 'b';
const ball = (match, batterNum, bowlerNum) =>
  rules.playBall(match, { [match.batterId]: batterNum, [rules.bowlerOf(match)]: bowlerNum });

test('different numbers add the batter number', () => {
  const m0 = rules.createMatch([A, B], A);
  const { match, result } = ball(m0, 4, 2);
  assert.equal(result.type, rules.RESULT.RUNS);
  assert.equal(match.scores[A], 4);
  assert.equal(m0.scores[A], 0, 'input match is not mutated');
});

test('null or invalid number is a NO BALL and changes nothing', () => {
  const m0 = rules.createMatch([A, B], A);
  for (const [bat, bowl] of [[null, 3], [3, null], [0, 3], [7, 3], [2.5, 3]]) {
    const { match, result } = ball(m0, bat, bowl);
    assert.equal(result.type, rules.RESULT.NO_BALL);
    assert.equal(match, m0);
  }
});

test('same number = OUT, ends innings 1 and sets target', () => {
  let { match } = ball(rules.createMatch([A, B], A), 5, 1);
  ({ match } = ball(match, 4, 3));
  const { match: m, result } = ball(match, 6, 6);
  assert.equal(result.type, rules.RESULT.OUT);
  assert.equal(result.inningsOver, true);
  assert.equal(result.matchOver, false);
  assert.equal(m.status, rules.STATUS.INNINGS_BREAK);
  assert.equal(m.target, 10);
  assert.throws(() => ball(m, 1, 2));
});

test('chase ends early when the target is passed', () => {
  let { match } = ball(rules.createMatch([A, B], A), 3, 1);
  ({ match } = ball(match, 2, 2));
  match = rules.startSecondInnings(match);
  assert.equal(match.batterId, B);
  assert.equal(rules.runsNeeded(match), 4);
  ({ match } = ball(match, 2, 1));
  assert.equal(rules.runsNeeded(match), 2);
  const { match: done, result } = ball(match, 5, 1);
  assert.equal(result.matchOver, true);
  assert.equal(done.winnerId, B);
  assert.equal(done.scores[B], 7);
});

test('chaser out below target loses; equal scores tie', () => {
  let { match } = ball(rules.createMatch([A, B], A), 3, 1);
  ({ match } = ball(match, 2, 2));
  match = rules.startSecondInnings(match);

  const lost = ball(ball(match, 1, 2).match, 4, 4).match;
  assert.equal(lost.winnerId, A);
  assert.equal(lost.isTie, false);

  const tied = ball(ball(match, 3, 2).match, 4, 4).match;
  assert.equal(tied.isTie, true);
  assert.equal(tied.winnerId, null);
});

test('random numbers are always 1-6 and coin is heads/tails', () => {
  for (const r of [0, 0.1667, 0.5, 0.9999]) assert.ok(rules.isValidNumber(rules.randomBallNumber(() => r)));
  assert.equal(rules.flipCoin(() => 0.1), 'heads');
  assert.equal(rules.flipCoin(() => 0.9), 'tails');
});

test('milestone is reached only on the ball that crosses 50', () => {
  assert.equal(rules.reachedMilestone(48, 52), true);
  assert.equal(rules.reachedMilestone(44, 50), true);
  assert.equal(rules.reachedMilestone(50, 54), false);
  assert.equal(rules.reachedMilestone(40, 49), false);
});
