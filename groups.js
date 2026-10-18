// Groups, leaderboards and match results — the rules on top of the store (stores.js).

import { DuplicateError } from './stores.js';
import { RANGE, computeLeaderboard, standingLine, startOfWeekKolkata } from './leaderboard.js';

export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
export const INVITE_CODE_LENGTH = 6;
export const MAX_GROUP_NAME_LENGTH = 30;
const MAX_PLAYER_NAME_LENGTH = 20;
const CODE_ATTEMPTS = 10;
export const DEFAULT_RETRY_DELAYS_MS = [2000, 5000, 15000, 30000]; // match write retries after the first try

/** An error with an HTTP status and a message safe to show the player. */
export class GroupsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Player ids are UUIDs; accept them with or without dashes and return the dashed lowercase form. */
export function toUuid(id) {
  const hex = String(id ?? '').trim().toLowerCase().replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeInviteCode(code) {
  return String(code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function cleanText(text, maxLength) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export class GroupsService {
  constructor({ store, now = () => new Date(), random = Math.random, retryDelaysMs = DEFAULT_RETRY_DELAYS_MS, log = console }) {
    this.store = store;
    this.now = now;
    this.random = random;
    this.retryDelaysMs = retryDelaysMs;
    this.log = log;
  }

  // ---- Players + groups -----------------------------------------------------

  async savePlayer(rawPlayerId, rawName) {
    const id = this.#playerId(rawPlayerId);
    const name = cleanText(rawName, MAX_PLAYER_NAME_LENGTH);
    if (!name) throw new GroupsError(400, 'Please enter your name.');
    await this.store.upsertPlayer({ id, name });
    return { id, name };
  }

  async createGroup(rawPlayerId, playerName, rawGroupName) {
    const groupName = cleanText(rawGroupName, MAX_GROUP_NAME_LENGTH);
    if (!groupName) throw new GroupsError(400, 'Give your group a name, like "CSE Gang".');
    const player = await this.savePlayer(rawPlayerId, playerName);

    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
      try {
        const group = await this.store.createGroup({ name: groupName, inviteCode: this.#newCode(), createdBy: player.id });
        await this.store.addMember({ groupId: group.id, playerId: player.id });
        return { code: group.invite_code, name: group.name };
      } catch (error) {
        if (!(error instanceof DuplicateError)) throw error;
      }
    }
    throw new GroupsError(500, 'Could not make an invite code. Try again.');
  }

  async joinGroup(rawPlayerId, playerName, rawCode) {
    const group = await this.#groupOrThrow(rawCode);
    const player = await this.savePlayer(rawPlayerId, playerName);
    await this.store.addMember({ groupId: group.id, playerId: player.id });
    return { code: group.invite_code, name: group.name };
  }

  /** My groups, newest first, each with this week's standing for me. */
  async myGroups(rawPlayerId) {
    const playerId = this.#playerId(rawPlayerId);
    const groups = await this.store.groupsOfPlayer(playerId);
    return Promise.all(
      groups.map(async (group) => {
        const { rows, line } = await this.#board(group, playerId, RANGE.WEEK);
        const me = rows.find((r) => r.playerId === playerId);
        return {
          code: group.invite_code,
          name: group.name,
          members: rows.length,
          rank: me?.played ? me.rank : null, // no rank until you've played this week
          wins: me?.wins ?? 0,
          line,
        };
      })
    );
  }

  async leaderboard(rawPlayerId, rawCode, rawRange) {
    const playerId = this.#playerId(rawPlayerId);
    const range = rawRange === RANGE.ALL ? RANGE.ALL : RANGE.WEEK;
    const group = await this.#groupOrThrow(rawCode);
    const board = await this.#board(group, playerId, range);
    if (!board.rows.some((r) => r.playerId === playerId)) {
      throw new GroupsError(403, `You’re not in ${group.name} yet. Open its invite link to join.`);
    }
    return { group: { code: group.invite_code, name: group.name }, range, ...board };
  }

  /** Groups both players are in: [{ code, name }]. */
  async sharedGroups(rawA, rawB) {
    const a = toUuid(rawA);
    const b = toUuid(rawB);
    if (!a || !b) return [];
    const [groupsA, groupsB] = await Promise.all([this.store.groupsOfPlayer(a), this.store.groupsOfPlayer(b)]);
    const idsB = new Set(groupsB.map((g) => g.id));
    return groupsA.filter((g) => idsB.has(g.id)).map((g) => ({ code: g.invite_code, name: g.name }));
  }

  // ---- Match results --------------------------------------------------------

  /**
   * Save a finished friend match. Never throws: on failure it logs and retries a few times.
   * Safe to call twice with the same match id (the store ignores duplicates).
   * @param match { id, roomCode, players: [{ id, name }, { id, name }], scores: { [id]: n }, winnerId|null }
   * @returns Promise<boolean> true once saved, false if every attempt failed
   */
  async recordMatch(match) {
    const [a, b] = match.players.map((p) => ({ id: toUuid(p.id), name: cleanText(p.name, MAX_PLAYER_NAME_LENGTH) || 'Player' }));
    if (!a.id || !b.id) {
      this.log.warn(`Match ${match.id} not saved: player ids are not UUIDs.`);
      return false;
    }
    const [rawA, rawB] = match.players.map((p) => p.id);
    const row = {
      id: match.id,
      room_code: match.roomCode,
      player_a: a.id,
      player_b: b.id,
      score_a: match.scores[rawA],
      score_b: match.scores[rawB],
      winner: match.winnerId === rawA ? a.id : match.winnerId === rawB ? b.id : null,
      played_at: this.now().toISOString(),
    };

    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      try {
        await this.store.upsertPlayers([a, b]); // the match row needs both players to exist
        await this.store.insertMatch(row);
        return true;
      } catch (error) {
        const delay = this.retryDelaysMs[attempt];
        this.log.error(
          `Saving match ${match.id} failed (try ${attempt + 1}): ${error.message}` +
            (delay === undefined ? ' — giving up.' : ` — retrying in ${delay / 1000}s.`)
        );
        if (delay === undefined) return false;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    return false;
  }

  // ---- Internals ------------------------------------------------------------

  async #board(group, playerId, range) {
    const members = await this.store.membersOfGroup(group.id);
    const matches = await this.store.matchesAmong(members.map((m) => m.playerId));
    const since = range === RANGE.WEEK ? startOfWeekKolkata(this.now()) : null;
    const rows = computeLeaderboard({ members, matches, since });
    return { rows, since: since?.toISOString() ?? null, line: standingLine(rows, playerId, range) };
  }

  async #groupOrThrow(rawCode) {
    const code = normalizeInviteCode(rawCode);
    if (code.length !== INVITE_CODE_LENGTH) throw new GroupsError(400, 'Group codes are 6 characters, like K7MX2Q.');
    const group = await this.store.groupByCode(code);
    if (!group) throw new GroupsError(404, `No group with code ${code}. Check the invite link.`);
    return group;
  }

  #playerId(rawPlayerId) {
    const id = toUuid(rawPlayerId);
    if (!id) throw new GroupsError(400, 'Your player id is missing. Reload the page.');
    return id;
  }

  #newCode() {
    let code = '';
    for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
      code += INVITE_CODE_ALPHABET[Math.floor(this.random() * INVITE_CODE_ALPHABET.length)];
    }
    return code;
  }
}
