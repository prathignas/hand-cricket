# Hand Cricket — Build Spec

A browser game where 2 friends play hand cricket over a live video call. The webcam reads your fingers. Laptop only (v1).

## Stack
- Frontend: plain HTML/CSS/JS (ES modules), no framework
- Server: Node.js + Express + Socket.io (serves the page too)
- Video/audio: WebRTC (peer to peer), Socket.io used for signaling, plus a free TURN server
- Hand detection: MediaPipe Tasks Vision `HandLandmarker` (from CDN), runs in each player's own browser
- Database (step 6): Supabase (Postgres)
- Deploy: Render (gives HTTPS — camera needs HTTPS or localhost)

## Finger rules
- Count raised fingers: 1–5 (open hand = 5)
- **Thumb only (👍) = 6**
- Fist / no hand = no number → ball is replayed ("NO BALL"), never counted
- At reveal, use the most common reading over the last ~400 ms (so a moving hand doesn't count)
- Keep detection thresholds as named constants at the top of the file so they are easy to tune

## Game rules
- Toss: coin flip, winner picks bat or bowl
- **One wicket per innings**
- Same number from both = batter OUT. Different = batter's number is added to their score
- 2nd innings: chase the target. Game ends early once the chaser passes the target
- Equal scores = TIE

## Ball flow (the important part)
- Audio is ALWAYS on. Both players can always talk.
- Your own camera is always visible.
- Opponent's video is hidden behind a **"SIGHTSCREEN"** cover between balls.
- **Batter presses Space** → "BALL INCOMING" 3·2·1 countdown (~1.5 s total) over your own video
- At 0: each browser reads its own player's number and sends it to the server
- Server decides the result (server is the source of truth, not the clients)
- Sightscreen drops → opponent's video + both numbers shown → OUT or +runs → scoreboard updates
- After ~3 s the sightscreen goes back up automatically, ready for next ball
- Only the batter's Space works for starting a ball

## Big moments (video stays open, no timer)
- **On OUT / innings break:** big "OUT!" + video stays open so players can talk. "Start 2nd innings" button — starts only when **both players press Ready** (Space also works)
- **Match end:** "YOU WON!" / "YOU LOST" / "TIE!", "You beat Rahul 9 to 4", head-to-head record vs that friend ("4 won, 5 lost"), Play Again (both must press Ready), Back

## Modes
1. **Play the Computer** — no video call; bot picks random 1–6. Same UI with a fake opponent card behind the sightscreen. Used to test detection alone.
2. **Play a Friend** — create room → 4-letter code / link → friend opens it → both enter names → both Ready → toss
3. (Later, NOT v1) Play a Stranger — skip; needs moderation

## Edge cases
- Friend disconnects → "Friend left" message, pause the game, allow rejoin to the same room
- Camera blocked → clear message telling the user to allow camera
- Detector fails to load → clear error, retry button

## Groups + leaderboard (step 6)
- No login. Player picks a name; browser stores a random `player_id` in localStorage.
- Anyone can create a group ("CSE Gang") → invite link. A player can be in many groups.
- A friend match between two members of the same group counts on that group's board.
- Board columns: Rank, Name, Played, Wins, Win %, Current streak 🔥
- Ranked by wins, tiebreak win %. 👑 on #1.
- **Weekly board (resets Monday) + All-time tab**
- Home screen line: "You're 2 wins behind Rahul"
- Suggested tables: `players(id, name)`, `groups(id, name, invite_code)`, `group_members(group_id, player_id)`, `matches(id, player_a, player_b, score_a, score_b, winner, played_at)`. Server writes match results (not the browser).

## UI style
- Bright green background, chunky boxes with thick black borders and hard shadows
- Yellow (you) and pink (opponent) accents
- Bold display font (e.g. Archivo Black) + mono font for small labels (e.g. Space Mono)
- Layout top to bottom: header chips → scoreboard (YOU | FRIEND, scores, "out" tag, BATTING/BOWLING, "NEEDS X TO WIN" bar) → two video cards side by side → message bar (BALL INCOMING / OUT! / +4 / SIX!)
- Show a small live finger-count badge on your own video (helps testing)
- Mirror your own video

## Build steps (do ONE at a time, I test after each)
1. Express server + Play the Computer mode with hand detection and full game rules + UI
2. Socket.io rooms: create / join with code, names, Ready
3. WebRTC video + audio call with sightscreen cover, TURN config via env vars
4. Move game rules to the server for friend mode; sync both screens
5. Polish UI + sounds + match end screen + head-to-head record
6. Supabase groups + weekly / all-time leaderboard
7. Deploy to Render, test with a friend on a different network
