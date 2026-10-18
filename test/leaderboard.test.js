import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLeaderboard, currentStreak, standingLine, startOfWeekKolkata } from '../leaderboard.js';

test('week starts Monday 00:00 in Kolkata (UTC+5:30)', () => {
  // Monday 19 Oct 2026, 00:10 IST = Sunday 18:40 UTC → this Monday 00:00 IST = Sunday 18:30 UTC.
  assert.equal(startOfWeekKolkata(new Date('2026-10-18T18:40:00Z')).toISOString(), '2026-10-18T18:30:00.000Z');
  // Sunday 25 Oct 2026, 23:50 IST is still the same week.
  assert.equal(startOfWeekKolkata(new Date('2026-10-25T18:20:00Z')).toISOString(), '2026-10-18T18:30:00.000Z');
  // Sunday 18 Oct 2026, 23:50 IST belongs to the week before.
  assert.equal(startOfWeekKolkata(new Date('2026-10-18T18:20:00Z')).toISOString(), '2026-10-11T18:30:00.000Z');
});

const members = [
  { playerId: 'a', name: 'Asha' },
  { playerId: 'b', name: 'Ravi' },
  { playerId: 'c', name: 'Chen' },
  { playerId: 'd', name: 'Dev' },
];
const m = (a, b, winner, day) => ({ player_a: a, player_b: b, winner, played_at: `2026-10-${day}T10:00:00Z` });

test('rank by wins, then win %, then played; ties share a rank; only members count', () => {
  const rows = computeLeaderboard({
    members,
    matches: [
      m('a', 'b', 'a', 10),
      m('a', 'c', 'a', 11),
      m('b', 'c', 'b', 12),
      m('c', 'd', 'c', 13),
      m('d', 'b', null, 14), // tie: played, not won
      m('a', 'x', 'a', 15), // x isn't in the group: ignored
    ],
  });
  assert.deepEqual(
    rows.map((r) => [r.name, r.rank, r.played, r.wins, r.winPct]),
    [
      ['Asha', 1, 2, 2, 100],
      ['Chen', 2, 3, 1, 33],
      ['Ravi', 2, 3, 1, 33],
      ['Dev', 4, 2, 0, 0],
    ]
  );
});

test('week filter counts only recent matches; streak looks at all matches', () => {
  const matches = [m('a', 'b', 'a', 10), m('a', 'b', 'a', 12), m('a', 'b', 'b', 20), m('a', 'b', 'a', 21)];
  const since = new Date('2026-10-19T00:00:00Z');
  const week = computeLeaderboard({ members: members.slice(0, 2), matches, since });
  assert.deepEqual(week.map((r) => [r.name, r.played, r.wins]), [['Asha', 2, 1], ['Ravi', 2, 1]]);
  assert.equal(currentStreak(matches, 'a'), 1);
  assert.equal(currentStreak(matches.slice(0, 2), 'a'), 2);
  assert.equal(currentStreak([...matches, m('a', 'b', null, 22)], 'a'), 0, 'a tie ends a streak');
});

test('standing line: #1, wins behind the player just above, level on wins, no games yet', () => {
  const rows = computeLeaderboard({
    members,
    matches: [m('a', 'b', 'a', 10), m('a', 'c', 'a', 11), m('a', 'd', 'a', 12), m('b', 'c', 'b', 13)],
  });
  assert.equal(standingLine(rows, 'a'), 'You’re #1 👑 — defend it');
  assert.equal(standingLine(rows, 'b'), 'You’re 2 wins behind Asha');
  assert.equal(standingLine(rows, 'c'), 'You’re 1 win behind Ravi');
  const level = computeLeaderboard({ members: members.slice(0, 3), matches: [m('a', 'c', 'a', 1), m('b', 'c', 'b', 2), m('b', 'c', 'c', 3)] });
  assert.equal(standingLine(level, 'b'), 'Level on wins with Asha — win % decides');
  const empty = computeLeaderboard({ members, matches: [] });
  assert.match(standingLine(empty, 'a'), /No games this week/);
  assert.equal(standingLine(empty, 'zz'), '');
});
