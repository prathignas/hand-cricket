// HTTP API for groups and leaderboards. The browser says who it is with the X-Player-Id header
// (the random id in its localStorage — no login in v1, see DECISIONS.md).

import express from 'express';
import { GroupsError } from './groups.js';

const OFFLINE_MESSAGE = 'Groups are offline right now. Your games still work — try again in a minute.';

export function createApiRouter({ groups, log = console }) {
  const router = express.Router();
  router.use(express.json({ limit: '10kb' }));
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const playerIdOf = (req) => req.get('x-player-id');

  // Wraps a handler: { ok: true, ...result } or { ok: false, error } with a sensible status.
  const route = (handler) => async (req, res) => {
    try {
      res.json({ ok: true, ...(await handler(req)) });
    } catch (error) {
      if (error instanceof GroupsError) {
        res.status(error.status).json({ ok: false, error: error.message });
      } else {
        log.error(`API ${req.method} ${req.originalUrl} failed:`, error.message);
        res.status(503).json({ ok: false, error: OFFLINE_MESSAGE });
      }
    }
  };

  router.post(
    '/me',
    route(async (req) => ({ player: await groups.savePlayer(playerIdOf(req), req.body?.name) }))
  );

  router.post(
    '/groups',
    route(async (req) => ({ group: await groups.createGroup(playerIdOf(req), req.body?.playerName, req.body?.name) }))
  );

  router.post(
    '/groups/join',
    route(async (req) => ({ group: await groups.joinGroup(playerIdOf(req), req.body?.playerName, req.body?.code) }))
  );

  router.get(
    '/me/groups',
    route(async (req) => ({ groups: await groups.myGroups(playerIdOf(req)) }))
  );

  router.get(
    '/groups/:code/leaderboard',
    route(async (req) => groups.leaderboard(playerIdOf(req), req.params.code, req.query.range))
  );

  router.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));
  // Bad JSON in a request body.
  router.use((error, _req, res, _next) => {
    res.status(error.status ?? 400).json({ ok: false, error: 'Bad request.' });
  });
  return router;
}
