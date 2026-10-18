// Server-side referee for one friend match. The server is the source of truth:
// clients only send inputs (toss call/choice, start-ball, my-number, ready) and render
// the snapshots this class publishes through onChange after every change.
//
// Phases: toss → idle → countdown → (no_ball | reveal → next) → … → break → … → over

import * as rules from './public/shared/rules.js';

export const PHASE = Object.freeze({
  TOSS: 'toss',
  IDLE: 'idle', // waiting for the batter's Space
  COUNTDOWN: 'countdown',
  NO_BALL: 'no_ball',
  REVEAL: 'reveal', // sightscreen down, both numbers shown
  NEXT: 'next', // sightscreen back up, next ball in 1…
  BREAK: 'break', // innings break: both press Ready
  OVER: 'over', // match end: both press Ready to play again
});

export const TOSS_STAGE = Object.freeze({ CALL: 'call', FLIPPING: 'flipping', CHOOSE: 'choose', DONE: 'done' });

export const IDLE_REASON = Object.freeze({
  START: 'start', // first ball of an innings
  HAND_NOT_SEEN: 'hand-not-seen', // NO BALL twice in a row
  RESUME: 'resume', // a player dropped mid-ball and came back
});

export const DEFAULT_TIMING = Object.freeze({
  coinFlipMs: 1200,
  countdownLeadMs: 400, // time for the countdown message to reach both players
  countdownStepMs: 500, // 3 · 2 · 1
  countdownSteps: 3,
  pickGraceMs: 1000, // after the countdown ends, wait this long for both numbers
  earlyPickToleranceMs: 300, // numbers sent before the countdown ends (minus this) are ignored
  noBallMs: 1600,
  revealMs: 2500,
  milestoneMs: 3000,
  nextBallMs: 1000,
});

export const MAX_NO_BALLS_IN_A_ROW = 2;
const RECENT_BALLS_KEPT = 6; // for the "4 · 2 · 6 · W" strip

const BALL_PHASES = new Set([PHASE.COUNTDOWN, PHASE.NO_BALL, PHASE.REVEAL, PHASE.NEXT]);
const SIGHTSCREEN_DOWN_PHASES = new Set([PHASE.TOSS, PHASE.REVEAL, PHASE.BREAK, PHASE.OVER]);

export class FriendGame {
  /**
   * @param {{ playerIds: [string, string], names: Record<string, string>, onChange?: (snapshot) => void,
   *           onMatchOver?: (result) => void, random?: () => number, now?: () => number,
   *           timing?: Partial<typeof DEFAULT_TIMING> }} options
   */
  constructor({ playerIds, names, onChange, onMatchOver, random = Math.random, now = Date.now, timing = {} }) {
    this.players = [...playerIds];
    this.names = { ...names };
    this.onChange = onChange;
    this.onMatchOver = onMatchOver;
    this.sharedGroups = []; // [{ code, name }] groups both players are in (shown on the match end screen)
    this.random = random;
    this.now = now;
    this.timing = { ...DEFAULT_TIMING, ...timing };

    this.id = Math.floor(random() * 1e9).toString(36);
    this.version = 0;
    this.matchNo = 0;
    this.present = Object.fromEntries(this.players.map((id) => [id, false]));
    this.joined = Object.fromEntries(this.players.map((id) => [id, false]));
    this.timer = null;
    this.#resetMatchState();
  }

  get paused() {
    return this.players.some((id) => !this.present[id]);
  }

  // ---- Inputs (each one checks the player and the phase, and ignores anything else) ----

  startToss() {
    this.#resetMatchState();
    this.matchNo += 1;
    this.matchId = crypto.randomUUID(); // one id per match, so saving it twice can't double-count
    this.phase = PHASE.TOSS;
    this.toss = { stage: TOSS_STAGE.CALL, callerId: this.#randomPlayer(), call: null, coin: null, winnerId: null, choice: null };
    this.#changed();
  }

  tossCall(playerId, call) {
    if (this.paused || this.phase !== PHASE.TOSS || this.toss.stage !== TOSS_STAGE.CALL) return false;
    if (playerId !== this.toss.callerId || !['heads', 'tails'].includes(call)) return false;

    this.toss = { ...this.toss, stage: TOSS_STAGE.FLIPPING, call };
    this.#changed();
    // The flip finishes even if someone drops meanwhile; nothing is timed against them.
    this.#schedule(this.timing.coinFlipMs, () => {
      const coin = rules.flipCoin(this.random);
      const winnerId = coin === call ? this.toss.callerId : this.#other(this.toss.callerId);
      this.toss = { ...this.toss, stage: TOSS_STAGE.CHOOSE, coin, winnerId };
      this.#changed();
    });
    return true;
  }

  tossChoose(playerId, choice) {
    if (this.paused || this.phase !== PHASE.TOSS || this.toss.stage !== TOSS_STAGE.CHOOSE) return false;
    if (playerId !== this.toss.winnerId || !['bat', 'bowl'].includes(choice)) return false;

    const firstBatterId = choice === 'bat' ? playerId : this.#other(playerId);
    this.toss = { ...this.toss, stage: TOSS_STAGE.DONE, choice };
    this.match = rules.createMatch(this.players, firstBatterId);
    this.#goIdle(IDLE_REASON.START);
    return true;
  }

  /** Only the batter can start a ball, and only while waiting in idle. */
  startBall(playerId) {
    if (this.paused || this.phase !== PHASE.IDLE || playerId !== this.match?.batterId) return false;
    this.noBallStreak = 0;
    this.#beginCountdown();
    return true;
  }

  submitNumber(playerId, ballNo, number) {
    if (this.phase !== PHASE.COUNTDOWN || ballNo !== this.countdown.ballNo) return false;
    if (!this.players.includes(playerId) || playerId in this.picks) return false;
    if (this.now() < this.countdown.lockAt - this.timing.earlyPickToleranceMs) return false;

    this.picks[playerId] = rules.isValidNumber(number) ? number : null;
    if (this.players.every((id) => id in this.picks)) this.#resolveBall();
    else this.#changed(); // shares "has picked", never the number
    return true;
  }

  /** Ready at the innings break (starts the 2nd innings) or match end (plays again). */
  setReady(playerId, ready = true) {
    if (this.paused || (this.phase !== PHASE.BREAK && this.phase !== PHASE.OVER)) return false;
    if (!this.players.includes(playerId)) return false;

    this.ready[playerId] = Boolean(ready);
    if (!this.players.every((id) => this.ready[id])) {
      this.#changed();
      return true;
    }

    if (this.phase === PHASE.BREAK) {
      this.match = rules.startSecondInnings(this.match);
      this.recentBalls = [];
      this.#goIdle(IDLE_REASON.START);
    } else {
      this.startToss();
    }
    return true;
  }

  /** Who currently has the game screen open. Anyone missing pauses the match. */
  setPresence(presentIds, names = {}) {
    const wasPaused = this.paused;
    let changed = false;

    for (const id of this.players) {
      const present = presentIds.has(id);
      if (present) this.joined[id] = true;
      if (present !== this.present[id]) {
        this.present[id] = present;
        changed = true;
        if (!present) this.ready[id] = false;
      }
      if (names[id] && names[id] !== this.names[id]) {
        this.names[id] = names[id];
        changed = true;
      }
    }

    // Dropping mid-ball cancels that ball; the batter restarts once everyone is back.
    if (!wasPaused && this.paused && BALL_PHASES.has(this.phase)) {
      this.#clearTimer();
      this.countdown = null;
      this.picks = {};
      this.phase = PHASE.IDLE;
      this.idleReason = IDLE_REASON.RESUME;
      changed = true;
    }
    if (changed) this.#changed();
  }

  setSharedGroups(groups) {
    if (JSON.stringify(groups) === JSON.stringify(this.sharedGroups)) return;
    this.sharedGroups = groups;
    this.#changed();
  }

  dispose() {
    this.#clearTimer();
    this.onChange = null;
    this.onMatchOver = null;
  }

  // ---- What clients see ----

  snapshot() {
    const inCountdown = this.phase === PHASE.COUNTDOWN;
    return {
      gameId: this.id,
      matchNo: this.matchNo,
      version: this.version,
      serverNow: this.now(),
      phase: this.phase,
      players: [...this.players],
      names: { ...this.names },
      present: { ...this.present },
      joined: { ...this.joined },
      paused: this.paused,
      toss: this.toss ? { ...this.toss } : null,
      match: this.match ? structuredClone(this.match) : null,
      idleReason: this.idleReason,
      ballNo: this.ballNo,
      noBallStreak: this.noBallStreak,
      // Numbers stay secret until the reveal; during the countdown only "has picked" is shared.
      countdown: inCountdown
        ? { ...this.countdown, stepMs: this.timing.countdownStepMs, steps: this.timing.countdownSteps }
        : null,
      picked: inCountdown ? Object.fromEntries(this.players.map((id) => [id, id in this.picks])) : null,
      lastBall: this.lastBall ? structuredClone(this.lastBall) : null,
      recentBalls: this.recentBalls.map((ball) => ({ ...ball })),
      ready: { ...this.ready },
      sightscreenDown: SIGHTSCREEN_DOWN_PHASES.has(this.phase),
      sharedGroups: this.sharedGroups.map((group) => ({ ...group })),
    };
  }

  // ---- Internals ----

  #resetMatchState() {
    this.#clearTimer();
    this.phase = PHASE.TOSS;
    this.toss = null;
    this.match = null;
    this.idleReason = IDLE_REASON.START;
    this.ballNo = 0;
    this.noBallStreak = 0;
    this.countdown = null;
    this.picks = {};
    this.lastBall = null;
    this.recentBalls = []; // this innings' last few balls, oldest first
    this.ready = Object.fromEntries(this.players.map((id) => [id, false]));
  }

  #goIdle(reason) {
    this.#clearTimer();
    this.phase = PHASE.IDLE;
    this.idleReason = reason;
    this.countdown = null;
    this.#changed();
  }

  #beginCountdown() {
    const { countdownLeadMs, countdownStepMs, countdownSteps, pickGraceMs } = this.timing;
    this.ballNo += 1;
    this.picks = {};
    const startAt = this.now() + countdownLeadMs;
    const lockAt = startAt + countdownSteps * countdownStepMs;
    this.countdown = { ballNo: this.ballNo, startAt, lockAt };
    this.phase = PHASE.COUNTDOWN;
    this.#changed();
    this.#schedule(lockAt + pickGraceMs - this.now(), () => this.#resolveBall());
  }

  #resolveBall() {
    this.#clearTimer();
    const numbers = Object.fromEntries(this.players.map((id) => [id, this.picks[id] ?? null]));
    const batterId = this.match.batterId;
    const scoreBefore = this.match.scores[batterId];
    const { match, result } = rules.playBall(this.match, numbers);
    this.countdown = null;
    this.picks = {};

    if (result.type === rules.RESULT.NO_BALL) {
      this.noBallStreak += 1;
      this.lastBall = { ballNo: this.ballNo, ...result, numbers: null };
      if (this.noBallStreak >= MAX_NO_BALLS_IN_A_ROW) {
        this.#goIdle(IDLE_REASON.HAND_NOT_SEEN);
        return;
      }
      this.phase = PHASE.NO_BALL;
      this.#changed();
      this.#schedule(this.timing.noBallMs, () => this.#nextBall());
      return;
    }

    this.noBallStreak = 0;
    this.match = match;
    this.recentBalls = [...this.recentBalls, { runs: result.runs, out: result.type === rules.RESULT.OUT }].slice(
      -RECENT_BALLS_KEPT
    );
    const milestone = rules.reachedMilestone(scoreBefore, match.scores[batterId]);
    this.lastBall = { ballNo: this.ballNo, ...result, numbers, milestone };

    if (result.matchOver || result.inningsOver) {
      // Big moment: sightscreen stays down, no timer, both press Ready.
      this.phase = result.matchOver ? PHASE.OVER : PHASE.BREAK;
      this.ready = Object.fromEntries(this.players.map((id) => [id, false]));
      this.#changed();
      if (result.matchOver) {
        this.onMatchOver?.({
          matchId: this.matchId,
          players: [...this.players],
          names: { ...this.names },
          scores: { ...match.scores },
          winnerId: match.winnerId,
        });
      }
      return;
    }

    this.phase = PHASE.REVEAL;
    this.#changed();
    this.#schedule(milestone ? this.timing.milestoneMs : this.timing.revealMs, () => this.#nextBall());
  }

  #nextBall() {
    this.phase = PHASE.NEXT;
    this.#changed();
    this.#schedule(this.timing.nextBallMs, () => this.#beginCountdown());
  }

  #schedule(ms, fn) {
    this.#clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, Math.max(0, ms));
  }

  #clearTimer() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  #changed() {
    this.version += 1;
    this.onChange?.(this.snapshot());
  }

  #other(playerId) {
    return this.players.find((id) => id !== playerId);
  }

  #randomPlayer() {
    return this.players[Math.floor(this.random() * this.players.length)];
  }
}
