// Match screen pieces shared by vs-computer (game.js) and vs-friend (friend-match.js):
// scoreboard, banner messages, toss / innings break / match end panels, head-to-head record.
// Everything takes "me", the opponent and the opponent's name, so both modes look identical.

import * as rules from '/shared/rules.js';

// ---- Small helpers ----------------------------------------------------------

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Replay a CSS animation (by class), or the element's own animation when className is null. */
export function restartAnimation(element, className) {
  if (className) element.classList.remove(className);
  else element.style.animation = 'none';
  void element.offsetWidth; // force reflow so the animation replays
  if (className) element.classList.add(className);
  else element.style.animation = '';
}

// Big moments punch in; everything else just pops.
const PUNCH_TONES = new Set(['six', 'out', 'fifty']);

/** Banner: { message, messageMain, messageSub } elements. */
export function showMessage(els, { main, sub = '', tone = 'info' }) {
  els.message.dataset.tone = tone;
  els.messageMain.textContent = main;
  els.messageSub.textContent = sub;
  els.messageMain.classList.remove('pop', 'punch');
  restartAnimation(els.messageMain, PUNCH_TONES.has(tone) ? 'punch' : 'pop');
}

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Lightweight CSS confetti over the whole page; cleans itself up after 3 s. */
export function launchConfetti() {
  if (prefersReducedMotion()) return;
  const colors = ['var(--you)', 'var(--opp)', 'var(--six)', 'var(--paper)', 'var(--out)'];
  const layer = document.createElement('div');
  layer.className = 'confetti';
  layer.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 70; i++) {
    const piece = document.createElement('span');
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${Math.random() * 0.4}s`;
    piece.style.animationDuration = `${1.8 + Math.random() * 0.8}s`;
    piece.style.setProperty('--drift', `${(Math.random() - 0.5) * 160}px`);
    piece.style.setProperty('--spin', `${(Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 540)}deg`);
    layer.append(piece);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 3000);
}

// ---- Last six balls -----------------------------------------------------------

export const BALL_STRIP_LENGTH = 6;

/** "4 · 2 · 6 · W" strip. balls: [{ runs, out }] for the current innings, oldest first. */
export function renderBallStrip(element, balls) {
  const recent = balls.slice(-BALL_STRIP_LENGTH);
  const slots = recent.map(({ runs, out }) => {
    if (out) return '<span class="ball ball-out" title="Out">W</span>';
    const kind = runs === 6 ? 'ball-six' : runs === 4 ? 'ball-four' : '';
    return `<span class="ball ${kind}" title="${runs} run${runs === 1 ? '' : 's'}">${runs}</span>`;
  });
  while (slots.length < BALL_STRIP_LENGTH) slots.push('<span class="ball ball-empty"></span>');
  const html = slots.join('');
  if (element.innerHTML !== html) element.innerHTML = html;
}

// ---- Scoreboard -------------------------------------------------------------

/**
 * @param els  { scoreMe, scoreOpp, roleMe, roleOpp, sideMe, sideOpp, outMe, outOpp, targetBar }
 * @param match  rules.js match, or null before the toss
 */
export function renderScoreboard(els, match, { meId, oppId, oppName, bumpId = null, idleText = 'ONE WICKET EACH' }) {
  const OPP = oppName.toUpperCase();
  const scores = match?.scores ?? { [meId]: 0, [oppId]: 0 };

  els.scoreMe.textContent = scores[meId];
  els.scoreOpp.textContent = scores[oppId];
  if (bumpId === meId) restartAnimation(els.scoreMe, 'bump');
  if (bumpId === oppId) restartAnimation(els.scoreOpp, 'bump');

  const batterId = match && match.status !== rules.STATUS.OVER ? match.batterId : null;
  els.roleMe.textContent = !match ? '—' : match.batterId === meId ? 'BATTING' : 'BOWLING';
  els.roleOpp.textContent = !match ? '—' : match.batterId === oppId ? 'BATTING' : 'BOWLING';
  els.sideMe.classList.toggle('is-batting', batterId === meId);
  els.sideOpp.classList.toggle('is-batting', batterId === oppId);
  els.outMe.hidden = !match?.out[meId];
  els.outOpp.hidden = !match?.out[oppId];

  // Batting / bowling sticker and highlight on the matching video card.
  for (const [card, sticker, id] of [
    [els.cardMe, els.cardRoleMe, meId],
    [els.cardOpp, els.cardRoleOpp, oppId],
  ]) {
    if (!card || !sticker) continue;
    const batting = Boolean(match) && match.batterId === id && match.status !== rules.STATUS.OVER;
    card.classList.toggle('is-batting', batting);
    sticker.hidden = !match || match.status === rules.STATUS.OVER;
    sticker.textContent = batting ? '🏏 BATTING' : '🎯 BOWLING';
    sticker.classList.toggle('is-batting', batting);
  }

  const bar = els.targetBar;
  bar.classList.remove('is-chase', 'opp-chasing');
  if (!match) {
    bar.textContent = idleText;
  } else if (match.status === rules.STATUS.OVER) {
    bar.textContent = match.isTie ? 'MATCH TIED' : match.winnerId === meId ? 'YOU WIN THE MATCH' : `${OPP} WINS`;
  } else if (match.status === rules.STATUS.INNINGS_BREAK) {
    const chaser = rules.otherPlayer(match, match.firstBatterId);
    bar.textContent = `TARGET ${match.target} · ${chaser === meId ? 'YOU BAT' : `${OPP} BATS`} NEXT`;
  } else if (match.innings === 2) {
    const chaserIsMe = match.batterId === meId;
    bar.classList.add('is-chase');
    bar.classList.toggle('opp-chasing', !chaserIsMe);
    bar.textContent = `${chaserIsMe ? 'YOU NEED' : `${OPP} NEEDS`} ${rules.runsNeeded(match)} TO WIN`;
  } else {
    bar.textContent = 'INNINGS 1 OF 2 · ONE WICKET';
  }
}

// ---- Ball result ------------------------------------------------------------

/** Banner text for a played ball (runs or OUT). Returns { main, sub, tone, lastBallText }. */
export function describeBall(result, { meId, oppName }) {
  const myNumber = result.batterId === meId ? result.batterNumber : result.bowlerNumber;
  const oppNumber = result.batterId === meId ? result.bowlerNumber : result.batterNumber;
  const numbers = `You ${myNumber} · ${oppName} ${oppNumber}`;

  if (result.type === rules.RESULT.OUT) {
    const who = result.batterId === meId ? 'You’re out' : `${oppName} is out`;
    const lastBallText = `${numbers} — ${who}`;
    return { main: 'OUT!', sub: lastBallText, tone: 'out', lastBallText };
  }

  const forMe = result.batterId === meId;
  const suffix = result.matchOver ? ' — target chased!' : forMe ? '' : ` to ${oppName}`;
  const lastBallText = `${numbers}${suffix}`;
  return {
    main: result.runs === 6 ? 'SIX!' : `+${result.runs}`,
    sub: lastBallText,
    tone: result.runs === 6 ? 'six' : forMe ? 'runs' : 'runs-opp',
    lastBallText,
  };
}

export function milestoneMessage(result, scores, { meId, oppName, lastBallText }) {
  const who = result.batterId === meId ? 'You' : oppName;
  return { main: 'FIFTY! 🔥', sub: `${who} reached ${scores[result.batterId]} — ${lastBallText}`, tone: 'fifty' };
}

// ---- Panels -----------------------------------------------------------------

function readyRow({ readyMe, readyOpp, oppName }) {
  return `
    <div class="ready-row">
      <span class="ready-pill ${readyMe ? 'is-ready' : ''}">You: ${readyMe ? 'Ready ✓' : 'press Ready'}</span>
      <span class="ready-pill ${readyOpp ? 'is-ready' : ''}">${escapeHtml(oppName)}: ${readyOpp ? 'Ready ✓' : 'not ready'}</span>
    </div>`;
}

/**
 * Toss panel.
 * @param view { stage: 'call'|'flipping'|'choose', call, coin, callerIsMe, callerName, iWon, winnerName,
 *               opponentDecision: { lead, buttonHtml? } shown when the opponent won }
 */
export function tossPanelHtml({ stage, call, coin, callerIsMe, callerName, iWon, winnerName, opponentDecision }) {
  if (stage === 'call') {
    if (!callerIsMe) {
      return `
        <h2>THE TOSS</h2>
        <p class="lead">${escapeHtml(callerName)} is calling…</p>
        <div class="coin is-flipping">?</div>`;
    }
    return `
      <h2>THE TOSS</h2>
      <p class="lead">Heads or tails?</p>
      <div class="coin">?</div>
      <div class="actions">
        <button class="btn" data-action="call-heads">Heads</button>
        <button class="btn btn-pink" data-action="call-tails">Tails</button>
      </div>`;
  }
  if (stage === 'flipping') {
    const who = callerIsMe ? 'You' : escapeHtml(callerName);
    return `
      <h2>THE TOSS</h2>
      <p class="lead">${who} called ${call.toUpperCase()}…</p>
      <div class="coin is-flipping">?</div>`;
  }
  const coinFace = coin === 'heads' ? 'H' : 'T';
  if (iWon) {
    return `
      <h2>IT’S ${coin.toUpperCase()} — YOU WON THE TOSS!</h2>
      <div class="coin">${coinFace}</div>
      <p class="lead">Bat or bowl first?</p>
      <div class="actions">
        <button class="btn" data-action="choose-bat">Bat</button>
        <button class="btn btn-pink" data-action="choose-bowl">Bowl</button>
      </div>`;
  }
  return `
    <h2>IT’S ${coin.toUpperCase()} — ${escapeHtml(winnerName.toUpperCase())} WON THE TOSS</h2>
    <div class="coin">${coinFace}</div>
    <p class="lead">${opponentDecision.lead}</p>
    ${opponentDecision.buttonHtml ? `<div class="actions">${opponentDecision.buttonHtml}</div>` : ''}`;
}

export function breakPanelHtml({ match, meId, oppName, lastBallText, readyMe, readyOpp, buttonHtml }) {
  const setterIsMe = match.firstBatterId === meId;
  const setterScore = match.scores[match.firstBatterId];
  const name = escapeHtml(oppName);
  return `
    <span class="last-ball">${escapeHtml(lastBallText)}</span>
    <h1>OUT!</h1>
    <p class="lead">${setterIsMe ? 'You' : name} scored ${setterScore}.
      ${setterIsMe ? `${name} needs` : 'You need'} ${match.target} to win.</p>
    ${readyRow({ readyMe, readyOpp, oppName })}
    <div class="actions">${buttonHtml}</div>`;
}

/** Returns { html, tone } for the match end panel. */
export function overPanelHtml({ match, meId, oppId, oppName, lastBallText, record, readyMe, readyOpp, buttonsHtml, extraHtml = '' }) {
  const my = match.scores[meId];
  const opp = match.scores[oppId];
  const name = escapeHtml(oppName);
  const outcome = matchOutcome(match, meId);
  const { title, line, tone } = {
    tied: { title: 'TIE!', line: `You and ${name} tied on ${my}`, tone: 'tone-tie' },
    won: { title: 'YOU WON!', line: `You beat ${name} ${my} to ${opp}`, tone: 'tone-won' },
    lost: { title: 'YOU LOST', line: `${name} beat you ${opp} to ${my}`, tone: 'tone-lost' },
  }[outcome];
  const tiedText = record.tied ? `, ${record.tied} tied` : '';

  const html = `
    <span class="last-ball">${escapeHtml(lastBallText)}</span>
    <h1>${title}</h1>
    <p class="lead">${line}</p>
    <p class="muted">Your record vs ${name}: ${record.won} won, ${record.lost} lost${tiedText}</p>
    ${extraHtml}
    ${readyRow({ readyMe, readyOpp, oppName })}
    <div class="actions">${buttonsHtml}</div>`;
  return { html, tone };
}

// ---- Head-to-head record (localStorage) -------------------------------------

export function matchOutcome(match, meId) {
  if (match.isTie) return 'tied';
  return match.winnerId === meId ? 'won' : 'lost';
}

export function loadRecord(key) {
  const empty = { won: 0, lost: 0, tied: 0, counted: [] };
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return empty;
    return {
      won: Number(parsed.won) || 0,
      lost: Number(parsed.lost) || 0,
      tied: Number(parsed.tied) || 0,
      counted: Array.isArray(parsed.counted) ? parsed.counted : [],
    };
  } catch (error) {
    console.warn('Could not read record from localStorage:', error);
    return empty;
  }
}

/**
 * Add one result to the record. `matchKey` (optional) makes it count once, even if the
 * match-end screen is shown again after a refresh or rejoin.
 */
export function addToRecord(key, outcome, matchKey = null) {
  const record = loadRecord(key);
  if (matchKey && record.counted.includes(matchKey)) return record;
  record[outcome] += 1;
  if (matchKey) record.counted = [...record.counted, matchKey].slice(-20);
  try {
    localStorage.setItem(key, JSON.stringify(record));
  } catch (error) {
    console.warn('Could not save record to localStorage:', error);
  }
  return record;
}
