// "Play the Computer" — the screen-side state machine.
// Phases: intro → toss → idle → countdown → reveal → next → … → break → … → over.
// Space starts the first ball of an innings; after that balls play automatically
// until a big moment (OUT, match end), a pause, or the hand goes missing.
// Scoring lives in /shared/rules.js and the shared screen pieces in match-ui.js;
// this file only drives timing for the computer opponent.

import { HandTracker, startCamera } from './hand.js';
import * as rules from '/shared/rules.js';
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
  renderScoreboard as renderSharedScoreboard,
  restartAnimation,
  showMessage as showSharedMessage,
  tossPanelHtml,
} from './match-ui.js';
import { bindSoundToggle, playBallSound, playResultSound, sounds } from './sounds.js';

const ME = 'me';
const CPU = 'cpu';
const OPPONENT_NAME = 'Computer';

const COUNTDOWN_STEP_MS = 500; // 3 · 2 · 1 → 1.5 s total
const REVEAL_MS = 2500;
const NEXT_BALL_DELAY_MS = 1000;
const NO_BALL_MS = 1600;
const MAX_NO_BALLS_IN_A_ROW = 2;
const MILESTONE_PAUSE_MS = 3000;
const COIN_FLIP_MS = 1200;
const RECORD_KEY = 'handCricket.record.computer';
const RESULT_SOUND_DELAY_MS = 500; // let the ball sound finish before the fanfare
const DEBUG = new URLSearchParams(location.search).has('debug');

const PHASE = Object.freeze({
  INTRO: 'intro',
  TOSS: 'toss',
  IDLE: 'idle', // waiting for Space: first ball of an innings, or after a pause
  COUNTDOWN: 'countdown',
  REVEAL: 'reveal',
  NEXT: 'next', // short gap before the next automatic ball
  BREAK: 'break',
  OVER: 'over',
});

const LOOP_PHASES = new Set([PHASE.COUNTDOWN, PHASE.REVEAL, PHASE.NEXT]);

const $ = (id) => document.getElementById(id);
const els = {
  video: $('my-video'),
  overlay: $('my-overlay'),
  sideMe: $('side-me'),
  cardMe: $('card-me'),
  cardOpp: $('card-opp'),
  cardRoleMe: $('card-role-me'),
  cardRoleOpp: $('card-role-opp'),
  ballStrip: $('ball-strip'),
  sideOpp: $('side-opp'),
  scoreMe: $('score-me'),
  scoreOpp: $('score-opp'),
  roleMe: $('role-me'),
  roleOpp: $('role-opp'),
  outMe: $('out-me'),
  outOpp: $('out-opp'),
  targetBar: $('target-bar'),
  badgeValue: $('finger-badge-value'),
  debugReadout: $('debug-readout'),
  revealMe: $('reveal-me'),
  countdown: $('countdown'),
  countdownNum: $('countdown-num'),
  cameraMessage: $('camera-message'),
  cameraMessageText: $('camera-message-text'),
  retryCamera: $('retry-camera'),
  botNumber: $('bot-number'),
  sightscreen: $('sightscreen'),
  message: $('message'),
  messageMain: $('message-main'),
  messageSub: $('message-sub'),
  messageAction: $('message-action'),
  pauseButton: $('pause-button'),
  panel: $('panel'),
};

const state = {
  phase: PHASE.INTRO,
  match: null,
  camera: { status: 'loading', error: null }, // loading | ready | error
  detector: { status: 'loading', error: null, delegate: null },
  toss: null, // { stage: 'call' | 'flipping' | 'result', call, coin, winnerId, cpuChoice }
  idleReason: 'start', // start | paused | hand-not-seen
  pauseRequested: false,
  noBallStreak: 0,
  lastBallText: '',
  ballLog: [], // this innings' balls for the strip: { runs, out }
  debugForcedNumber: null, // ?debug only: keys 1–6 override your hand, 0 clears
};

const tracker = new HandTracker(els.video, els.overlay, { onFrame: updateFingerBadge });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Setup ------------------------------------------------------------------

async function setupCamera() {
  state.camera = { status: 'loading', error: null };
  renderCamera();
  renderPanel();
  try {
    await startCamera(els.video);
    state.camera = { status: 'ready', error: null };
  } catch (error) {
    console.error(error);
    state.camera = { status: 'error', error: error.message };
  }
  startTrackingIfReady();
  renderCamera();
  renderPanel();
}

async function setupDetector() {
  state.detector = { status: 'loading', error: null, delegate: null };
  renderPanel();
  try {
    const delegate = await tracker.init();
    state.detector = { status: 'ready', error: null, delegate };
  } catch (error) {
    console.error('Hand detector failed to load:', error);
    state.detector = {
      status: 'error',
      error: 'The hand detector could not load. Check your internet connection, then press Retry.',
      delegate: null,
    };
  }
  startTrackingIfReady();
  renderPanel();
}

function startTrackingIfReady() {
  if (state.camera.status === 'ready' && state.detector.status === 'ready') tracker.start();
}

const isSetupReady = () => state.camera.status === 'ready' && state.detector.status === 'ready';

// ---- Flow -------------------------------------------------------------------

function setPhase(phase) {
  state.phase = phase;
  renderScoreboard();
  renderPanel();
  renderIdleMessage();
  renderControls();
}

function goIdle(reason) {
  state.idleReason = reason;
  state.pauseRequested = false;
  setPhase(PHASE.IDLE);
}

function goToToss() {
  if (!isSetupReady()) return;
  state.match = null;
  state.toss = { stage: 'call', call: null, coin: null, winnerId: null, cpuChoice: null };
  raiseSightscreen();
  hideReveal();
  setPhase(PHASE.TOSS);
}

async function callToss(call) {
  if (state.phase !== PHASE.TOSS || state.toss.stage !== 'call') return;
  state.toss = { ...state.toss, stage: 'flipping', call };
  renderPanel();
  await sleep(COIN_FLIP_MS);

  const coin = rules.flipCoin();
  const winnerId = coin === call ? ME : CPU;
  const cpuChoice = winnerId === CPU ? (Math.random() < 0.5 ? 'bat' : 'bowl') : null;
  state.toss = { ...state.toss, stage: 'result', coin, winnerId, cpuChoice };
  renderPanel();
}

function beginMatch(firstBatterId) {
  state.match = rules.createMatch([ME, CPU], firstBatterId);
  state.ballLog = [];
  state.toss = null;
  goIdle('start');
}

/** Space in IDLE: play balls back to back until something stops the loop. */
async function startBalls() {
  if (state.phase !== PHASE.IDLE || !tracker.running) return;
  state.pauseRequested = false;
  state.noBallStreak = 0;

  while (true) {
    const keepGoing = await bowlOneBall();
    if (!keepGoing || stopIfPauseRequested()) return;

    setPhase(PHASE.NEXT);
    showMessage({ main: 'NEXT BALL IN 1…', sub: 'Get your hand ready', tone: 'info' });
    await sleep(NEXT_BALL_DELAY_MS);
    if (stopIfPauseRequested()) return;
  }
}

function stopIfPauseRequested() {
  if (!state.pauseRequested) return false;
  goIdle('paused');
  return true;
}

/** Plays one ball. Returns true if the automatic loop should carry on. */
async function bowlOneBall() {
  setPhase(PHASE.COUNTDOWN);
  hideReveal();
  showMessage({ main: 'BALL INCOMING', sub: 'Hold your number steady…', tone: 'incoming' });

  // Each step is timed from the start, so a busy frame can't stretch the countdown.
  els.countdown.hidden = false;
  const countdownStart = performance.now();
  for (const [step, n] of [3, 2, 1].entries()) {
    els.countdownNum.textContent = String(n);
    restartAnimation(els.countdownNum, 'tick');
    sounds.tick(n === 1);
    await sleep(countdownStart + (step + 1) * COUNTDOWN_STEP_MS - performance.now());
  }
  els.countdown.hidden = true;

  const myNumber = state.debugForcedNumber ?? tracker.lockedNumber();
  const cpuNumber = rules.randomBallNumber();
  const { match, result } = rules.playBall(state.match, { [ME]: myNumber, [CPU]: cpuNumber });

  if (result.type === rules.RESULT.NO_BALL) {
    state.noBallStreak += 1;
    if (state.noBallStreak >= MAX_NO_BALLS_IN_A_ROW) {
      goIdle('hand-not-seen');
      return false;
    }
    showMessage({
      main: 'NO BALL',
      sub: 'Couldn’t read your hand — show 1–5 fingers or 👍 for 6. Replaying.',
      tone: 'noball',
    });
    await sleep(NO_BALL_MS);
    return true;
  }
  state.noBallStreak = 0;

  const scoreBefore = state.match.scores[result.batterId];
  state.match = match;
  state.ballLog.push({ runs: result.runs, out: result.type === rules.RESULT.OUT });
  setPhase(PHASE.REVEAL);
  showReveal(myNumber, cpuNumber);
  showResultMessage(result);
  playBallSound(result);
  renderScoreboard({ bumpId: result.runs > 0 ? result.batterId : null });

  if (result.matchOver) {
    const outcome = matchOutcome(match, ME);
    addToRecord(RECORD_KEY, outcome);
    setPhase(PHASE.OVER);
    setTimeout(() => playResultSound(outcome), RESULT_SOUND_DELAY_MS);
    if (outcome === 'won') launchConfetti();
    return false;
  }
  if (result.inningsOver) {
    setPhase(PHASE.BREAK);
    return false;
  }

  const reachedMilestone = rules.reachedMilestone(scoreBefore, match.scores[result.batterId]);
  if (reachedMilestone) {
    showMessage(milestoneMessage(result, match.scores, { meId: ME, oppName: OPPONENT_NAME, lastBallText: state.lastBallText }));
    sounds.fifty();
    await sleep(MILESTONE_PAUSE_MS);
  } else {
    await sleep(REVEAL_MS);
  }

  raiseSightscreen();
  hideReveal();
  return true;
}

function requestPause() {
  if (LOOP_PHASES.has(state.phase)) {
    state.pauseRequested = true;
    renderControls();
  } else if (state.phase === PHASE.IDLE && state.idleReason !== 'start') {
    startBalls(); // P again resumes
  }
}

function startSecondInnings() {
  if (state.phase !== PHASE.BREAK) return;
  state.match = rules.startSecondInnings(state.match);
  state.ballLog = [];
  raiseSightscreen();
  hideReveal();
  goIdle('start');
}

function backToIntro() {
  state.match = null;
  state.toss = null;
  raiseSightscreen();
  hideReveal();
  setPhase(PHASE.INTRO);
}

// ---- Input ------------------------------------------------------------------

const actions = {
  start: goToToss,
  'retry-camera': setupCamera,
  'retry-detector': setupDetector,
  'call-heads': () => callToss('heads'),
  'call-tails': () => callToss('tails'),
  'choose-bat': () => beginMatch(ME),
  'choose-bowl': () => beginMatch(CPU),
  'toss-continue': () => beginMatch(state.toss.cpuChoice === 'bat' ? CPU : ME),
  'next-ball': startBalls,
  pause: requestPause,
  'second-innings': startSecondInnings,
  'play-again': goToToss,
  back: backToIntro,
};

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  actions[button.dataset.action]?.();
});

document.addEventListener('keydown', (event) => {
  if (event.repeat || event.target.closest('input, textarea')) return;

  if (DEBUG && /^Digit[0-6]$/.test(event.code)) {
    const digit = Number(event.code.slice(-1));
    state.debugForcedNumber = digit === 0 ? null : digit;
    return;
  }
  if (event.code === 'KeyP') {
    requestPause();
    return;
  }
  if (event.code !== 'Space') return;
  event.preventDefault();

  // In computer mode the bot can't press Space, so you start the first ball either way.
  // Friend mode (step 4) will only accept Space from the batter.
  const spaceAction = {
    [PHASE.INTRO]: 'start',
    [PHASE.IDLE]: 'next-ball',
    [PHASE.BREAK]: 'second-innings',
    [PHASE.OVER]: 'play-again',
  }[state.phase];
  if (spaceAction) actions[spaceAction]();
});

// ---- Rendering --------------------------------------------------------------

function renderCamera() {
  const { status, error } = state.camera;
  els.cameraMessage.hidden = status === 'ready';
  els.cameraMessage.classList.toggle('is-error', status === 'error');
  els.cameraMessageText.textContent = status === 'error' ? error : 'Starting camera… allow access when asked.';
  els.retryCamera.hidden = status !== 'error';
}

function renderScoreboard({ bumpId = null } = {}) {
  renderSharedScoreboard(els, state.match, { meId: ME, oppId: CPU, oppName: OPPONENT_NAME, bumpId });
  renderBallStrip(els.ballStrip, state.ballLog);
}

function renderIdleMessage() {
  if (state.phase === PHASE.INTRO) {
    showMessage({ main: 'GET READY', sub: 'Allow the camera and wait for the detector', tone: 'info' });
  } else if (state.phase === PHASE.TOSS) {
    showMessage({ main: 'TOSS TIME', sub: 'Call it!', tone: 'info' });
  } else if (state.phase === PHASE.IDLE) {
    if (state.idleReason === 'hand-not-seen') {
      showMessage({ main: 'HAND NOT SEEN', sub: 'Press Space to continue', tone: 'noball' });
    } else if (state.idleReason === 'paused') {
      showMessage({ main: 'PAUSED', sub: 'Press Space to continue', tone: 'info' });
    } else {
      const batting = state.match.batterId === ME;
      showMessage({
        main: batting ? 'YOUR BAT' : 'YOU’RE BOWLING',
        sub: 'Press Space for the first ball — the rest play automatically',
        tone: 'info',
      });
    }
  }
}

function renderControls() {
  const isIdle = state.phase === PHASE.IDLE;
  els.messageAction.hidden = !isIdle;
  els.messageAction.innerHTML = `${state.idleReason === 'start' ? 'Start' : 'Continue'} <kbd>Space</kbd>`;

  els.pauseButton.hidden = !LOOP_PHASES.has(state.phase);
  els.pauseButton.disabled = state.pauseRequested;
  els.pauseButton.innerHTML = state.pauseRequested ? 'Pausing after this ball…' : 'Pause <kbd>P</kbd>';
}

function showMessage(message) {
  showSharedMessage(els, message);
}

function showResultMessage(result) {
  const { lastBallText, ...message } = describeBall(result, { meId: ME, oppName: OPPONENT_NAME });
  state.lastBallText = lastBallText;
  showMessage(message);
}

function showReveal(myNumber, cpuNumber) {
  els.botNumber.textContent = String(cpuNumber);
  els.revealMe.textContent = String(myNumber);
  els.revealMe.hidden = false;
  els.sightscreen.classList.add('is-down');
}

function hideReveal() {
  els.revealMe.hidden = true;
}

function raiseSightscreen() {
  els.sightscreen.classList.remove('is-down');
  // Swap the number only after the screen is back up, so it never flashes.
  setTimeout(() => {
    if (!els.sightscreen.classList.contains('is-down')) els.botNumber.textContent = '?';
  }, 500);
}

function updateFingerBadge({ handSeen, number, analysis }) {
  els.badgeValue.textContent = !handSeen ? '–' : number === null ? '✊' : String(number);

  if (DEBUG) {
    const forced = `forced ${state.debugForcedNumber ?? 'off'} (keys 1–6, 0 clears)`;
    els.debugReadout.hidden = false;
    els.debugReadout.textContent = [
      `detector ${state.detector.delegate ?? state.detector.status}`,
      ...(analysis
        ? [
            `fingers ${analysis.fingerRatios.map((r) => r.toFixed(2)).join(' ')}`,
            `thumb away ${analysis.thumbAwayRatio.toFixed(2)} out ${analysis.thumbOutRatio.toFixed(2)}`,
            `locked ${tracker.lockedNumber() ?? '—'}`,
          ]
        : ['no hand']),
      forced,
    ].join('\n');
  }
}

// ---- Panel ------------------------------------------------------------------

function renderPanel() {
  const panel = els.panel;
  panel.className = 'panel box';
  const html = {
    [PHASE.INTRO]: introPanel,
    [PHASE.TOSS]: tossPanel,
    [PHASE.BREAK]: breakPanel,
    [PHASE.OVER]: overPanel,
  }[state.phase]?.();

  // A panel replaces the banner; break/over panels repeat the last ball inside.
  els.message.hidden = Boolean(html);

  if (!html) {
    panel.innerHTML = '';
    return;
  }
  panel.innerHTML = html;
  if (state.phase === PHASE.OVER) {
    panel.classList.add(overPanel.tone);
  } else if (state.phase === PHASE.BREAK) {
    panel.classList.add('tone-out');
  }
  restartAnimation(panel, null);
}

function statusRow(label, { status, error }, retryAction, readyText) {
  const icon = status === 'ready' ? '✅' : status === 'error' ? '⛔' : '⏳';
  const text = status === 'ready' ? readyText : status === 'error' ? error : 'Loading…';
  const retry =
    status === 'error' ? `<button class="btn btn-small btn-plain" data-action="${retryAction}">Retry</button>` : '';
  return `<li data-state="${status}"><span aria-hidden="true">${icon}</span>
    <span class="status-text">${label}: ${escapeHtml(text)}</span>${retry}</li>`;
}

function introPanel() {
  const ready = isSetupReady();
  return `
    <h1>PLAY THE COMPUTER</h1>
    <p class="lead">Show your number to the camera when the countdown hits zero.</p>
    <div class="legend">
      <span>☝️ – 🖐️ = 1 to 5</span><span>👍 thumb only = 6</span><span>✊ fist = no ball</span><span>same number = OUT</span>
    </div>
    <ul class="status-list">
      ${statusRow('Camera', state.camera, 'retry-camera', 'Ready')}
      ${statusRow('Hand detector', state.detector, 'retry-detector', 'Ready')}
    </ul>
    <div class="actions">
      <button class="btn" data-action="start" ${ready ? '' : 'disabled'}>Start match <kbd>Space</kbd></button>
    </div>`;
}

function tossPanel() {
  const { stage, call, coin, winnerId, cpuChoice } = state.toss;
  return tossPanelHtml({
    stage: stage === 'result' ? 'choose' : stage,
    call,
    coin,
    callerIsMe: true,
    iWon: winnerId === ME,
    winnerName: OPPONENT_NAME,
    opponentDecision: {
      lead: `Computer chose to ${cpuChoice} first. You ${cpuChoice === 'bat' ? 'bowl' : 'bat'}.`,
      buttonHtml: '<button class="btn" data-action="toss-continue">Let’s go</button>',
    },
  });
}

function breakPanel() {
  return breakPanelHtml({
    match: state.match,
    meId: ME,
    oppName: OPPONENT_NAME,
    lastBallText: state.lastBallText,
    readyMe: false,
    readyOpp: true, // the computer is always ready
    buttonHtml: '<button class="btn" data-action="second-innings">Start 2nd innings <kbd>Space</kbd></button>',
  });
}

function overPanel() {
  const { html, tone } = overPanelHtml({
    match: state.match,
    meId: ME,
    oppId: CPU,
    oppName: OPPONENT_NAME,
    lastBallText: state.lastBallText,
    record: loadRecord(RECORD_KEY),
    readyMe: false,
    readyOpp: true,
    buttonsHtml: `
      <button class="btn" data-action="play-again">Play again <kbd>Space</kbd></button>
      <button class="btn btn-plain" data-action="back">Back</button>`,
  });
  overPanel.tone = tone;
  return html;
}

// ---- Boot -------------------------------------------------------------------

bindSoundToggle($('sound-toggle'));
renderScoreboard();
renderIdleMessage();
renderControls();
renderPanel();
setupCamera();
setupDetector();
