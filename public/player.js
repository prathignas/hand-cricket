// Who this browser is: a random player id and the name they typed. No login.

import { DEV_MODE_ALLOWED } from './config.js';

const PLAYER_ID_KEY = 'handCricket.playerId';
const NAME_KEY = 'handCricket.name';
export const MAX_NAME_LENGTH = 20;

let memoryPlayerId = null; // used if localStorage is blocked

/** A random UUID v4 (it's also the player's id in the database). */
function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // randomUUID needs a secure context; build the same format by hand for plain http on a LAN address.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getPlayerId() {
  try {
    let id = localStorage.getItem(PLAYER_ID_KEY);
    if (!id) {
      id = randomId();
      localStorage.setItem(PLAYER_ID_KEY, id);
    }
    return id;
  } catch (error) {
    console.warn('localStorage unavailable, using a temporary player id:', error);
    memoryPlayerId ??= randomId();
    return memoryPlayerId;
  }
}

export function getSavedName() {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch (error) {
    console.warn('Could not save name:', error);
  }
}

const DEV_MODE_KEY = 'handCricket.dev';

/**
 * Dev mode (?dev=1): keys set your number instead of the camera, for testing on one laptop.
 * Remembered for this tab, so it survives the lobby → game page hop. ?dev=0 turns it off.
 * Only on local and LAN addresses (see config.js); always off on the deployed site.
 */
export function isDevMode() {
  if (!DEV_MODE_ALLOWED) return false;
  const param = new URLSearchParams(location.search).get('dev');
  try {
    if (param === '1') sessionStorage.setItem(DEV_MODE_KEY, '1');
    if (param === '0') sessionStorage.removeItem(DEV_MODE_KEY);
    return sessionStorage.getItem(DEV_MODE_KEY) === '1';
  } catch {
    return param === '1';
  }
}

export function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}
