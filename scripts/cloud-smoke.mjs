import WebSocket from 'ws';

const base = new URL(process.env.CLOUD_BASE_URL || 'http://127.0.0.1:8787');
const accessCode = process.env.BETA_ACCESS_CODE || '';
const httpBase = base.origin;
const wsBase = new URL('/ws', base);
wsBase.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';

async function get(path) {
  const response = await fetch(httpBase + path, { cache: 'no-store' });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${body.slice(0, 120)}`);
  return body;
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsBase, { origin: httpBase });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('WebSocket open timeout')); }, 12000);
    socket.once('open', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function request(socket, type, payload) {
  const requestId = 'smoke_' + Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${type} timeout`)), 15000);
    function onMessage(raw) {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.requestId !== requestId) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      if (message.type === 'error') {
        const error = new Error(message.error && message.error.message || 'command failed');
        error.code = message.error && message.error.code;
        reject(error);
      } else resolve(message.payload || {});
    }
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ requestId, type, payload: payload || {} }));
  });
}

await get('/healthz');
const ready = JSON.parse(await get('/readyz'));
if (!ready.ready) throw new Error('service is not ready');
const bootstrap = JSON.parse(await get('/api/bootstrap'));
if (bootstrap.websocketPath !== '/ws' || 'aiApiKey' in bootstrap || 'aiBaseUrl' in bootstrap) throw new Error('unsafe bootstrap response');
const socket = await openSocket();
try {
  const room = await request(socket, 'create_room', { hostName: 'cloud-smoke', accessCode });
  if (!/^\d{6}$/.test(room.roomCode || '') || !room.roomId) throw new Error('create_room returned an invalid room');
  console.log(`cloud smoke passed: ${httpBase} room=${room.roomCode}`);
} finally {
  socket.close();
}
