// Friend match UI. The server decides everything; this only renders its snapshots
// ('game-state') and sends this player's inputs: toss call/choice, start-ball, my-number, ready.

import {
  addToRecord,
  breakPanelHtml,
  describeBall,
  escapeHtml,
  launchConfetti,
  loadRecord,
  matchOutcome,
  milestoneMessage,
  overPanelHtml,
  renderBallStrip,
  renderScoreboard,
  restartAnimation,
  showMessage,
  tossPanelHtml,
} from './match-ui.js';
import { playBallSound, playResultSound, sounds } from './sounds.js';

const PHASE = Object.freeze({
  TOSS: 'toss',
  IDLE: 'idle',
  COUNTDOWN: 'countdown',
  NO_BALL: 'no_ball',
  REVEAL: 'reveal',
  NEXT: 'next',
  BREAK: 'break',
  OVER: 'over',
});

const SHOWS_NUMBERS = new Set([PHASE.REVEAL, PHASE.BREAK, PHASE.OVER]);
const recordKey = (friendId) => `handCricket.h2h.${friendId}`;
const RESULT_SOUND_DELAY_MS = 500; // let the ball sound finish before the fanfare
// Video is off from the start of a countdown until the reveal. If the reveal never comes
// (server stalls), turn it back on this long after the countdown should have resolved.
const VIDEO_OFF_FAILSAFE_MS = 4000;
const RECONNECT_GRACE_MS = 15000; // "connection dropped — reconnecting…" before "left"

/**
 * @param {{ socket, playerId: string, els: object, getMyNumber: () => number|null, onBackHome: () => void,
 *           onSendingVideoChange?: (sending: boolean) => void }} options
 */
export function createFriendMatch({ socket, playerId, els, getMyNumber, onBackHome, onSendingVideoChange = () => {} }) {
  let snapshot = null;
  let clockOffset = 0; // server clock minus local clock
  let countdownTimers = [];
  let countdownBallNo = null;
  let sentBallNo = null;
  let lastMessageKey = '';
  let lastPanelKind = '';
  let lastPanelHtml = '';
  let bumpedBallNo = null;
  let isFirstState = true; // a refresh or rejoin lands mid-match: show it, but don't replay sounds
  let celebratedMatch = null;
  let sendingVideo = true;
  let videoFailsafeTimer = 0;
  let friendAwaySince = null; // local time the friend dropped (for the reconnect grace wording)
  let graceTimer = 0;

  const meId = playerId;
  const friendId = () => snapshot?.players.find((id) => id !== meId);
  const friendName = () => snapshot?.names[friendId()] ?? 'Friend';
  const nameOf = (id) => (id === meId ? 'You' : snapshot.names[id] ?? 'Friend');
  const amBatter = () => snapshot?.match?.batterId === meId;
  const toLocalTime = (serverTime) => serverTime - clockOffset;

  // ---- Incoming state -------------------------------------------------------

  function handleState(next) {
    if (snapshot && next.gameId === snapshot.gameId && next.version < snapshot.version) return;
    clockOffset = next.serverNow - Date.now();
    snapshot = next;
    render();
    isFirstState = false;
  }

  // ---- Countdown (in sync with the server's start time) ----------------------

  function syncCountdown() {
    const countdown = snapshot.phase === PHASE.COUNTDOWN ? snapshot.countdown : null;
    if (!countdown) {
      clearCountdown();
      return;
    }
    if (countdownBallNo === countdown.ballNo) return; // already running for this ball
    clearCountdown();
    countdownBallNo = countdown.ballNo;

    for (let step = 0; step < countdown.steps; step++) {
      const showAt = toLocalTime(countdown.startAt + step * countdown.stepMs);
      countdownTimers.push(
        setTimeout(() => {
          els.countdown.hidden = false;
          els.countdownNum.textContent = String(countdown.steps - step);
          restartAnimation(els.countdownNum, 'tick');
          sounds.tick(step === countdown.steps - 1);
        }, Math.max(0, showAt - Date.now()))
      );
    }
    countdownTimers.push(
      setTimeout(() => {
        els.countdown.hidden = true;
        sendMyNumber(countdown.ballNo);
      }, Math.max(0, toLocalTime(countdown.lockAt) - Date.now()))
    );
  }

  /**
   * Anti-peek: stop sending my camera from the start of a countdown until the reveal, so
   * nobody can watch fingers form by hiding their sightscreen. Any other phase (or a pause)
   * turns it straight back on; big moments (break, match end) keep it on.
   */
  function syncOutgoingVideo() {
    const countdown = snapshot.phase === PHASE.COUNTDOWN && !snapshot.paused ? snapshot.countdown : null;
    setSending(!countdown);
    clearTimeout(videoFailsafeTimer);
    if (countdown) {
      const failsafeIn = toLocalTime(countdown.lockAt) - Date.now() + VIDEO_OFF_FAILSAFE_MS;
      videoFailsafeTimer = setTimeout(() => setSending(true), Math.max(0, failsafeIn));
    }
  }

  function setSending(sending) {
    if (sending === sendingVideo) return;
    sendingVideo = sending;
    onSendingVideoChange(sending);
  }

  /** Remember when the friend dropped, and re-render once the grace period is over. */
  function trackFriendAbsence() {
    const friendAway = snapshot.paused && snapshot.joined[friendId()] && !snapshot.present[friendId()];
    if (!friendAway) {
      friendAwaySince = null;
      clearTimeout(graceTimer);
      return;
    }
    if (friendAwaySince !== null) return;
    friendAwaySince = Date.now();
    graceTimer = setTimeout(() => snapshot && render(), RECONNECT_GRACE_MS);
  }

  function clearCountdown() {
    countdownTimers.forEach(clearTimeout);
    countdownTimers = [];
    countdownBallNo = null;
    els.countdown.hidden = true;
  }

  function sendMyNumber(ballNo) {
    if (sentBallNo === ballNo) return;
    sentBallNo = ballNo;
    socket.emit('my-number', { ballNo, number: getMyNumber() });
  }

  // ---- Rendering --------------------------------------------------------------

  function render() {
    const s = snapshot;
    const oppId = friendId();
    const oppName = friendName();
    const lastBall = s.lastBall?.type !== 'no_ball' ? s.lastBall : null;

    const newBall = lastBall && SHOWS_NUMBERS.has(s.phase) && bumpedBallNo !== lastBall.ballNo;
    if (newBall) {
      bumpedBallNo = lastBall.ballNo;
      if (!isFirstState) {
        playBallSound(lastBall);
        if (lastBall.milestone) sounds.fifty();
      }
    }
    renderScoreboard(els, s.match, {
      meId,
      oppId,
      oppName,
      bumpId: newBall && lastBall.runs > 0 ? lastBall.batterId : null,
      idleText: s.phase === PHASE.TOSS ? 'TOSS TIME' : 'ONE WICKET EACH',
    });

    renderBallStrip(els.ballStrip, s.recentBalls ?? []);
    els.sightscreen.classList.toggle('is-down', s.sightscreenDown);
    syncOutgoingVideo();
    trackFriendAbsence();
    renderRevealNumbers(lastBall);
    syncCountdown();
    if (s.phase === PHASE.OVER) {
      recordResult();
      celebrateOnce();
    }

    // Unlike vs-computer, the banner stays up with panels too: it holds Mute and Leave.
    renderPanel(s.paused ? null : panelFor(s, oppId, oppName, lastBall));
    renderBanner(s, oppName, lastBall);
    renderStartButton();
  }

  function renderRevealNumbers(lastBall) {
    const show = Boolean(lastBall?.numbers) && SHOWS_NUMBERS.has(snapshot.phase);
    const pairs = [
      [els.revealMe, meId],
      [els.revealFriend, friendId()],
    ];
    for (const [element, id] of pairs) {
      const text = show ? String(lastBall.numbers[id]) : '';
      if (element.hidden === !show && element.textContent === text) continue;
      element.hidden = !show;
      element.textContent = text;
    }
  }

  function bannerFor(s, oppName, lastBall) {
    if (s.paused) {
      const neverJoined = !s.joined[friendId()];
      // A short drop on mobile data reads as "reconnecting", not "left".
      const inGrace = friendAwaySince !== null && Date.now() - friendAwaySince < RECONNECT_GRACE_MS;
      const sub = neverJoined
        ? `Waiting for ${oppName} to join…`
        : inGrace
          ? `${oppName}’s connection dropped — reconnecting…`
          : `${oppName} left — waiting for them to come back…`;
      return { key: `paused:${neverJoined}:${inGrace}`, main: 'PAUSED', sub, tone: 'info' };
    }
    const batter = s.match ? nameOf(s.match.batterId) : '';
    switch (s.phase) {
      case PHASE.TOSS:
        return { key: 'toss', main: 'THE TOSS', sub: 'Winner picks bat or bowl', tone: 'info' };
      case PHASE.BREAK:
        return { key: 'break', main: 'INNINGS BREAK', sub: 'Both press Ready to start the 2nd innings', tone: 'info' };
      case PHASE.OVER:
        return { key: `over:${s.matchNo}`, main: 'FULL TIME', sub: 'Both press Play again for a rematch', tone: 'info' };
      case PHASE.IDLE: {
        const reason = s.idleReason;
        const main = {
          'hand-not-seen': 'HAND NOT SEEN',
          resume: 'BACK IN THE GAME',
          start: amBatter() ? 'YOUR BAT' : 'YOU’RE BOWLING',
        }[reason];
        const tossNote = reason === 'start' && s.match.innings === 1 && s.ballNo === 0 ? `${tossSummary(s)} ` : '';
        const sub = amBatter()
          ? `${tossNote}Press Space for the ${reason === 'start' ? 'first ball — the rest play automatically' : 'next ball'}`
          : `${tossNote}Waiting for ${batter} to start the ball`;
        return { key: `idle:${reason}:${s.match.innings}:${s.ballNo}`, main, sub, tone: reason === 'hand-not-seen' ? 'noball' : 'info' };
      }
      case PHASE.COUNTDOWN:
        return { key: `countdown:${s.ballNo}`, main: 'BALL INCOMING', sub: 'Hold your number steady…', tone: 'incoming' };
      case PHASE.NO_BALL: {
        const missing = s.lastBall?.invalidIds ?? [];
        const mine = missing.includes(meId);
        const theirs = missing.includes(friendId());
        const sub =
          mine && theirs
            ? 'Neither hand was read. Replaying.'
            : mine
              ? 'Couldn’t read your hand — show 1–5 fingers or 👍 for 6. Replaying.'
              : `${oppName}’s hand wasn’t read. Replaying.`;
        return { key: `noball:${s.ballNo}`, main: 'NO BALL', sub, tone: 'noball' };
      }
      case PHASE.REVEAL: {
        const ball = describeBall(lastBall, { meId, oppName });
        const message = lastBall.milestone
          ? milestoneMessage(lastBall, s.match.scores, { meId, oppName, lastBallText: ball.lastBallText })
          : ball;
        return { key: `reveal:${lastBall.ballNo}`, ...message };
      }
      case PHASE.NEXT:
        return { key: `next:${s.ballNo}`, main: 'NEXT BALL IN 1…', sub: 'Get your hand ready', tone: 'info' };
      default:
        return { key: s.phase, main: 'GET READY', sub: '', tone: 'info' };
    }
  }

  function renderBanner(s, oppName, lastBall) {
    const { key, ...message } = bannerFor(s, oppName, lastBall);
    if (key === lastMessageKey) return; // don't re-pop the same message on every update
    lastMessageKey = key;
    showMessage(els, message);
  }

  function renderStartButton() {
    const s = snapshot;
    const canStart = s.phase === PHASE.IDLE && !s.paused && amBatter();
    els.messageAction.hidden = !canStart;
    if (canStart) {
      els.messageAction.innerHTML = `${s.idleReason === 'start' ? 'Start' : 'Continue'} <kbd>Space</kbd>`;
    }
  }

  function tossSummary(s) {
    const { winnerId, choice } = s.toss ?? {};
    if (!winnerId) return '';
    return winnerId === meId ? `You won the toss and chose to ${choice}.` : `${nameOf(winnerId)} won the toss and chose to ${choice}.`;
  }

  /** Returns { kind, html, tone } or null when no panel should show. */
  function panelFor(s, oppId, oppName, lastBall) {
    if (s.phase === PHASE.TOSS && s.toss) {
      const { stage, call, coin, callerId, winnerId } = s.toss;
      return {
        kind: `toss:${stage}`,
        html: tossPanelHtml({
          stage,
          call,
          coin,
          callerIsMe: callerId === meId,
          callerName: nameOf(callerId),
          iWon: winnerId === meId,
          winnerName: winnerId ? nameOf(winnerId) : '',
          opponentDecision: { lead: `${escapeHtml(nameOf(winnerId ?? oppId))} is choosing to bat or bowl…` },
        }),
      };
    }

    const lastBallText = lastBall ? describeBall(lastBall, { meId, oppName }).lastBallText : '';
    const readyMe = Boolean(s.ready[meId]);
    const readyOpp = Boolean(s.ready[oppId]);

    if (s.phase === PHASE.BREAK) {
      return {
        kind: 'break',
        tone: 'tone-out',
        html: breakPanelHtml({
          match: s.match,
          meId,
          oppName,
          lastBallText,
          readyMe,
          readyOpp,
          buttonHtml: readyMe
            ? `<button class="btn" disabled>Waiting for ${escapeHtml(oppName)}…</button>`
            : '<button class="btn" data-action="game-ready">Ready <kbd>Space</kbd></button>',
        }),
      };
    }

    if (s.phase === PHASE.OVER) {
      const { html, tone } = overPanelHtml({
        match: s.match,
        meId,
        oppId,
        oppName,
        lastBallText,
        record: loadRecord(recordKey(oppId)),
        readyMe,
        readyOpp,
        extraHtml: groupCreditsHtml(s),
        buttonsHtml: `
          ${
            readyMe
              ? `<button class="btn" disabled>Waiting for ${escapeHtml(oppName)}…</button>`
              : '<button class="btn" data-action="game-ready">Play again <kbd>Space</kbd></button>'
          }
          <button class="btn btn-plain" data-action="back-home">Back to home</button>`,
      });
      return { kind: 'over', tone, html };
    }
    return null;
  }

  function renderPanel(panel) {
    if (!panel) {
      lastPanelKind = '';
      lastPanelHtml = '';
      els.panel.innerHTML = '';
      els.panel.className = 'panel box';
      return;
    }
    if (panel.html === lastPanelHtml) return;
    els.panel.innerHTML = panel.html;
    els.panel.className = `panel box ${panel.tone ?? ''}`;
    lastPanelHtml = panel.html;
    // Animate in only when a new panel appears, not when a Ready pill flips.
    if (panel.kind !== lastPanelKind) restartAnimation(els.panel, null);
    lastPanelKind = panel.kind;
  }

  /** "+1 win in CSE Gang" for each group both players are in (the server saves the result). */
  function groupCreditsHtml(s) {
    if (!s.sharedGroups?.length) return '';
    const outcome = matchOutcome(s.match, meId);
    const credit = { won: '+1 win', lost: '+1 played', tied: '+1 tie' }[outcome];
    const pills = s.sharedGroups
      .map(
        (group) =>
          `<a class="group-credit" href="/group.html?code=${encodeURIComponent(group.code)}" target="_blank" rel="noopener">${credit} in ${escapeHtml(group.name)}</a>`
      )
      .join('');
    return `<div class="group-credits">${pills}</div>`;
  }

  /** Result sound + confetti, once per match, and only when it happens live. */
  function celebrateOnce() {
    const key = `${snapshot.gameId}:${snapshot.matchNo}`;
    if (celebratedMatch === key) return;
    celebratedMatch = key;
    if (isFirstState) return;
    const outcome = matchOutcome(snapshot.match, meId);
    setTimeout(() => playResultSound(outcome), RESULT_SOUND_DELAY_MS);
    if (outcome === 'won') launchConfetti();
  }

  /** Count each finished match once in the head-to-head record, even after a refresh. */
  function recordResult() {
    const s = snapshot;
    addToRecord(recordKey(friendId()), matchOutcome(s.match, meId), `${s.gameId}:${s.matchNo}`);
  }

  // ---- Inputs -----------------------------------------------------------------

  const actions = {
    'call-heads': () => socket.emit('toss-call', { call: 'heads' }),
    'call-tails': () => socket.emit('toss-call', { call: 'tails' }),
    'choose-bat': () => socket.emit('toss-choose', { choice: 'bat' }),
    'choose-bowl': () => socket.emit('toss-choose', { choice: 'bowl' }),
    'start-ball': () => socket.emit('start-ball', {}),
    'game-ready': () => socket.emit('game-ready', { ready: true }),
    'back-home': onBackHome,
  };

  /** Returns true if the action belonged to the match. */
  function handleAction(action) {
    if (!actions[action]) return false;
    actions[action]();
    return true;
  }

  /** Space: batter starts the ball; Ready at the break / match end. */
  function handleSpace() {
    const s = snapshot;
    if (!s || s.paused) return;
    if (s.phase === PHASE.IDLE) {
      if (amBatter()) {
        actions['start-ball']();
      } else {
        // Bowler's Space does nothing; nudge them so they know why.
        restartAnimation(els.messageSub, 'pop');
      }
    } else if ((s.phase === PHASE.BREAK || s.phase === PHASE.OVER) && !s.ready[meId]) {
      actions['game-ready']();
    }
  }

  function dispose() {
    clearCountdown();
    clearTimeout(videoFailsafeTimer);
    clearTimeout(graceTimer);
    setSending(true);
  }

  return { handleState, handleAction, handleSpace, dispose };
}
