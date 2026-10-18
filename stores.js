// Where groups, players and matches are stored. Two versions with the same methods:
// - SupabaseStore: the real database (server only; uses the service-role key).
// - MemoryStore:   used when Supabase isn't configured (local dev, tests). Resets on restart.
//
// Every method is async and throws on failure; groups.js decides what to do about it.

import { createClient } from '@supabase/supabase-js';

/** A duplicate key (e.g. invite code already taken). Postgres code 23505. */
export class DuplicateError extends Error {}

export function createStore(env = process.env) {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (url && key) return new SupabaseStore({ url, key });
  console.warn('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set: groups are kept in memory and reset on restart.');
  return new MemoryStore();
}

// ---- Supabase -----------------------------------------------------------------

export class SupabaseStore {
  constructor({ url, key, fetch: customFetch }) {
    this.kind = 'supabase';
    this.db = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      ...(customFetch ? { global: { fetch: customFetch } } : {}),
    });
  }

  async upsertPlayer({ id, name }) {
    check(await this.db.from('players').upsert({ id, name }, { onConflict: 'id' }));
  }

  async upsertPlayers(players) {
    check(await this.db.from('players').upsert(players, { onConflict: 'id' }));
  }

  async createGroup({ name, inviteCode, createdBy }) {
    const result = await this.db
      .from('groups')
      .insert({ name, invite_code: inviteCode, created_by: createdBy })
      .select('id, name, invite_code')
      .single();
    if (result.error?.code === '23505') throw new DuplicateError(result.error.message);
    return check(result);
  }

  async groupByCode(inviteCode) {
    return check(
      await this.db.from('groups').select('id, name, invite_code').eq('invite_code', inviteCode).maybeSingle()
    );
  }

  async addMember({ groupId, playerId }) {
    check(
      await this.db
        .from('group_members')
        .upsert({ group_id: groupId, player_id: playerId }, { onConflict: 'group_id,player_id', ignoreDuplicates: true })
    );
  }

  /** [{ id, name, invite_code, joined_at }] newest first */
  async groupsOfPlayer(playerId) {
    const rows = check(
      await this.db
        .from('group_members')
        .select('joined_at, groups ( id, name, invite_code )')
        .eq('player_id', playerId)
        .order('joined_at', { ascending: false })
    );
    return rows.filter((row) => row.groups).map((row) => ({ ...row.groups, joined_at: row.joined_at }));
  }

  /** [{ playerId, name }] */
  async membersOfGroup(groupId) {
    const rows = check(
      await this.db.from('group_members').select('player_id, players ( name )').eq('group_id', groupId)
    );
    return rows.map((row) => ({ playerId: row.player_id, name: row.players?.name ?? 'Player' }));
  }

  /** Insert once: a retry with the same id is ignored. */
  async insertMatch(match) {
    check(await this.db.from('matches').upsert(match, { onConflict: 'id', ignoreDuplicates: true }));
  }

  /** Every match where both players are in `playerIds`. */
  async matchesAmong(playerIds) {
    if (playerIds.length < 2) return [];
    return check(
      await this.db
        .from('matches')
        .select('id, player_a, player_b, score_a, score_b, winner, played_at')
        .in('player_a', playerIds)
        .in('player_b', playerIds)
        .order('played_at', { ascending: true })
    );
  }
}

function check({ data, error }) {
  if (error) throw new Error(`Supabase: ${error.message}`);
  return data;
}

// ---- In memory ------------------------------------------------------------------

export class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.players = new Map(); // id → { id, name }
    this.groups = new Map(); // id → { id, name, invite_code, created_by }
    this.members = []; // { group_id, player_id, joined_at }
    this.matches = new Map(); // id → match
  }

  async upsertPlayer({ id, name }) {
    this.players.set(id, { id, name });
  }

  async upsertPlayers(players) {
    for (const player of players) await this.upsertPlayer(player);
  }

  async createGroup({ name, inviteCode, createdBy }) {
    if ([...this.groups.values()].some((g) => g.invite_code === inviteCode)) throw new DuplicateError(inviteCode);
    const group = { id: crypto.randomUUID(), name, invite_code: inviteCode, created_by: createdBy };
    this.groups.set(group.id, group);
    return { id: group.id, name, invite_code: inviteCode };
  }

  async groupByCode(inviteCode) {
    const group = [...this.groups.values()].find((g) => g.invite_code === inviteCode);
    return group ? { id: group.id, name: group.name, invite_code: group.invite_code } : null;
  }

  async addMember({ groupId, playerId }) {
    if (this.members.some((m) => m.group_id === groupId && m.player_id === playerId)) return;
    this.members.push({ group_id: groupId, player_id: playerId, joined_at: new Date().toISOString() });
  }

  async groupsOfPlayer(playerId) {
    return this.members
      .filter((m) => m.player_id === playerId)
      .reverse()
      .map((m) => ({ ...this.groups.get(m.group_id), joined_at: m.joined_at }));
  }

  async membersOfGroup(groupId) {
    return this.members
      .filter((m) => m.group_id === groupId)
      .map((m) => ({ playerId: m.player_id, name: this.players.get(m.player_id)?.name ?? 'Player' }));
  }

  async insertMatch(match) {
    if (!this.matches.has(match.id)) this.matches.set(match.id, { ...match });
  }

  async matchesAmong(playerIds) {
    const ids = new Set(playerIds);
    return [...this.matches.values()]
      .filter((m) => ids.has(m.player_a) && ids.has(m.player_b))
      .sort((a, b) => new Date(a.played_at) - new Date(b.played_at));
  }
}
