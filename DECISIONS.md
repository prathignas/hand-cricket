# Decisions

A plain-English log of what was built, why, what else we could have done, and the bugs we hit.
Newest step at the bottom.

---

## Step 1 — Play the Computer

**What:** Express serves a plain-JS page. The webcam feeds MediaPipe's HandLandmarker, which counts raised fingers (thumb only = 6, fist = no number). The game plays balls back to back after one Space press and stops only for big moments (OUT, match end, two NO BALLs in a row, or Pause).

**Hand detection runs in the browser, not on the server.**
- Why: no video ever leaves the player's machine, there's no server cost per frame, and the result is instant.
- Counting uses distances from the wrist instead of "is the fingertip above the knuckle on screen", so a tilted hand still counts right. All thresholds are named constants at the top of `hand.js`.
- Alternative: send frames to a server model. Easier to update the model in one place, but slower, costly, and a privacy problem.

**Smoothing:** the locked number is the most common reading in the last 400 ms, and the hand must be seen in at least half the frames. A hand that's still moving doesn't count.

**Auto-play + one-screen layout:**
- Pressing Space every ball felt slow, so after the first ball the game keeps going on its own.
- Everything fits in 100vh at 1280×720 (thin scoreboard, video cards take the rest, message banner floats over the bottom of the cards), so nobody has to scroll mid-game.
- Alternative: a taller page with a separate message box. Simpler CSS, but on a 13" laptop it scrolled.

**Bug:** the 3·2·1 sometimes took about 2 s instead of 1.5 s, because each 500 ms wait started late while detection was busy. Fixed by timing every step from the countdown's start time instead of chaining waits.

---

## Step 2 — Rooms (Socket.io)

**What:** a home screen, then create or join a room with a 4-letter code (no I, L, O), names, and a lobby with Ready.

**Socket.io** for the live connection.
- Why: reconnects on its own, falls back to long-polling where WebSockets are blocked, and has rooms and acknowledgements built in.
- Alternative: raw WebSockets. Fewer dependencies, but we'd rebuild reconnects, rooms and acks ourselves.

**Rooms live in memory** on the server (a `Map`), with a sweep that deletes empty rooms after 5 minutes.
- Why: zero setup, and fine for one server.
- Trade-off: a server restart forgets every room. If we ever run more than one server instance, rooms would need Redis or the database.

**Same playerId in two tabs:** the player id lives in localStorage, so two tabs in one browser are the same player. Instead of letting one person fill both slots, the newer tab takes over and the older one says "You opened this room in another tab." (That's also why testing needs a normal window plus an incognito window.)

**A closed tab keeps its slot for 5 minutes,** so the same player can rejoin. A new person may take a slot whose player has gone.

---

## Step 3 — Video call (WebRTC)

**What:** a live video and audio call between the two players, with the friend's video behind the sightscreen.

**WebRTC peer to peer, with STUN and optional TURN.**
- Why: the video goes straight between the two browsers, so it's fast and costs us nothing per minute. Socket.io only passes the small setup messages (offer, answer, ICE candidates).
- STUN (Google's public servers) is enough on most networks. Some networks need a TURN relay, so `/ice` adds TURN when `TURN_URL`, `TURN_USERNAME` and `TURN_CREDENTIAL` are set.
- Alternative: a media server (SFU) or a hosted video API. More reliable on strict networks and records easily, but it costs money and is overkill for two people.

**The room creator always makes the offer** and the other player answers, so both sides never call each other at once. Every call attempt has an id, so late messages from an old attempt are ignored.

**Bug 1 — room version numbers:** after a rejoin, the call sometimes got torn down for no reason.
- Cause: the server sends the room broadcast before its reply to the join. When both arrive in the same network packet, the page handled the newer broadcast first and then applied the older snapshot from the reply on top. That older snapshot made it think the friend had left.
- Fix: every room has a version number that goes up on each change, and pages ignore anything older than what they've already seen.

**Bug 2 — detector loaded after the call connects:** loading the hand detector freezes the page for a moment (seconds in headless Chrome or on slow laptops), and call setup messages queued up behind it. The detector now starts once the call connects, or after 4 s if no friend is there yet.

---

## Step 4 — Friend match (server is the referee)

**What:** a full friend match: server toss, synced countdown, reveal, innings break, match end, head-to-head record, a pause when someone drops, dev mode, and the mic meter.

**The server is the source of truth.**
- Clients only send inputs (toss call or choice, start-ball, their number, ready). `friend-game.js` decides everything and sends both players the full game state after every change.
- Why: nobody can fake a result, and both screens can't disagree. A rejoining player just gets the latest state.
- The same `shared/rules.js` (now `public/shared/rules.js`) runs the vs-computer game in the browser and the friend game on the server, so the rules can't drift apart.
- Alternative: let one browser ("host") be the referee. Less server code, but the host could cheat, and if they drop, the game state goes with them.

**Synced countdown:** the server sends a start time; each browser converts it to its own clock and shows 3·2·1, then sends its number. The server waits at most 1 s after the countdown ends; anything missing is a NO BALL. Numbers stay hidden until the reveal.

**A drop mid-ball cancels that ball.** When the player is back, the batter presses Space to carry on, rather than the game restarting while their camera and call are still reconnecting.

**Bugs:**
- Dev mode NO BALLs: two hand detectors loading on one laptop froze the pages past the 1 s grace, so numbers arrived late. Dev mode doesn't use the camera, so it no longer loads the detector.
- The Mute and Leave buttons were hidden whenever a panel (toss, break, match end) was up. On the friend screen the banner now always stays visible.
- The server didn't send an update when only one player had picked; it does now.

---

## Step 5 — Polish

**What:**
- **Sounds:** countdown ticks, bat hit, a bigger hit plus a cheer on SIX, stumps plus a groan on OUT, a FIFTY cheer, a win fanfare, and short sad or tie notes. The S key or the 🔊 button turns them off, remembered in localStorage.
- **Animations:** the sightscreen drops fast and bounces slightly on the way up; scores pop; SIX!/OUT!/FIFTY! punch in; confetti on a win (70 CSS pieces, removed after 3 s).
- **UX:**
  - bigger yellow and pink number badges on reveal
  - a last-6-balls strip in the scoreboard (`4 · 2 · 6 · W`)
  - a 🏏 BATTING / 🎯 BOWLING sticker and a coloured ring on the batting card
  - a "How to play" box on the home screen
- **Papercut details:** faint paper grain on panels, sticker-style role and LIVE chips (small tilt, white outline), cut-out tilt and layered shadow on the big-moment banners, and a small zig-zag edge under the banner.

**Why generated sounds instead of audio files:** Web Audio builds each sound from a few oscillators and filtered noise.
- Nothing to download or license, and each sound is tiny and short.
- They're quiet (master volume 0.5, every sound under 1.2 s) because Chrome's echo cancellation doesn't reliably remove sounds a page plays itself. Short and soft keeps them from reaching the friend through your mic.
- Alternative: real recorded samples. They'd sound better (a real crowd, a real bat), but add files and loading, and longer clips are more likely to leak into the call.

**Why the ball strip comes from the server in friend mode:** the server keeps the last 6 balls of the innings in its snapshot. It's display data only and the rules don't change. Because it comes from the server, the strip survives a refresh or rejoin.

**Sounds and confetti only for moments seen live:** if you refresh or rejoin onto a reveal or the end screen, the page shows it without replaying the sound or confetti. Each match celebrates once.

**Respecting reduced motion:** with "reduce motion" switched on, every animation is cut to almost nothing, except confetti on a win. It becomes a small, short burst instead: 24 pieces, no spin, a short fall that fades within 1.4 s. *(Changed later: it used to be skipped entirely. Phones often have reduce motion on, so many winners saw no celebration at all.)*

**Bugs:**
- Caught while writing it, not seen live: the coloured end panels set their colour with the `background` shorthand, which would also have wiped the grain image. They now set only `background-color`.
- The grain at 7% made the home panel look greyish rather than "very subtle". It's now 4.5%.

---

## Step 6 — Friend groups + leaderboard (Supabase)

**What:**
- **Groups:** anyone can make one (6-character invite code, no I/L/O/0/1) and share `/?group=CODE`. Opening the link asks for a name if needed, then joins.
- **Home:** a "My groups" panel with this week's standing for each group.
- **Group page:** THIS WEEK / ALL TIME tabs and a table of rank, name, played, wins, win % and streak, with 👑 for #1, 🔥 for streaks of 2+, and your row highlighted. Above it: "You're 2 wins behind Rahul" or "You're #1 👑 — defend it".
- **Match end:** a "+1 win in CSE Gang" line for every group both players share.
- **Database:** four tables (`supabase/schema.sql`) with RLS on and no policies.

**The server is the only thing that talks to Supabase.**
- It uses the service-role key from `.env`; the browser only calls our own `/api` and never sees the key. A test checks the key doesn't appear in any page, script or API reply.
- The server also writes match results: the match engine reports the final score once and the server saves it. Clients never send a result.

**Saving a match exactly once:**
- Each match gets an id the moment it starts, and the save is "insert, but ignore if this id already exists".
- So retries, reconnects or a double call can't double-count. If Supabase is down, the save is retried after 2, 5, 15 and 30 seconds, then given up and logged. The game never waits for it.

**Leaderboard maths runs in the server, not in SQL.**
- The server loads the group's members and every match between them, then computes played, wins, win %, rank, streak and the "wins behind" line in plain JavaScript (`leaderboard.js`).
- Why: friend groups are small, the logic is easy to read and test (11 tests, including the Monday-in-Kolkata boundary), and it works the same with the in-memory store used for local testing.
- Alternative: a Postgres view or SQL function. Faster for big groups and less data over the wire, but harder to test and to change. If a group ever has thousands of matches, that's the time to move it into SQL.

**Choices made:**
- **The week** starts Monday 00:00 Asia/Kolkata (UTC+5:30 all year). Nothing is deleted; the weekly tab just filters by date.
- **Streak** is your current run of wins in that group, looking at every match, not just this week; a loss or tie ends it.
- **Membership is checked as of now:** if you and a friend played before one of you joined the group, those games count once you're both members.
- **Ranking:** wins, then win %, then games played; players tied on all three share a rank and are listed by name.
- **No Supabase settings → in-memory store:** without `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` the server keeps groups in memory (it says so at start-up), which is how everything was tested locally. Data resets on restart.

**Bugs:**
- Players tied on wins, win % and played came out in random order, so the table could reshuffle between refreshes. Now tied players are sorted by name (they still share the rank).
- The home list showed 👑 next to every group, even with no games played (you're "#1" of a board with no results). Now the crown and rank show only once you've played; the table already did this.
- Not a bug, but worth knowing: saving a match also updates both players' names from the game room, so a renamed player shows their new name on boards after their next match (or the next time they open the home screen).

### Security note: no login in v1

Who you are is just the random `playerId` in your browser's localStorage, and the server trusts it.

**The risk:**
- **Impersonation:** anyone who copies your playerId (from your browser, or by watching your network traffic on a shared computer) can act as you. They could join groups as you, rename you, or see your groups.
- **Losing your id:** clearing your browser or switching devices gives you a new id, and your history doesn't follow you.

**What it can't do:** nobody can post fake results. Matches are only saved by the server, from games it refereed itself.

**How login would fix it later:**
- Add Supabase Auth (magic-link email or Google). The browser gets a signed token instead of a bare id, and the server checks the token's signature on every request and socket join, so the player id can't be faked.
- An old localStorage id can be linked to the new account once, so history carries over.
- With real accounts, RLS policies could even let the browser read its own groups directly. The server would still be the only writer of match results.

---

## Fixes after SYSTEM_DESIGN.md — sightscreen peek and slow disconnect detection

**1. Sightscreen peek (built).**
- **Problem:** the sightscreen was only a picture on top of the friend's video. Someone who edited the page could hide it and watch the batter's fingers form during the countdown.
- **Change:** the call now sends a *copy* of the camera track. From the moment the server starts a countdown until the reveal, that copy is switched off, so the friend receives black frames. Video comes back:
  - at the reveal
  - immediately if the game pauses or the server connection drops
  - after a 4 s safety timer as a backstop

  Innings break and match end keep video on.
- **Why a copy:** turning off the camera track itself would also blank your own preview and the hand detector, which read the same track, during exactly the moment detection matters.
- **Alternative:** `replaceTrack(null)` to stop sending entirely. It saves bandwidth, but the friend's picture freezes and takes longer to come back at the reveal.
- **Trade-off:** you can't see each other while picking (you can still talk), and a tiny bit of bandwidth goes on black frames.
- **Tested:** the browser test checks that each player's outgoing video is off during the countdown while their own preview stays on, that the friend's received video measures black, that audio keeps flowing, and that video is back at the reveal and when the game pauses.

**2. Faster disconnect detection (built).**
- **Problem:** Socket.io's default heartbeat (25 s ping + 20 s timeout) took up to ~45 s to notice a silent Wi-Fi drop.
- **Change:** ping every 5 s, give up after 5 s without a reply, so a silent drop is noticed in 5–10 s (measured about 5.5 s).
- **Avoiding false "friend left" on slow mobile data:**
  - a pong is a few bytes, so slow-but-working connections answer in time
  - clients reconnect within ~2 s once the network is back (`reconnectionDelayMax: 2000`)
  - for the first 15 s of an absence the friend sees "connection dropped — reconnecting…", and only then "left"
- **Tested:** a real Socket.io client in a separate process is frozen with SIGSTOP. A 3 s freeze doesn't count as leaving; a permanent freeze is noticed in ~5.5 s.
- **Alternative:** keep the defaults and accept ~45 s. Zero extra traffic, but a frozen match for nearly a minute.
- **Trade-off:** one tiny ping per player every 5 s, and a stall over 5 s pauses the match (the batter presses Space once the player is back).

**Bug hit while testing:** a test checked audio by taking two samples back-to-back, saw no change, and failed. It was the test, not the app: samples need time between them. It now measures across the countdown.

## Split deploy: frontend on Vercel, backend on EC2

- **Change:** `public/` is a static site on Vercel. The game server (Socket.io, `/api`, `/ice`) stays on EC2 at `https://handcricket-prathi.duckdns.org`, and it still serves `public/` too, as a fallback.
- **One backend URL:** `public/config.js` holds `API_BASE`. On localhost and LAN addresses it is the page's own origin, so `npm start` works unchanged; everywhere else it is the EC2 server.
- **Dev mode:** `/config.js` used to be generated by the server from `NODE_ENV`. A static site can't do that, so dev mode is now allowed only on local and LAN addresses. Same result as before (on locally, off on every deployed URL), with no extra request before the page starts.
- **Socket.io client:** loaded from jsdelivr, pinned to 4.8.4 (the server's version), in `public/socket.js`. The server no longer serves it (`serveClient: false`).
- **Shared rules:** `shared/rules.js` moved to `public/shared/rules.js`. Vercel only sees `public/`, and the browser imports the rules too. The URL `/shared/rules.js` is unchanged.
- **CORS:** Express and Socket.io accept browser requests only from origins in `ALLOWED_ORIGINS`, plus same-origin pages (the duckdns fallback) and non-browser clients with no `Origin` header (curl, tests). Other sites get a 403, and their Socket.io handshake is refused (`allowRequest`). That covers WebSocket too, which CORS headers alone don't.
- **Trade-offs:**
  - Player ids live in `localStorage`, which is per origin. Someone who used the duckdns URL is a new player on the Vercel URL, and their groups don't carry over.
  - Vercel preview URLs are other origins: they can't reach the server unless they're added to `ALLOWED_ORIGINS`.
- **Tested:** unit tests for the allow-list (preflight, 403, Socket.io refused). All three browser suites also passed with the frontend on a separate static server (another origin) and the backend enforcing `ALLOWED_ORIGINS`. A page on an unlisted origin was blocked by the browser.

## Smaller centre panel

- **Problem:** the panel in the middle of the game screen (intro, toss, OUT!, innings break, match end) covered both players' faces.
- **Change:** about 22% smaller: width 600 → 460 px, less padding, headings 50 → 39 px, buttons 18 → 15 px. The pieces inside shrink with it.
- **Kept the same:** position, colours, style and animation, and everything outside the panel.
- **Tested:** at 1280×720 the win panel went from 600×281 to 460×240. On a phone (390 wide), where the panel sits below the video cards, its height dropped from 342 to 226 px.
