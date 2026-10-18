// Hand cricket match rules — the single source of truth for scoring.
//
// Pure functions only: no DOM, no timers, no randomness unless you pass it in.
// Used by both the vs-computer game in the browser (/shared/rules.js) and the server,
// which is the referee for friend matches (friend-game.js).
//
// A match is a plain JSON-safe object, so it can be sent over a socket as-is.
// Functions never mutate their input; they return a new match.

export const MIN_NUMBER = 1;
export const MAX_NUMBER = 6;
export const MILESTONE_RUNS = 50;

export const RESULT = Object.freeze({
  NO_BALL: 'no_ball',
  OUT: 'out',
  RUNS: 'runs',
});

export const STATUS = Object.freeze({
  PLAYING: 'playing',
  INNINGS_BREAK: 'innings_break',
  OVER: 'over',
});

export function isValidNumber(n) {
  return Number.isInteger(n) && n >= MIN_NUMBER && n <= MAX_NUMBER;
}

export function randomBallNumber(random = Math.random) {
  return MIN_NUMBER + Math.floor(random() * (MAX_NUMBER - MIN_NUMBER + 1));
}

export function flipCoin(random = Math.random) {
  return random() < 0.5 ? 'heads' : 'tails';
}

/** @param {[string, string]} playerIds  @param {string} firstBatterId */
export function createMatch(playerIds, firstBatterId) {
  const [a, b] = playerIds;
  if (!a || !b || a === b) throw new Error('createMatch needs two different player ids');
  if (!playerIds.includes(firstBatterId)) throw new Error('First batter must be one of the players');

  return {
    players: [a, b],
    innings: 1,
    firstBatterId,
    batterId: firstBatterId,
    scores: { [a]: 0, [b]: 0 },
    out: { [a]: false, [b]: false },
    target: null, // runs the chaser needs to reach (first innings score + 1)
    status: STATUS.PLAYING,
    winnerId: null,
    isTie: false,
    ballsBowled: 0,
  };
}

export function otherPlayer(match, playerId) {
  return match.players.find((id) => id !== playerId);
}

export function bowlerOf(match) {
  return otherPlayer(match, match.batterId);
}

/** Runs the chaser still needs in the 2nd innings, or null in the 1st. */
export function runsNeeded(match) {
  if (match.innings !== 2 || match.target === null) return null;
  return Math.max(0, match.target - match.scores[match.batterId]);
}

/**
 * Play one ball.
 * @param match
 * @param {Record<string, number|null>} numbers  each player's shown number (null = fist / no hand)
 * @returns {{ match, result }}
 */
export function playBall(match, numbers) {
  if (match.status !== STATUS.PLAYING) {
    throw new Error(`Cannot play a ball while match is "${match.status}"`);
  }

  const batterId = match.batterId;
  const bowlerId = bowlerOf(match);
  const batterNumber = numbers[batterId] ?? null;
  const bowlerNumber = numbers[bowlerId] ?? null;

  const baseResult = {
    batterId,
    bowlerId,
    batterNumber,
    bowlerNumber,
    runs: 0,
    inningsOver: false,
    matchOver: false,
  };

  // A missing or invalid number from either side replays the ball. Nothing changes.
  if (!isValidNumber(batterNumber) || !isValidNumber(bowlerNumber)) {
    const invalidIds = [];
    if (!isValidNumber(batterNumber)) invalidIds.push(batterId);
    if (!isValidNumber(bowlerNumber)) invalidIds.push(bowlerId);
    return { match, result: { ...baseResult, type: RESULT.NO_BALL, invalidIds } };
  }

  const next = {
    ...match,
    scores: { ...match.scores },
    out: { ...match.out },
    ballsBowled: match.ballsBowled + 1,
  };

  if (batterNumber === bowlerNumber) {
    next.out[batterId] = true;
    if (next.innings === 1) {
      next.status = STATUS.INNINGS_BREAK;
      next.target = next.scores[batterId] + 1;
      return { match: next, result: { ...baseResult, type: RESULT.OUT, inningsOver: true } };
    }
    finishMatch(next);
    return {
      match: next,
      result: { ...baseResult, type: RESULT.OUT, inningsOver: true, matchOver: true },
    };
  }

  next.scores[batterId] += batterNumber;
  const result = { ...baseResult, type: RESULT.RUNS, runs: batterNumber };

  if (next.innings === 2 && next.scores[batterId] >= next.target) {
    finishMatch(next);
    result.inningsOver = true;
    result.matchOver = true;
  }

  return { match: next, result };
}

/** True when this ball took the batter from below MILESTONE_RUNS to MILESTONE_RUNS or more. */
export function reachedMilestone(scoreBefore, scoreAfter) {
  return scoreBefore < MILESTONE_RUNS && scoreAfter >= MILESTONE_RUNS;
}

export function startSecondInnings(match) {
  if (match.status !== STATUS.INNINGS_BREAK) {
    throw new Error('Second innings can only start after the first innings ends');
  }
  return {
    ...match,
    innings: 2,
    batterId: otherPlayer(match, match.firstBatterId),
    status: STATUS.PLAYING,
  };
}

// Mutates `match` — only called on a fresh copy inside playBall.
function finishMatch(match) {
  const chaserId = match.batterId;
  const setterId = match.firstBatterId;
  const chaserScore = match.scores[chaserId];
  const setterScore = match.scores[setterId];

  match.status = STATUS.OVER;
  if (chaserScore > setterScore) {
    match.winnerId = chaserId;
  } else if (chaserScore === setterScore) {
    match.isTie = true;
  } else {
    match.winnerId = setterId;
  }
}
