// Calls to the game server's /api. Sends this browser's player id; never throws.

import { getPlayerId } from './player.js';
import { API_BASE } from './config.js';

const OFFLINE = 'Can’t reach the game server. Check your connection and try again.';

/** @returns {Promise<{ ok: boolean, status: number, error?: string, [key: string]: any }>} */
export async function apiRequest(path, { method = 'GET', body } = {}) {
  try {
    const response = await fetch(`${API_BASE}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-player-id': getPlayerId() },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok && data.ok !== false, status: response.status, ...data, error: data.error ?? (response.ok ? undefined : OFFLINE) };
  } catch (error) {
    console.warn(`API ${method} ${path} failed:`, error);
    return { ok: false, status: 0, error: OFFLINE };
  }
}

/** Tell the server who this player is (name shows on leaderboards). Best effort. */
export function savePlayerName(name) {
  if (name) apiRequest('/me', { method: 'POST', body: { name } });
}
