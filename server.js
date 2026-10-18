import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from 'socket.io';
import { RoomStore, RoomError, normalizeCode, STAGE, VIEW } from './rooms.js';
import { FriendGame } from './friend-game.js';
import { createStore } from './stores.js';
import { GroupsService } from './groups.js';
import { createApiRouter } from './api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SWEEP_INTERVAL_MS = 30 * 1000;
const SIGNAL_EVENTS = ['offer', 'answer', 'ice-candidate'];
// Match inputs a player may send. The game itself checks who sent it and whether it fits the phase.
const GAME_INPUTS = {
  'toss-call': (game, playerId, payload) => game.tossCall(playerId, payload.call),
  'toss-choose': (game, playerId, payload) => game.tossChoose(playerId, payload.choice),
  'start-ball': (game, playerId) => game.startBall(playerId),
  'my-number': (game, playerId, payload) => game.submitNumber(playerId, payload.ballNo, payload.number),
  'game-ready': (game, playerId, payload) => game.setReady(playerId, payload.ready !== false),
};
const STUN_SERVERS = { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] };

/** STUN always; TURN too when TURN_URL / TURN_USERNAME / TURN_CREDENTIAL are set. */
export function iceConfigFromEnv(env = process.env) {
  const iceServers = [STUN_SERVERS];
  const turnUrls = (env.TURN_URL ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  if (turnUrls.length > 0) {
    iceServers.push({ urls: turnUrls, username: env.TURN_USERNAME ?? '', credential: env.TURN_CREDENTIAL ?? '' });
  }
  return { iceServers };
}

export function createGameServer({
  store = new RoomStore(),
  env = process.env,
  gameTiming = {},
  groups = new GroupsService({ store: createStore(env) }),
} = {}) {
  const app = express();
  const iceConfig = iceConfigFromEnv(env);
  if (iceConfig.iceServers.length === 1) {
    console.warn('TURN_URL not set: using STUN only. Calls between some networks may fail.');
  }

  app.get('/ice', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(iceConfig);
  });
  app.use('/api', createApiRouter({ groups }));
  app.use('/shared', express.static(path.join(__dirname, 'shared')));
  app.use(express.static(path.join(__dirname, 'public')));

  const httpServer = http.createServer(app);
  const io = new Server(httpServer);

  const games = new Map(); // room code → FriendGame

  const broadcastRoom = (room) => io.to(room.code).emit('room-update', store.publicView(room));

  /** Show "+1 win in CSE Gang" at match end: which groups do these two share? Best effort. */
  const refreshSharedGroups = async (game) => {
    try {
      game.setSharedGroups(await groups.sharedGroups(...game.players));
    } catch (error) {
      console.error('Could not load shared groups:', error.message);
    }
  };

  /** Keep the room's match in step with the room: create it, end it, and track who is on the game screen. */
  const syncGame = (room) => {
    let game = games.get(room.code);
    if (room.stage !== STAGE.PLAYING) {
      if (game) {
        game.dispose();
        games.delete(room.code);
      }
      return null;
    }
    const names = Object.fromEntries(room.players.map((p) => [p.playerId, p.name]));
    if (!game) {
      game = new FriendGame({
        playerIds: room.players.map((p) => p.playerId),
        names,
        timing: gameTiming,
        onChange: (snapshot) => io.to(room.code).emit('game-state', snapshot),
        // The server saves the result; clients never send one. Retries happen inside recordMatch.
        onMatchOver: async (result) => {
          await groups.recordMatch({
            id: result.matchId,
            roomCode: room.code,
            players: result.players.map((id) => ({ id, name: result.names[id] })),
            scores: result.scores,
            winnerId: result.winnerId,
          });
          refreshSharedGroups(game);
        },
      });
      games.set(room.code, game);
      game.startToss();
      refreshSharedGroups(game);
    }
    const onGameScreen = room.players.filter((p) => p.connected && p.view === VIEW.GAME).map((p) => p.playerId);
    game.setPresence(new Set(onGameScreen), names);
    return game;
  };

  /** Every room change: tell both players, then update the match. */
  const roomChanged = (room) => {
    broadcastRoom(room);
    return syncGame(room);
  };

  // Runs a handler and always answers the client's ack with { ok, ... } or { ok: false, error }.
  const handle = (ack, handler) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      reply({ ok: true, ...handler() });
    } catch (error) {
      if (error instanceof RoomError) {
        reply({ ok: false, error: error.message });
      } else {
        console.error('Room handler failed:', error);
        reply({ ok: false, error: 'Something went wrong on the server. Try again.' });
      }
    }
  };

  io.on('connection', (socket) => {
    const leaveCurrentRoom = () => {
      const room = store.leaveRoom(socket.id);
      if (!room) return;
      socket.leave(room.code);
      roomChanged(room);
    };

    socket.on('create-room', (payload, ack) =>
      handle(ack, () => {
        leaveCurrentRoom();
        const room = store.createRoom({
          socketId: socket.id,
          playerId: payload?.playerId,
          name: payload?.name,
          view: payload?.view,
        });
        socket.join(room.code);
        roomChanged(room);
        return { room: store.publicView(room) };
      })
    );

    socket.on('join-room', (payload, ack) =>
      handle(ack, () => {
        if (store.roomOf(socket.id)?.code !== normalizeCode(payload?.code)) leaveCurrentRoom();
        const { room, replacedSocketId } = store.joinRoom({
          code: payload?.code,
          socketId: socket.id,
          playerId: payload?.playerId,
          name: payload?.name,
          view: payload?.view,
        });
        if (replacedSocketId) {
          const oldSocket = io.sockets.sockets.get(replacedSocketId);
          oldSocket?.leave(room.code);
          oldSocket?.emit('room-closed', { reason: 'You opened this room in another tab.' });
        }
        socket.join(room.code);
        const game = roomChanged(room);
        // A (re)joining game screen needs the full match state even if nothing else changed.
        if (game) socket.emit('game-state', game.snapshot());
        return { room: store.publicView(room) };
      })
    );

    socket.on('set-ready', (payload, ack) =>
      handle(ack, () => {
        const room = store.setReady(socket.id, payload?.ready);
        roomChanged(room);
        return {};
      })
    );

    socket.on('leave-room', (_payload, ack) =>
      handle(ack, () => {
        leaveCurrentRoom();
        return {};
      })
    );

    // WebRTC signaling: pass offer / answer / ICE candidates to the other player only.
    for (const event of SIGNAL_EVENTS) {
      socket.on(event, (payload) => {
        if (!payload || typeof payload !== 'object') return;
        const peerSocketId = store.peerSocketId(socket.id);
        if (peerSocketId) io.to(peerSocketId).emit(event, payload);
      });
    }

    for (const [event, apply] of Object.entries(GAME_INPUTS)) {
      socket.on(event, (payload) => {
        const room = store.roomOf(socket.id);
        const game = room && games.get(room.code);
        const player = room?.players.find((p) => p.socketId === socket.id);
        if (!game || !player) return;
        apply(game, player.playerId, payload && typeof payload === 'object' ? payload : {});
      });
    }

    socket.on('disconnect', () => {
      const room = store.disconnect(socket.id);
      if (room) roomChanged(room);
    });
  });

  const sweepTimer = setInterval(() => {
    const { deleted, changed } = store.sweep();
    changed.forEach(roomChanged);
    for (const code of deleted) {
      games.get(code)?.dispose();
      games.delete(code);
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
  httpServer.on('close', () => {
    clearInterval(sweepTimer);
    for (const game of games.values()) game.dispose();
  });

  return { app, httpServer, io, store, games, groups };
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const PORT = Number(process.env.PORT) || 3000;
  const { httpServer } = createGameServer();
  httpServer.listen(PORT, () => {
    console.log(`Hand Cricket running at http://localhost:${PORT}`);
  });
}
