# Hand Cricket

Hand cricket over a video call, with webcam finger detection.

```sh
npm install
npm start        # http://localhost:3000
npm test
```

Copy `.env.example` to `.env` to set TURN or Supabase. Everything works without it.

## Deploy

On [Render](https://render.com), create a **Web Service** from this GitHub repo:

- **Build command:** `npm ci --omit=dev`
- **Start command:** `npm start`
- **Health check path:** `/health`
- **Environment:** set `NODE_ENV=production` (turns off `?dev=1` keyboard mode), plus the TURN and Supabase values from `.env.example`. `TURN_URL` takes several URLs separated by commas. Don't set `PORT`; Render sets it.

Render serves over HTTPS, which browsers need before they'll share the camera and mic. Rooms live in memory, so a restart or redeploy ends any match in progress. Groups and leaderboards stay as long as Supabase is set.
