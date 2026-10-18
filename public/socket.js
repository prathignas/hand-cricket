// Socket.io connection to the game server (API_BASE in config.js).
// The client comes from a CDN, pinned to the server's version: keep it equal to "socket.io" in package.json.

import { io } from 'https://cdn.jsdelivr.net/npm/socket.io-client@4.8.4/dist/socket.io.esm.min.js';
import { API_BASE } from './config.js';

// Reconnect fast after a blip (the server notices a dead socket in about 10 s).
const SOCKET_OPTIONS = { reconnectionDelay: 500, reconnectionDelayMax: 2000 };

export function connectToServer() {
  return io(API_BASE, SOCKET_OPTIONS);
}
