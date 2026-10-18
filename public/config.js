// Where the game server lives, and whether dev mode may be used. The one place to change the backend URL.
//
// The frontend can be served by Vercel (static) or by the game server itself. On a local or LAN
// address (npm start, testing from a phone on your Wi-Fi) everything talks to the same origin;
// anywhere else (Vercel, the duckdns fallback) it talks to the production server below.

const PRODUCTION_API_BASE = 'https://handcricket-prathi.duckdns.org';

/** localhost, 127.x, ::1, *.local and private network addresses (10.x, 172.16–31.x, 192.168.x). */
const LOCAL_HOST = /^(localhost|127(\.\d+){3}|\[::1\]|.+\.local|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2})$/;
const isLocal = LOCAL_HOST.test(location.hostname);

/** Origin of the game server (Socket.io, /api, /ice), with no trailing slash. */
export const API_BASE = isLocal ? location.origin : PRODUCTION_API_BASE;

/** Dev mode (keys instead of the camera) is for local testing only; deployed sites turn it off. */
export const DEV_MODE_ALLOWED = isLocal;
