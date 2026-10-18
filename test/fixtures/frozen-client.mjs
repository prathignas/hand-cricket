// Helper for server.test.js: a Socket.io client in its own process, so the test can freeze it
// (SIGSTOP) like a phone whose network stalls. Prints the room code once it has created a room.
import { io } from 'socket.io-client';

const [url, playerId] = process.argv.slice(2);
const socket = io(url, { transports: ['websocket'], reconnection: false });
socket.on('connect', async () => {
  const { room } = await socket.emitWithAck('create-room', { playerId, name: 'Frozen', view: 'lobby' });
  console.log(room.code);
});
