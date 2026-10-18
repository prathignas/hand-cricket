// Friend game screen: live video + audio call, plus the match (friend-match.js), which the
// server runs. This file owns the camera/mic, the call, the mic meters and dev mode.
//
// Call setup: the player in the room's first slot (the creator) makes the offer, the other answers.
// Socket.io relays offer / answer / ice-candidate to the other player only.
// Every call attempt has a callId so late messages from an old attempt are ignored.

import { io } from '/socket.io/socket.io.esm.min.js';
import { HandTracker, describeCameraError } from './hand.js';
import { getPlayerId, getSavedName, cleanName, isDevMode } from './player.js';
import { createFriendMatch } from './friend-match.js';
import { LevelMeter, resumeAudio } from './audio-levels.js';
import { escapeHtml } from './match-ui.js';
import { bindSoundToggle } from './sounds.js';

const CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/; // must match rooms.js
const REQUEST_TIMEOUT_MS = 6000;
const RECOVERY_GRACE_MS = 5000; // a "disconnected" call often recovers on its own; wait this long first
const RESTART_DELAY_MS = 1000;
// Loading the hand detector blocks the page for a moment (longer on slow machines), which
// would hold up call setup. So it loads once the call connects, or after this delay.
const DETECTOR_FALLBACK_START_MS = 4000;
const FALLBACK_ICE_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const VIDEO_CONSTRAINTS = { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' };
const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true };
const LEVEL_POLL_MS = 80;
const MIC_METER_GAIN = 6; // RMS ~0.15 (normal speech) fills the bar
const TALKING_THRESHOLD = 0.03; // friend's RMS above this counts as talking
const TALKING_HOLD_MS = 500; // keep "talking" lit briefly between words

const CALL = Object.freeze({
  WAITING: 'waiting', // friend hasn't opened the game screen yet
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  LEFT: 'left',
});

const CALL_CHIP_TEXT = {
  [CALL.WAITING]: 'WAITING',
  [CALL.CONNECTING]: 'CONNECTING…',
  [CALL.CONNECTED]: 'CONNECTED',
  [CALL.RECONNECTING]: 'RECONNECTING…',
  [CALL.LEFT]: 'FRIEND LEFT',
};

const $ = (id) => document.getElementById(id);
const els = {
  myVideo: $('my-video'),
  overlay: $('my-overlay'),
  badgeValue: $('finger-badge-value'),
  badgeLabel: $('finger-badge-label'),
  devChip: $('dev-chip'),
  micMeter: $('mic-meter'),
  micMeterFill: $('mic-meter-fill'),
  talkingChip: $('talking-chip'),
  systemNotice: $('system-notice'),
  systemNoticeText: $('system-notice-text'),
  // Match screen (filled by friend-match.js through match-ui.js)
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
  countdown: $('countdown'),
  countdownNum: $('countdown-num'),
  revealMe: $('reveal-me'),
  revealFriend: $('reveal-friend'),
  message: $('message'),
  messageAction: $('message-action'),
  cameraMessage: $('camera-message'),
  cameraMessageText: $('camera-message-text'),
  retryMedia: $('retry-media'),
  micChip: $('mic-chip'),
  friendVideo: $('friend-video'),
  friendNameCard: $('friend-name-card'),
  friendNameScore: $('friend-name-score'),
  roomLabel: $('room-label'),
  connChip: $('conn-chip'),
  sightscreen: $('sightscreen'),
  friendOverlay: $('friend-overlay'),
  friendOverlayText: $('friend-overlay-text'),
  soundButton: $('sound-button'),
  messageMain: $('message-main'),
  messageSub: $('message-sub'),
  muteButton: $('mute-button'),
  retryDetector: $('retry-detector'),
  panel: $('panel'),
};

const state = {
  code: '',
  playerId: getPlayerId(),
  name: cleanName(getSavedName()),
  room: null,
  media: { status: 'loading', error: null, hasMic: false },
  detector: { status: 'waiting' }, // waiting | loading | ready | error
  muted: false,
  call: CALL.WAITING,
  friendKey: null, // "playerId:session" of the friend while they're on this screen
  friendSeen: false,
  serverLost: false,
  leaving: false,
  devMode: isDevMode(),
  devNumber: null, // dev mode: keys 1–6 set this, 0 = no hand
};

const peer = {
  pc: null,
  callId: null,
  pendingCandidates: [],
  remoteStream: null,
  everConnected: false,
  recoveryTimer: 0,
  restartTimer: 0,
};

let socket = null;
let match = null;
let detectorStartTimer = 0;
let lastFriendSoundAt = 0;
const myMicMeter = new LevelMeter();
const friendMicMeter = new LevelMeter();
let localStream = null;
let localMediaReady = Promise.resolve(null);
const iceConfigReady = loadIceConfig();
const tracker = new HandTracker(els.myVideo, els.overlay, { onFrame: updateFingerBadge });

// ---- Media ------------------------------------------------------------------

/** Camera + mic. Falls back to camera only if the mic is blocked. Resolves to the stream or null. */
async function setupMedia() {
  stopLocalMedia();
  state.media = { status: 'loading', error: null, hasMic: false };
  renderMedia();

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    state.media = {
      status: 'error',
      error: 'The camera only works on https:// or http://localhost.',
      hasMic: false,
    };
    renderMedia();
    return null;
  }

  try {
    let hasMic = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS, audio: AUDIO_CONSTRAINTS });
    } catch (error) {
      console.warn('Camera + mic failed, trying camera only:', error);
      stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS, audio: false });
      hasMic = false;
    }

    localStream = stream;
    setMicEnabled(!state.muted);
    myMicMeter.setStream(stream);
    els.myVideo.srcObject = stream;
    await els.myVideo.play();
    state.media = { status: 'ready', error: null, hasMic };
    startTrackingIfReady();
    renderMedia();
    return stream;
  } catch (error) {
    console.error('Could not start the camera:', error);
    state.media = { status: 'error', error: describeCameraError(error), hasMic: false };
    renderMedia();
    return null;
  }
}

function stopLocalMedia() {
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
}

function setMicEnabled(enabled) {
  localStream?.getAudioTracks().forEach((track) => {
    track.enabled = enabled;
  });
}

async function retryMedia() {
  localMediaReady = setupMedia();
  const stream = await localMediaReady;
  if (!stream || !state.friendKey) return;
  // Redo the call with the new tracks. The offerer just restarts; the answerer rejoins,
  // which gives it a new session and makes the offerer call again.
  if (amOfferer()) startCall();
  else joinRoom();
}

function toggleMute() {
  if (!state.media.hasMic) return;
  state.muted = !state.muted;
  setMicEnabled(!state.muted);
  renderMedia();
}

// ---- Hand detector (my own video only) --------------------------------------

function startDetectorSoon() {
  // Dev mode plays from the keyboard, so skip the detector (two on one laptop is heavy).
  if (state.devMode) return;
  detectorStartTimer = setTimeout(startDetectorNow, DETECTOR_FALLBACK_START_MS);
}

function startDetectorNow() {
  clearTimeout(detectorStartTimer);
  if (state.detector.status === 'waiting' && !state.devMode) setupDetector();
}

async function setupDetector() {
  state.detector = { status: 'loading' };
  renderDetector();
  try {
    await tracker.init();
    state.detector = { status: 'ready' };
  } catch (error) {
    console.error('Hand detector failed to load:', error);
    state.detector = { status: 'error' };
  }
  startTrackingIfReady();
  renderDetector();
}

function startTrackingIfReady() {
  if (state.media.status === 'ready' && state.detector.status === 'ready') tracker.start();
}

function updateFingerBadge({ handSeen, number }) {
  els.badgeValue.textContent = !handSeen ? '–' : number === null ? '✊' : String(number);
}

// ---- Socket + room ----------------------------------------------------------

function connectSocket() {
  socket = io();
  match = createFriendMatch({
    socket,
    playerId: state.playerId,
    els,
    getMyNumber,
    onBackHome: leave,
  });
  socket.on('game-state', (snapshot) => match.handleState(snapshot));
  socket.on('connect', joinRoom); // fires again after every reconnect
  socket.on('disconnect', () => {
    if (state.leaving) return;
    state.serverLost = true;
    renderSystemNotice();
  });
  socket.on('room-update', handleRoomUpdate);
  socket.on('room-closed', ({ reason } = {}) => showFatal(reason || 'You were removed from the room.'));
  socket.on('offer', handleOffer);
  socket.on('answer', handleAnswer);
  socket.on('ice-candidate', handleRemoteCandidate);
}

async function request(event, payload) {
  try {
    return await socket.timeout(REQUEST_TIMEOUT_MS).emitWithAck(event, payload);
  } catch (error) {
    console.error(`"${event}" got no answer:`, error);
    return { ok: false, error: 'Could not reach the game server.' };
  }
}

async function joinRoom() {
  const friendKeyBefore = state.friendKey;
  const response = await request('join-room', {
    code: state.code,
    playerId: state.playerId,
    name: state.name,
    view: 'game',
  });
  if (!response.ok) {
    if (socket.connected) showFatal(response.error);
    return;
  }
  state.serverLost = false;
  renderSystemNotice();

  handleRoomUpdate(response.room);
  // We rejoined with a new session, so the friend dropped their side of the call.
  // If we're the offerer and the friend didn't change, nobody else will restart it.
  if (state.friendKey && state.friendKey === friendKeyBefore && amOfferer()) startCall();
}

function handleRoomUpdate(room) {
  if (room.code !== state.code) return;
  // The join reply can be handled after newer broadcasts; never go back to an older snapshot.
  if (state.room && room.version < state.room.version) return;
  if (room.stage !== 'playing') {
    location.replace(`/?room=${state.code}`); // match not started yet: back to the lobby
    return;
  }
  state.room = room;

  const friend = friendIn(room);
  const friendOnScreen = Boolean(friend?.connected && friend.view === 'game');
  const key = friendOnScreen ? `${friend.playerId}:${friend.session}` : null;

  if (key !== state.friendKey) {
    state.friendKey = key;
    resetPeer();
    peer.everConnected = false;
    if (key) {
      state.friendSeen = true;
      setCall(CALL.CONNECTING);
      if (amOfferer()) startCall();
    } else {
      setCall(state.friendSeen ? CALL.LEFT : CALL.WAITING);
    }
  }
  renderNames();
}

function amOfferer() {
  return state.room?.players[0]?.playerId === state.playerId;
}

function friendIn(room) {
  return room?.players.find((p) => p.playerId !== state.playerId) ?? null;
}

// ---- WebRTC -----------------------------------------------------------------

async function loadIceConfig() {
  try {
    const response = await fetch('/ice');
    if (!response.ok) throw new Error(`/ice answered ${response.status}`);
    return await response.json();
  } catch (error) {
    console.warn('Could not load ICE config, using public STUN only:', error);
    return FALLBACK_ICE_CONFIG;
  }
}

function newCallId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createPeer(callId, iceConfig) {
  const pc = new RTCPeerConnection(iceConfig);

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', { callId, candidate: candidate.toJSON() });
  };

  pc.ontrack = ({ track }) => {
    if (peer.pc !== pc) return;
    peer.remoteStream ??= new MediaStream();
    peer.remoteStream.addTrack(track);
    if (track.kind === 'audio') friendMicMeter.setStream(peer.remoteStream);
    if (els.friendVideo.srcObject !== peer.remoteStream) els.friendVideo.srcObject = peer.remoteStream;
    playFriendVideo();
  };

  pc.onconnectionstatechange = () => {
    if (peer.pc === pc) handleConnectionState(pc.connectionState);
  };

  return pc;
}

/** Offerer: (re)start the call from scratch. */
async function startCall() {
  resetPeer();
  const callId = newCallId();
  peer.callId = callId;
  setCall(peer.everConnected ? CALL.RECONNECTING : CALL.CONNECTING);

  const [stream, iceConfig] = await Promise.all([localMediaReady, iceConfigReady]);
  if (peer.callId !== callId) return; // a newer attempt started meanwhile

  const pc = createPeer(callId, iceConfig);
  peer.pc = pc;
  for (const kind of ['audio', 'video']) {
    const track = stream?.getTracks().find((t) => t.kind === kind);
    // Without a local track we still want to receive the friend's.
    if (track) pc.addTrack(track, stream);
    else pc.addTransceiver(kind, { direction: 'recvonly' });
  }

  try {
    await pc.setLocalDescription(await pc.createOffer());
    if (peer.pc !== pc) return;
    socket.emit('offer', { callId, description: pc.localDescription.toJSON() });
  } catch (error) {
    console.error('Could not create the call offer:', error);
    scheduleRestart();
  }
}

/** Answerer: a new offer always replaces the current call. */
async function handleOffer({ callId, description } = {}) {
  if (!callId || !description || amOfferer()) return;
  resetPeer();
  peer.callId = callId; // set before any await so early ICE candidates get queued, not dropped
  setCall(peer.everConnected ? CALL.RECONNECTING : CALL.CONNECTING);

  const [stream, iceConfig] = await Promise.all([localMediaReady, iceConfigReady]);
  if (peer.callId !== callId) return;

  const pc = createPeer(callId, iceConfig);
  peer.pc = pc;
  try {
    await pc.setRemoteDescription(description);
    // Add tracks after the offer so they reuse its audio/video slots.
    stream?.getTracks().forEach((track) => pc.addTrack(track, stream));
    await flushCandidates(pc);
    await pc.setLocalDescription(await pc.createAnswer());
    if (peer.pc !== pc) return;
    socket.emit('answer', { callId, description: pc.localDescription.toJSON() });
  } catch (error) {
    console.error('Could not answer the call:', error);
  }
}

async function handleAnswer({ callId, description } = {}) {
  const pc = peer.pc;
  if (!pc || callId !== peer.callId || pc.signalingState !== 'have-local-offer') return;
  try {
    await pc.setRemoteDescription(description);
    await flushCandidates(pc);
  } catch (error) {
    console.error('Could not use the call answer:', error);
    scheduleRestart();
  }
}

async function handleRemoteCandidate({ callId, candidate } = {}) {
  if (!candidate || callId !== peer.callId) return;
  const pc = peer.pc;
  if (!pc || !pc.remoteDescription) {
    peer.pendingCandidates.push(candidate);
    return;
  }
  try {
    await pc.addIceCandidate(candidate);
  } catch (error) {
    console.warn('Skipped a bad ICE candidate:', error);
  }
}

async function flushCandidates(pc) {
  for (const candidate of peer.pendingCandidates.splice(0)) {
    try {
      await pc.addIceCandidate(candidate);
    } catch (error) {
      console.warn('Skipped a bad queued ICE candidate:', error);
    }
  }
}

function handleConnectionState(connectionState) {
  clearTimeout(peer.recoveryTimer);
  switch (connectionState) {
    case 'connected':
      peer.everConnected = true;
      setCall(CALL.CONNECTED);
      startDetectorNow();
      break;
    case 'disconnected':
      setCall(CALL.RECONNECTING);
      if (amOfferer()) peer.recoveryTimer = setTimeout(startCall, RECOVERY_GRACE_MS);
      break;
    case 'failed':
      setCall(CALL.RECONNECTING);
      scheduleRestart();
      break;
    case 'new':
    case 'connecting':
      setCall(peer.everConnected ? CALL.RECONNECTING : CALL.CONNECTING);
      break;
    default:
      break; // 'closed' happens only when we close it ourselves
  }
}

function scheduleRestart() {
  if (!amOfferer() || !state.friendKey) return; // the answerer waits for a fresh offer
  clearTimeout(peer.restartTimer);
  peer.restartTimer = setTimeout(startCall, RESTART_DELAY_MS);
}

function resetPeer() {
  clearTimeout(peer.recoveryTimer);
  clearTimeout(peer.restartTimer);
  if (peer.pc) {
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
  }
  peer.pc = null;
  peer.callId = null;
  peer.pendingCandidates = [];
  peer.remoteStream = null;
  friendMicMeter.disconnect();
  els.friendVideo.srcObject = null;
  els.soundButton.hidden = true;
}

async function playFriendVideo() {
  try {
    await els.friendVideo.play();
    els.soundButton.hidden = true;
  } catch (error) {
    // Chrome may block sound until the page is clicked once.
    if (error.name === 'NotAllowedError') els.soundButton.hidden = false;
    else if (error.name !== 'AbortError') console.warn('Friend video would not play:', error);
  }
}

// ---- Leaving ----------------------------------------------------------------

function cleanup() {
  match?.dispose();
  myMicMeter.disconnect();
  friendMicMeter.disconnect();
  tracker.stop();
  resetPeer();
  stopLocalMedia();
}

async function leave() {
  state.leaving = true;
  await request('leave-room', {});
  cleanup();
  socket.disconnect();
  location.href = '/';
}

function showFatal(message) {
  state.leaving = true;
  cleanup();
  socket?.disconnect();
  els.panel.innerHTML = `
    <h2>CAN’T OPEN THIS GAME</h2>
    <p class="lead">${escapeHtml(message)}</p>
    <div class="actions"><a class="btn" href="/">Back to home</a></div>`;
}

window.addEventListener('pagehide', cleanup);

// ---- Input ------------------------------------------------------------------

/** The number this player shows at the end of the countdown. */
function getMyNumber() {
  return state.devMode ? state.devNumber : tracker.lockedNumber();
}

const actions = {
  mute: toggleMute,
  leave,
  'retry-media': retryMedia,
  'retry-detector': setupDetector,
  'enable-sound': playFriendVideo,
};

document.addEventListener('click', (event) => {
  resumeAudio();
  const button = event.target.closest('[data-action]');
  if (button && !button.disabled) {
    const action = button.dataset.action;
    if (!match?.handleAction(action)) actions[action]?.();
  }
  // Any click counts as permission to play sound.
  if (!els.soundButton.hidden) playFriendVideo();
});

document.addEventListener('keydown', (event) => {
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest('input, textarea')) return;
  resumeAudio();
  if (event.code === 'KeyM') toggleMute();
  if (event.code === 'Space') {
    event.preventDefault();
    if (!event.target.closest('button')) match?.handleSpace(); // a focused button handles Space itself
  }
  if (state.devMode && /^Digit[0-6]$/.test(event.code)) {
    const digit = Number(event.code.slice(-1));
    state.devNumber = digit === 0 ? null : digit;
    renderDev();
  }
});

// ---- Mic meters -------------------------------------------------------------

function updateLevels() {
  const micLive = state.media.hasMic && !state.muted;
  const myLevel = micLive ? myMicMeter.level() : 0;
  els.micMeter.classList.toggle('is-off', !micLive);
  els.micMeterFill.style.transform = `scaleX(${Math.min(1, myLevel * MIC_METER_GAIN).toFixed(3)})`;

  const now = performance.now();
  if (state.call === CALL.CONNECTED && friendMicMeter.level() > TALKING_THRESHOLD) lastFriendSoundAt = now;
  els.talkingChip.hidden = now - lastFriendSoundAt > TALKING_HOLD_MS;
}

setInterval(updateLevels, LEVEL_POLL_MS);

// ---- Rendering --------------------------------------------------------------

function setCall(call) {
  state.call = call;
  els.connChip.dataset.state = call;
  els.connChip.textContent = CALL_CHIP_TEXT[call];
  renderFriendOverlay();
}

function renderNames() {
  const friendName = friendIn(state.room)?.name ?? 'FRIEND';
  els.friendNameCard.textContent = friendName.toUpperCase();
  els.friendNameScore.textContent = friendName.toUpperCase();
  els.roomLabel.textContent = `🏏 ROOM ${state.code}`;
  renderFriendOverlay();
}

function renderFriendOverlay() {
  const friendName = friendIn(state.room)?.name ?? 'your friend';
  const text = {
    [CALL.WAITING]: `Waiting for ${friendName} to open the game…`,
    [CALL.LEFT]: `Friend left — waiting for ${friendName} to rejoin…`,
  }[state.call];
  els.friendOverlay.hidden = !text;
  els.friendOverlay.classList.toggle('is-left', state.call === CALL.LEFT);
  if (text) els.friendOverlayText.textContent = text;
}

function renderMedia() {
  const { status, error, hasMic } = state.media;
  els.cameraMessage.hidden = status === 'ready';
  els.cameraMessage.classList.toggle('is-error', status === 'error');
  els.cameraMessageText.textContent =
    status === 'error' ? error : 'Starting camera and mic… allow access when asked.';
  els.retryMedia.hidden = status !== 'error';

  const micOff = status === 'ready' && (!hasMic || state.muted);
  els.micChip.hidden = !micOff;
  els.micChip.textContent = hasMic ? '🔇 MUTED' : '🚫 NO MIC';
  els.muteButton.disabled = !hasMic;
  els.muteButton.classList.toggle('is-muted', state.muted && hasMic);
  els.muteButton.setAttribute('aria-pressed', String(state.muted));
  els.muteButton.innerHTML = state.muted ? '🔇 Unmute <kbd>M</kbd>' : '🎤 Mute <kbd>M</kbd>';
  renderSystemNotice();
}

function renderDetector() {
  els.retryDetector.hidden = state.detector.status !== 'error';
  renderSystemNotice();
}

/** One-line status pill for problems outside the match (server, mic, detector). */
function renderSystemNotice() {
  let text = '';
  if (state.serverLost) text = 'Lost the game server — reconnecting…';
  else if (state.media.status === 'ready' && !state.media.hasMic)
    text = 'Mic blocked — your friend can’t hear you. Allow the mic in the address bar, then reload.';
  else if (state.detector.status === 'error') text = 'Hand detector failed to load. Check your internet.';
  else if (state.detector.status === 'loading' && !state.devMode) text = 'Loading hand detector…';
  els.systemNotice.hidden = !text;
  els.systemNoticeText.textContent = text;
}

function renderDev() {
  els.devChip.hidden = !state.devMode;
  if (state.devMode) {
    els.badgeLabel.textContent = 'DEV';
    els.badgeValue.textContent = state.devNumber ?? '✊';
  }
  els.devChip.textContent = `DEV · ${state.devNumber ?? '✊'}`;
  els.devChip.title = 'Dev mode: keys 1–6 set your number, 0 = no hand';
}

// ---- Boot -------------------------------------------------------------------

function boot() {
  const code = (new URLSearchParams(location.search).get('room') ?? '').trim().toUpperCase();
  if (!CODE_PATTERN.test(code)) {
    location.replace('/');
    return;
  }
  if (!state.name) {
    location.replace(`/?room=${code}`); // pick a name in the lobby first
    return;
  }
  state.code = code;
  bindSoundToggle($('sound-toggle'));
  renderNames();
  renderDev();
  setCall(CALL.WAITING);
  localMediaReady = setupMedia();
  connectSocket();
  startDetectorSoon();
}

boot();
