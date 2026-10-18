// Home screen → Play a Friend → lobby. Talks to the server's room events over Socket.io.
// Screens: home → friend → lobby. Opening /?room=ABCD joins that room once a name is set,
// and /?group=CODE joins that friend group (then opens its leaderboard).

import { connectToServer } from './socket.js';
import { getPlayerId, getSavedName, saveName, cleanName, isDevMode, MAX_NAME_LENGTH } from './player.js';
import { apiRequest, savePlayerName } from './api.js';
import { createGroupsPanel, GROUP_CODE_PATTERN, groupPageUrl } from './home-groups.js';

const REQUEST_TIMEOUT_MS = 6000;
const COPY_STATUS_MS = 2000;
const ENTER_ANIMATION_MS = 600;
const START_DELAY_MS = 900; // let "Both ready! Starting…" show before moving to the game
const CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/; // must match rooms.js

const SCREEN = Object.freeze({ HOME: 'home', FRIEND: 'friend', LOBBY: 'lobby' });

const els = { screen: document.getElementById('screen'), groupsPanel: document.getElementById('groups-panel') };

const state = {
  screen: SCREEN.HOME,
  playerId: getPlayerId(),
  name: getSavedName(),
  pendingCode: null, // from ?room=ABCD
  pendingGroup: null, // from ?group=CODE
  room: null, // { code, players: [{ playerId, name, ready, connected }] }
  error: '',
  notice: '', // e.g. "Friend left"
  busy: false,
  connectionLost: false,
  copyStatus: '',
  starting: false, // both ready: about to open the game screen
  latestBroadcast: null, // newest room-update seen, even before our join reply arrives
};

let socket = null;
let enteringTimer = 0;
const groupsPanel = createGroupsPanel({ element: els.groupsPanel, requireName: () => takeName() });

// ---- Socket -----------------------------------------------------------------

function getSocket() {
  if (socket) return socket;
  socket = connectToServer();

  socket.on('room-update', handleRoomUpdate);

  socket.on('room-closed', ({ reason } = {}) => {
    state.room = null;
    setUrlRoom(null);
    showScreen(SCREEN.HOME, { error: reason || 'You left the room.' });
  });

  socket.on('disconnect', () => {
    if (!state.room) return;
    state.connectionLost = true;
    render();
  });

  // After a dropped connection the server sees a new socket, so rejoin our slot.
  socket.io.on('reconnect', async () => {
    if (!state.room) return;
    const response = await request('join-room', {
      code: state.room.code,
      playerId: state.playerId,
      name: state.name,
      view: 'lobby',
    });
    state.connectionLost = false;
    if (response.ok) {
      handleRoomUpdate(response.room);
    } else {
      state.room = null;
      setUrlRoom(null);
      showScreen(SCREEN.HOME, { error: response.error });
    }
  });

  return socket;
}

async function request(event, payload) {
  try {
    return await getSocket().timeout(REQUEST_TIMEOUT_MS).emitWithAck(event, payload);
  } catch (error) {
    console.error(`"${event}" got no answer:`, error);
    return { ok: false, error: 'Could not reach the game server. Check it is running, then try again.' };
  }
}

// ---- Actions ----------------------------------------------------------------

/** Validates and saves the name field. Returns the name, or null (and shows an error). */
function takeName() {
  const input = document.getElementById('name-input');
  const name = cleanName(input ? input.value : state.name);
  if (!name) {
    state.error = 'Type your name first — your friend will see it.';
    render();
    document.getElementById('name-input')?.focus();
    return null;
  }
  if (name !== state.savedOnServer) {
    savePlayerName(name); // keeps the name on leaderboards up to date
    state.savedOnServer = name;
  }
  state.name = name;
  saveName(name);
  return name;
}

/** From an invite link: join the group, then open its leaderboard. */
async function joinPendingGroup() {
  const name = takeName();
  if (!name || state.busy) return;
  state.busy = true;
  render();
  const response = await apiRequest('/groups/join', { method: 'POST', body: { code: state.pendingGroup, playerName: name } });
  state.busy = false;
  if (response.ok) {
    location.href = groupPageUrl(response.group.code);
    return;
  }
  state.pendingGroup = null;
  history.replaceState(null, '', '/');
  showScreen(SCREEN.HOME, { error: response.error });
}

async function createRoom() {
  const name = takeName();
  if (!name || state.busy) return;
  await enterRoom('create-room', { playerId: state.playerId, name, view: 'lobby' });
}

async function joinRoom(code) {
  const name = takeName();
  if (!name || state.busy) return;
  const normalized = String(code ?? '').trim().toUpperCase();
  if (!CODE_PATTERN.test(normalized)) {
    state.error = 'Room codes are 4 letters, like KBRX.';
    render();
    return;
  }
  await enterRoom('join-room', { code: normalized, playerId: state.playerId, name, view: 'lobby' });
}

async function enterRoom(event, payload) {
  state.busy = true;
  state.error = '';
  render();
  const response = await request(event, payload);
  state.busy = false;

  if (!response.ok) {
    state.pendingCode = null;
    setUrlRoom(null);
    showScreen(state.screen, { error: response.error });
    return;
  }
  state.pendingCode = null;
  state.notice = '';
  // A broadcast can be handled before the join reply; keep whichever snapshot is newer.
  const broadcast = state.latestBroadcast;
  state.room =
    broadcast?.code === response.room.code && broadcast.version > response.room.version ? broadcast : response.room;
  setUrlRoom(state.room.code);
  showScreen(SCREEN.LOBBY);
  if (state.room.stage === 'playing') startGame();
}

/** Both players are ready (or the match already started): open the game screen. */
function startGame() {
  if (state.starting) return;
  state.starting = true;
  state.notice = '';
  render();
  setTimeout(() => {
    location.href = `/friend.html?room=${state.room.code}`;
  }, START_DELAY_MS);
}

async function toggleReady() {
  const me = myPlayer();
  if (!me || state.connectionLost || state.starting) return;
  const response = await request('set-ready', { ready: !me.ready });
  if (!response.ok) {
    state.error = response.error;
    render();
  }
}

async function leaveRoom() {
  await request('leave-room', {});
  state.room = null;
  state.notice = '';
  setUrlRoom(null);
  showScreen(SCREEN.FRIEND);
}

async function copyLink() {
  const link = `${location.origin}/?room=${state.room.code}`;
  try {
    await navigator.clipboard.writeText(link);
    state.copyStatus = 'Link copied! Send it to your friend.';
  } catch (error) {
    console.warn('Clipboard blocked, showing the link instead:', error);
    window.prompt('Copy this link and send it to your friend:', link);
    state.copyStatus = '';
  }
  render();
  setTimeout(() => {
    state.copyStatus = '';
    if (state.screen === SCREEN.LOBBY) render();
  }, COPY_STATUS_MS);
}

function handleRoomUpdate(room) {
  if (!state.latestBroadcast || room.code !== state.latestBroadcast.code || room.version >= state.latestBroadcast.version) {
    state.latestBroadcast = room;
  }
  if (!state.room || room.code !== state.room.code) return;
  if (room.version < state.room.version) return;
  if (state.starting) return; // the friend may already be switching pages; ignore their brief disconnect
  if (room.stage === 'playing') {
    state.room = room;
    startGame();
    return;
  }
  const friendBefore = friendIn(state.room);
  const friendNow = friendIn(room);

  if (friendBefore?.connected && !friendNow?.connected) {
    state.notice = `Friend left — ${friendBefore.name} can rejoin with the same link.`;
  } else if (friendNow?.connected) {
    state.notice = '';
  }
  state.room = room;
  state.connectionLost = false;
  render();
}

const actions = {
  computer: () => {
    const name = cleanName(document.getElementById('name-input')?.value);
    if (name) saveName(name);
    location.href = '/computer.html';
  },
  friend: () => {
    if (takeName()) showScreen(SCREEN.FRIEND);
  },
  'join-pending': () => joinRoom(state.pendingCode),
  'join-group-pending': joinPendingGroup,
  'cancel-group-pending': () => {
    state.pendingGroup = null;
    history.replaceState(null, '', '/');
    showScreen(SCREEN.HOME);
  },
  'cancel-pending': () => {
    state.pendingCode = null;
    setUrlRoom(null);
    showScreen(SCREEN.HOME);
  },
  create: createRoom,
  join: () => joinRoom(document.getElementById('code-input')?.value),
  back: () => showScreen(SCREEN.HOME),
  ready: toggleReady,
  leave: leaveRoom,
  'copy-link': copyLink,
};

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  actions[button.dataset.action]?.();
});

document.addEventListener('submit', (event) => {
  event.preventDefault();
  const action = event.target.dataset.submit;
  actions[action]?.();
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'name-input') {
    state.name = event.target.value;
    saveName(cleanName(event.target.value));
  }
  if (event.target.id === 'code-input') {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z]/g, '');
  }
});

document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat) return;
  if (event.target.closest('input, textarea, button')) return;
  if (state.screen !== SCREEN.LOBBY) return;
  event.preventDefault();
  toggleReady();
});

// ---- Rendering --------------------------------------------------------------

function showScreen(screen, { error = '' } = {}) {
  state.screen = screen;
  state.error = error;
  render();
  // Animate in only when the screen changes, not on every room update.
  els.screen.classList.remove('is-entering');
  void els.screen.offsetWidth;
  els.screen.classList.add('is-entering');
  clearTimeout(enteringTimer);
  enteringTimer = setTimeout(() => els.screen.classList.remove('is-entering'), ENTER_ANIMATION_MS);
  document.querySelector('#screen [autofocus]')?.focus();
  groupsPanel.setVisible(screen === SCREEN.HOME && !state.pendingCode && !state.pendingGroup);
}

function render() {
  const view = { [SCREEN.HOME]: homeView, [SCREEN.FRIEND]: friendView, [SCREEN.LOBBY]: lobbyView }[state.screen];
  els.screen.innerHTML = view();
}

function errorBlock() {
  return state.error ? `<p class="form-error" role="alert">${escapeHtml(state.error)}</p>` : '';
}

function nameField() {
  return `
    <div>
      <label class="field-label" for="name-input">YOUR NAME</label>
      <input class="text-input" id="name-input" maxlength="${MAX_NAME_LENGTH}" autocomplete="nickname"
        placeholder="e.g. Rahul" value="${escapeHtml(state.name)}" ${state.name ? '' : 'autofocus'}>
    </div>`;
}

function homeView() {
  if (state.pendingGroup) {
    return `
      <form class="stack" data-submit="join-group-pending">
        <h2>JOIN GROUP ${state.pendingGroup}</h2>
        <p class="lobby-hint">Your wins against other members will show on its leaderboard.</p>
        ${nameField()}
        ${errorBlock()}
        <button class="btn btn-wide" type="submit" ${state.busy ? 'disabled' : ''}>
          ${state.busy ? 'Joining…' : 'Join group'}
        </button>
        <button class="link-btn" type="button" data-action="cancel-group-pending">Not now — go to home</button>
      </form>`;
  }
  if (state.pendingCode) {
    return `
      <form class="stack" data-submit="join-pending">
        <h2>JOIN ROOM ${state.pendingCode}</h2>
        ${nameField()}
        ${errorBlock()}
        <button class="btn btn-wide" type="submit" ${state.busy ? 'disabled' : ''}>
          ${state.busy ? 'Joining…' : `Join room ${state.pendingCode}`}
        </button>
        <button class="link-btn" type="button" data-action="cancel-pending">Not now — go to home</button>
      </form>`;
  }
  return `
    <div class="stack">
      ${nameField()}
      ${errorBlock()}
      <div class="choices">
        <button class="choice choice-cpu" data-action="computer">
          <span class="choice-icon" aria-hidden="true">🤖</span>
          <span class="choice-title">Play the Computer</span>
          <span class="choice-sub">Practise your hand signs</span>
        </button>
        <button class="choice choice-friend" data-action="friend">
          <span class="choice-icon" aria-hidden="true">🤝</span>
          <span class="choice-title">Play a Friend</span>
          <span class="choice-sub">Create a room, share the code</span>
        </button>
      </div>
      <section class="how-to" aria-labelledby="how-to-title">
        <span class="how-to-title" id="how-to-title">HOW TO PLAY</span>
        <ul class="how-to-steps">
          <li>☝️–🖐️ 1 to 5 fingers = 1 to 5 runs</li>
          <li>👍 thumb only = 6</li>
          <li>Same number as your opponent = OUT</li>
          <li>One wicket each · highest score wins</li>
        </ul>
      </section>
    </div>`;
}

function friendView() {
  return `
    <div class="stack">
      <h2>PLAY A FRIEND</h2>
      ${errorBlock()}
      <button class="btn btn-wide" data-action="create" ${state.busy ? 'disabled' : ''}>
        ${state.busy ? 'Working…' : 'Create room'}
      </button>
      <div class="divider">OR JOIN WITH CODE</div>
      <form class="row" data-submit="join">
        <input class="text-input code-input" id="code-input" maxlength="4" autocomplete="off"
          autocapitalize="characters" spellcheck="false" placeholder="ABCD" aria-label="Room code">
        <button class="btn btn-pink" type="submit" ${state.busy ? 'disabled' : ''}>Join</button>
      </form>
      <button class="link-btn" data-action="back">← Back</button>
    </div>`;
}

function lobbyView() {
  const { room } = state;
  const me = myPlayer();
  const friend = friendIn(room);
  const friendHere = Boolean(friend?.connected);
  const bothReady = state.starting || Boolean(me?.ready && friendHere && friend.ready);
  const letters = [...room.code].map((letter) => `<span>${letter}</span>`).join('');

  const notice = state.connectionLost
    ? 'Connection lost — reconnecting…'
    : state.notice;

  const friendSlot = friendHere
    ? `
      <div class="slot slot-friend">
        <span class="slot-tag">FRIEND</span>
        <span class="slot-name">${escapeHtml(friend.name)}</span>
        <span class="ready-pill ${friend.ready ? 'is-ready' : ''}">${friend.ready ? 'READY ✓' : 'NOT READY'}</span>
      </div>`
    : `
      <div class="slot slot-friend is-waiting">
        <span class="slot-tag">FRIEND</span>
        <span class="slot-name">Waiting for friend…</span>
      </div>`;

  return `
    <div class="stack">
      <div class="lobby-label">ROOM CODE</div>
      <div class="room-code" aria-label="Room code ${room.code}">${letters}</div>
      <div class="copy-row">
        <button class="btn btn-small btn-plain" data-action="copy-link">Copy link</button>
        <span class="copy-status" role="status">${escapeHtml(state.copyStatus)}</span>
      </div>
      ${notice ? `<div class="notice" role="status">${escapeHtml(notice)}</div>` : ''}
      ${errorBlock()}
      <div class="slots">
        <div class="slot slot-me">
          <span class="slot-tag">YOU</span>
          <span class="slot-name">${escapeHtml(me?.name ?? state.name)}</span>
          <span class="ready-pill ${me?.ready ? 'is-ready' : ''}">${me?.ready ? 'READY ✓' : 'NOT READY'}</span>
          <button class="btn btn-small ${me?.ready ? 'btn-ready-on' : ''}" data-action="ready"
            ${state.connectionLost ? 'disabled' : ''}>
            ${me?.ready ? 'Not ready' : 'Ready'} <kbd>Space</kbd>
          </button>
        </div>
        ${friendSlot}
      </div>
      ${
        bothReady
          ? '<div class="lobby-status">Both ready! Starting…</div>'
          : `<p class="lobby-hint">${friendHere ? 'Both press Ready to start.' : 'Send the code or link to your friend.'}</p>`
      }
      <button class="link-btn" data-action="leave">Leave room</button>
    </div>`;
}

// ---- Helpers ----------------------------------------------------------------

function myPlayer() {
  return state.room?.players.find((p) => p.playerId === state.playerId) ?? null;
}

function friendIn(room) {
  return room?.players.find((p) => p.playerId !== state.playerId) ?? null;
}

function setUrlRoom(code) {
  const url = code ? `/?room=${code}` : '/';
  history.replaceState(null, '', url);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

// ---- Boot -------------------------------------------------------------------

function boot() {
  // Remember ?dev=1 for this tab before the URL is rewritten; the game page reads it.
  if (isDevMode()) document.querySelector('.home-foot').textContent = 'DEV MODE · keys 1–6 play your number in friend games';

  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam !== null) {
    const code = roomParam.trim().toUpperCase();
    if (CODE_PATTERN.test(code)) {
      state.pendingCode = code;
    } else {
      setUrlRoom(null);
      state.error = `"${roomParam}" isn’t a valid room code. Ask your friend for the link again.`;
    }
  }

  const groupParam = new URLSearchParams(location.search).get('group');
  if (groupParam !== null) {
    const code = groupParam.trim().toUpperCase();
    if (GROUP_CODE_PATTERN.test(code)) {
      state.pendingGroup = code;
    } else {
      history.replaceState(null, '', '/');
      state.error = `"${groupParam}" isn’t a valid group code. Ask your friend for the invite link again.`;
    }
  }

  showScreen(SCREEN.HOME, { error: state.error });

  const savedName = cleanName(state.name);
  if (savedName) {
    savePlayerName(savedName); // upsert the player on the server when the home screen opens
    state.savedOnServer = savedName;
  }
  // Name already saved → go straight into the room or group from the link.
  if (state.pendingGroup && savedName) joinPendingGroup();
  else if (state.pendingCode && savedName) joinRoom(state.pendingCode);
}

boot();
