// Game sounds, generated with Web Audio (no files to download).
// Kept short and quiet so they don't end up in the friend's ear through your mic.
// S toggles them; the choice is remembered in localStorage.

import { getAudioContext, resumeAudio } from './audio-levels.js';

const SOUND_OFF_KEY = 'handCricket.soundsOff';
const MASTER_VOLUME = 0.5; // everything below is scaled by this

let soundOn = readSoundSetting();
let noiseBuffer = null;
let master = null;

function readSoundSetting() {
  try {
    return localStorage.getItem(SOUND_OFF_KEY) !== '1';
  } catch {
    return true;
  }
}

export function isSoundOn() {
  return soundOn;
}

export function setSoundOn(on) {
  soundOn = on;
  try {
    if (on) localStorage.removeItem(SOUND_OFF_KEY);
    else localStorage.setItem(SOUND_OFF_KEY, '1');
  } catch (error) {
    console.warn('Could not save sound setting:', error);
  }
}

/** Wire up a 🔊 button and the S key. */
export function bindSoundToggle(button) {
  const render = () => {
    button.textContent = soundOn ? '🔊' : '🔈';
    button.classList.toggle('is-off', !soundOn);
    button.setAttribute('aria-pressed', String(!soundOn));
    button.title = soundOn ? 'Sounds on (S)' : 'Sounds off (S)';
    button.setAttribute('aria-label', button.title);
  };
  const toggle = () => {
    setSoundOn(!soundOn);
    resumeAudio();
    render();
  };
  button.addEventListener('click', toggle);
  document.addEventListener('keydown', (event) => {
    if (event.code !== 'KeyS' || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target.closest('input, textarea')) return;
    toggle();
  });
  render();
}

// ---- Building blocks --------------------------------------------------------

function output() {
  const context = getAudioContext();
  if (!master) {
    master = context.createGain();
    master.gain.value = MASTER_VOLUME;
    master.connect(context.destination);
  }
  return { context, destination: master };
}

function getNoise(context) {
  if (!noiseBuffer) {
    noiseBuffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

/** A tone with a quick attack and exponential fade. */
function tone({ frequency, endFrequency = frequency, type = 'sine', start = 0, duration = 0.12, volume = 0.1 }) {
  const { context, destination } = output();
  const t = context.currentTime + start;
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, t);
  if (endFrequency !== frequency) osc.frequency.exponentialRampToValueAtTime(endFrequency, t + duration);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain).connect(destination);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

/** Filtered noise burst: clicks, cracks, crowd. */
function noise({ start = 0, duration = 0.1, volume = 0.1, filter = 'bandpass', frequency = 1500, q = 1, attack = 0.005 }) {
  const { context, destination } = output();
  const t = context.currentTime + start;
  const source = context.createBufferSource();
  source.buffer = getNoise(context);
  const band = context.createBiquadFilter();
  band.type = filter;
  band.frequency.value = frequency;
  band.Q.value = q;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  source.connect(band).connect(gain).connect(destination);
  source.start(t, Math.random() * 0.5);
  source.stop(t + duration + 0.02);
}

function play(build) {
  if (!soundOn) return;
  try {
    resumeAudio();
    build();
  } catch (error) {
    console.warn('Sound failed:', error);
  }
}

// ---- The sounds -------------------------------------------------------------

export const sounds = {
  /** 3 · 2 · 1 — the last tick is higher. */
  tick: (isLast = false) => play(() => tone({ frequency: isLast ? 1320 : 880, duration: 0.07, volume: 0.07 })),

  /** Bat on ball: a woody crack and a low thump. */
  hit: () =>
    play(() => {
      noise({ duration: 0.07, volume: 0.22, frequency: 2200, q: 2 });
      tone({ frequency: 160, endFrequency: 90, duration: 0.09, volume: 0.12 });
    }),

  /** SIX: a bigger crack, then a short crowd cheer. */
  six: () =>
    play(() => {
      noise({ duration: 0.09, volume: 0.3, frequency: 2400, q: 2 });
      tone({ frequency: 180, endFrequency: 80, duration: 0.12, volume: 0.16 });
      noise({ start: 0.08, duration: 1.1, volume: 0.06, frequency: 1400, q: 0.6, attack: 0.35 });
    }),

  /** OUT: stumps clatter, then a falling groan. */
  out: () =>
    play(() => {
      [0, 0.05, 0.11].forEach((start) => noise({ start, duration: 0.05, volume: 0.15, frequency: 3200, q: 4 }));
      tone({ start: 0.12, frequency: 260, endFrequency: 120, type: 'sawtooth', duration: 0.55, volume: 0.035 });
    }),

  /** FIFTY: a quick cheer. */
  fifty: () => play(() => noise({ duration: 1.0, volume: 0.06, frequency: 1500, q: 0.6, attack: 0.25 })),

  /** Win: a little rising fanfare. */
  win: () =>
    play(() =>
      [523.25, 659.25, 783.99, 1046.5].forEach((frequency, i) =>
        tone({ frequency, type: 'triangle', start: i * 0.11, duration: i === 3 ? 0.4 : 0.14, volume: 0.09 })
      )
    ),

  /** Loss: two slow falling notes. */
  lose: () =>
    play(() => {
      tone({ frequency: 392, endFrequency: 370, type: 'triangle', duration: 0.3, volume: 0.08 });
      tone({ frequency: 311, endFrequency: 262, type: 'triangle', start: 0.3, duration: 0.5, volume: 0.08 });
    }),

  /** Tie: two level notes. */
  tie: () =>
    play(() => {
      tone({ frequency: 523.25, type: 'triangle', duration: 0.18, volume: 0.08 });
      tone({ frequency: 523.25, type: 'triangle', start: 0.22, duration: 0.25, volume: 0.08 });
    }),
};

/** The sound for a played ball (runs or out). */
export function playBallSound(ball) {
  if (ball.type === 'out') sounds.out();
  else if (ball.runs === 6) sounds.six();
  else sounds.hit();
}

/** The end-of-match sound for this player. */
export function playResultSound(outcome) {
  ({ won: sounds.win, lost: sounds.lose, tied: sounds.tie })[outcome]?.();
}
