// Leaderboard maths. Pure functions: no database, no clock unless you pass one in.

export const RANGE = Object.freeze({ WEEK: 'week', ALL: 'all' });

const KOLKATA_OFFSET_MINUTES = 5 * 60 + 30; // Asia/Kolkata is UTC+5:30 all year (no daylight saving)
const MS_PER_MINUTE = 60 * 1000;

/** Monday 00:00 in Asia/Kolkata for the week containing `now`, as a Date (UTC instant). */
export function startOfWeekKolkata(now = new Date()) {
  // Shift so the UTC fields read as Kolkata wall-clock time.
  const kolkata = new Date(now.getTime() + KOLKATA_OFFSET_MINUTES * MS_PER_MINUTE);
  const daysSinceMonday = (kolkata.getUTCDay() + 6) % 7; // getUTCDay: 0 = Sunday
  const mondayMidnightAsUtc = Date.UTC(
    kolkata.getUTCFullYear(),
    kolkata.getUTCMonth(),
    kolkata.getUTCDate() - daysSinceMonday
  );
  return new Date(mondayMidnightAsUtc - KOLKATA_OFFSET_MINUTES * MS_PER_MINUTE);
}

/** Matches that count for a group: both players are members. */
export function groupMatches(matches, memberIds) {
  const members = new Set(memberIds);
  return matches.filter((m) => members.has(m.player_a) && members.has(m.player_b));
}

/**
 * Leaderboard rows for a group.
 * @param members  [{ playerId, name }]
 * @param matches  [{ player_a, player_b, winner, played_at }] — any order
 * @param since    Date or null; only matches at or after it count for played/wins.
 *                 The current streak always looks at every group match (it's "current", not "this week").
 * @returns rows sorted by rank: { rank, playerId, name, played, wins, winPct, streak }
 */
export function computeLeaderboard({ members, matches, since = null }) {
  const counted = groupMatches(matches, members.map((m) => m.playerId)).sort(
    (a, b) => new Date(a.played_at) - new Date(b.played_at)
  );
  const inRange = since ? counted.filter((m) => new Date(m.played_at) >= since) : counted;

  const rows = members.map(({ playerId, name }) => {
    const mine = inRange.filter((m) => m.player_a === playerId || m.player_b === playerId);
    const wins = mine.filter((m) => m.winner === playerId).length;
    return {
      playerId,
      name,
      played: mine.length,
      wins,
      winPct: mine.length ? Math.round((wins / mine.length) * 100) : 0,
      streak: currentStreak(counted, playerId),
    };
  });

  // Tied rows share a rank; list them by name so the order doesn't jump around.
  rows.sort((a, b) => compareRows(a, b) || a.name.localeCompare(b.name));
  // Equal wins, win % and played share a rank (1, 2, 2, 4).
  rows.forEach((row, i) => {
    row.rank = i > 0 && compareRows(rows[i - 1], row) === 0 ? rows[i - 1].rank : i + 1;
  });
  return rows;
}

/** Ranked by wins, then win %, then games played. */
function compareRows(a, b) {
  return b.wins - a.wins || b.winPct - a.winPct || b.played - a.played || 0;
}

/** Wins in a row counting back from the player's latest match. A loss or tie ends it. */
export function currentStreak(matchesOldestFirst, playerId) {
  let streak = 0;
  for (let i = matchesOldestFirst.length - 1; i >= 0; i--) {
    const m = matchesOldestFirst[i];
    if (m.player_a !== playerId && m.player_b !== playerId) continue;
    if (m.winner !== playerId) break;
    streak += 1;
  }
  return streak;
}

/** "You're 2 wins behind Rahul" / "You're #1 👑 — defend it". Empty if you're not on the board. */
export function standingLine(rows, playerId, range = RANGE.WEEK) {
  const index = rows.findIndex((r) => r.playerId === playerId);
  if (index === -1) return '';
  if (rows.every((r) => r.played === 0)) {
    return range === RANGE.WEEK ? 'No games this week yet — play someone in this group!' : 'No games yet — play someone in this group!';
  }
  const me = rows[index];
  if (me.rank === 1) return 'You’re #1 👑 — defend it';
  const above = rows[index - 1];
  const gap = above.wins - me.wins;
  if (gap === 0) return `Level on wins with ${above.name} — win % decides`;
  return `You’re ${gap} win${gap === 1 ? '' : 's'} behind ${above.name}`;
}
