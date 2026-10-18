// In-memory friend rooms. No sockets in here — server.js wires this to Socket.io,
// which keeps the room rules easy to test.

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L, O
export const ROOM_CODE_LENGTH = 4;
export const MAX_PLAYERS = 2;
export const MAX_NAME_LENGTH = 20;
export const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;
export const REJOIN_WINDOW_MS = 5 * 60 * 1000;

export const STAGE = Object.freeze({ LOBBY: 'lobby', PLAYING: 'playing' });
export const VIEW = Object.freeze({ LOBBY: 'lobby', GAME: 'game' }); // which page a player has open

/** An error whose message is safe to show the player. */
export class RoomError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RoomError';
  }
}

export function normalizeCode(code) {
  return String(code ?? '').trim().toUpperCase();
}

export function isValidCode(code) {
  return new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`).test(code);
}

export function cleanName(name) {
  const cleaned = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  if (!cleaned) throw new RoomError('Please enter your name.');
  return cleaned;
}

function cleanPlayerId(playerId) {
  const id = String(playerId ?? '').trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new RoomError('Invalid player id. Reload the page.');
  return id;
}

export class RoomStore {
  constructor({ random = Math.random, now = Date.now } = {}) {
    this.random = random;
    this.now = now;
    this.rooms = new Map(); // code → room
    this.socketRooms = new Map(); // socketId → code
    this.nextSession = 1; // every join gets a new session number, so clients can spot a rejoin
  }

  roomOf(socketId) {
    const code = this.socketRooms.get(socketId);
    return code ? this.rooms.get(code) ?? null : null;
  }

  createRoom({ socketId, playerId, name, view }) {
    const player = this.#newPlayer({ socketId, playerId, name, view });
    const room = {
      code: this.#uniqueCode(),
      version: 1, // goes up on every change so clients can drop stale snapshots
      stage: STAGE.LOBBY,
      players: [player],
      emptySince: null,
      createdAt: this.now(),
    };
    this.rooms.set(room.code, room);
    this.socketRooms.set(socketId, room.code);
    return room;
  }

  /**
   * Join (or rejoin) a room.
   * - Same playerId already in the room → back into their old slot.
   * - Free slot, or a slot whose player has disconnected → take it.
   * - Otherwise "Room is full".
   * @returns {{ room, replacedSocketId: string|null }} replacedSocketId is an older
   *   connection of the same player (e.g. another tab) that should be dropped.
   */
  joinRoom({ code, socketId, playerId, name, view }) {
    const normalized = normalizeCode(code);
    const room = this.rooms.get(normalized);
    if (!room) throw new RoomError(`Room ${normalized || '????'} not found. Check the code.`);

    const incoming = this.#newPlayer({ socketId, playerId, name, view });
    let replacedSocketId = null;
    const existingIndex = room.players.findIndex((p) => p.playerId === incoming.playerId);
    const disconnectedIndex = room.players.findIndex((p) => !p.connected);

    if (existingIndex !== -1) {
      const existing = room.players[existingIndex];
      if (existing.connected && existing.socketId !== socketId) replacedSocketId = existing.socketId;
      room.players[existingIndex] = incoming;
    } else if (room.players.length < MAX_PLAYERS) {
      room.players.push(incoming);
    } else if (disconnectedIndex !== -1) {
      room.players[disconnectedIndex] = incoming;
      room.stage = STAGE.LOBBY; // a different person: start over from the lobby
    } else {
      throw new RoomError('Room is full.');
    }

    if (replacedSocketId) this.socketRooms.delete(replacedSocketId);
    this.socketRooms.set(socketId, room.code);
    room.emptySince = null;
    this.#resetReady(room);
    room.version += 1;
    return { room, replacedSocketId };
  }

  setReady(socketId, ready) {
    const room = this.roomOf(socketId);
    if (!room) throw new RoomError('You are not in a room.');
    const player = room.players.find((p) => p.socketId === socketId);
    player.ready = Boolean(ready);
    // Once both are ready the match starts, and stays started through disconnects and rejoins.
    const bothReady =
      room.players.length === MAX_PLAYERS && room.players.every((p) => p.connected && p.ready);
    if (bothReady) room.stage = STAGE.PLAYING;
    room.version += 1;
    return room;
  }

  /** Socket id of the other connected player in the same room, for relaying call signals. */
  peerSocketId(socketId) {
    const room = this.roomOf(socketId);
    const peer = room?.players.find((p) => p.connected && p.socketId !== socketId);
    return peer?.socketId ?? null;
  }

  /** Player chose to leave: their slot is freed straight away and any match ends. */
  leaveRoom(socketId) {
    const room = this.roomOf(socketId);
    this.socketRooms.delete(socketId);
    if (!room) return null;
    room.players = room.players.filter((p) => p.socketId !== socketId);
    room.stage = STAGE.LOBBY;
    this.#afterMembershipChange(room);
    return room;
  }

  /** Tab closed / network dropped: the slot is held so the same player can rejoin. */
  disconnect(socketId) {
    const room = this.roomOf(socketId);
    this.socketRooms.delete(socketId);
    if (!room) return null;
    const player = room.players.find((p) => p.socketId === socketId);
    if (player) {
      player.connected = false;
      player.socketId = null;
      player.disconnectedAt = this.now();
    }
    this.#afterMembershipChange(room);
    return room;
  }

  /**
   * Drop players who didn't rejoin in time (that ends their match) and delete rooms
   * empty for EMPTY_ROOM_TTL_MS. Returns the deleted codes and the rooms that changed.
   */
  sweep() {
    const now = this.now();
    const deleted = [];
    const changed = [];
    for (const room of this.rooms.values()) {
      if (room.emptySince !== null && now - room.emptySince >= EMPTY_ROOM_TTL_MS) {
        this.rooms.delete(room.code);
        deleted.push(room.code);
        continue;
      }
      const before = room.players.length;
      room.players = room.players.filter(
        (p) => p.connected || now - p.disconnectedAt < REJOIN_WINDOW_MS
      );
      if (room.players.length !== before) {
        room.stage = STAGE.LOBBY;
        this.#afterMembershipChange(room);
        changed.push(room);
      }
    }
    return { deleted, changed };
  }

  /** What clients see — no socket ids. */
  publicView(room) {
    return {
      code: room.code,
      version: room.version,
      stage: room.stage,
      players: room.players.map(({ playerId, name, ready, connected, session, view }) => ({
        playerId,
        name,
        ready,
        connected,
        session,
        view,
      })),
    };
  }

  #newPlayer({ socketId, playerId, name, view }) {
    return {
      socketId,
      playerId: cleanPlayerId(playerId),
      name: cleanName(name),
      ready: false,
      connected: true,
      disconnectedAt: null,
      session: this.nextSession++,
      view: view === VIEW.GAME ? VIEW.GAME : VIEW.LOBBY,
    };
  }

  #afterMembershipChange(room) {
    room.version += 1;
    this.#resetReady(room);
    const anyoneConnected = room.players.some((p) => p.connected);
    if (!anyoneConnected && room.emptySince === null) room.emptySince = this.now();
  }

  // Whenever the line-up changes, both players confirm again.
  #resetReady(room) {
    for (const player of room.players) player.ready = false;
  }

  #uniqueCode() {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET[Math.floor(this.random() * ROOM_CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new RoomError('Could not create a room right now. Try again.');
  }
}
