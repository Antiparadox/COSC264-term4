import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

const app = express();
app.disable('x-powered-by');

// Only public/ is ever served. Course source material (PDFs, PPTX) lives
// outside it and is therefore unreachable, not merely unlinked.
app.use(express.static(PUBLIC, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    // Decks are large but change often while they're being written, so let
    // the browser cache them and revalidate via ETag rather than refetch.
    // The decks and the scripts that drive them change together; a stale
    // cached deck-remote.js on the iPad would silently disable features that
    // the deck HTML expects to be there.
    if (/\.(html|js)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

app.use((_req, res) => {
  res.status(404).type('html').send(
    '<!doctype html><meta charset="utf-8">' +
    '<title>Not found · COSC264</title>' +
    '<style>body{font:17px/1.6 system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:0 1.5rem;' +
    'background:#eef1f4;color:#15242f}a{color:#0f8f83}' +
    '@media(prefers-color-scheme:dark){body{background:#0d151b;color:#e6edf2}a{color:#3fb8aa}}</style>' +
    '<h1>Page not found</h1><p><a href="/">Back to the lecture slides</a></p>'
  );
});

const server = app.listen(PORT, () => console.log(`COSC264 site listening on :${PORT}`));

/* ------------------------------------------------------------------ *
 * Slide remote relay
 *
 * Deliberately a dumb pipe: it pairs two sockets by code and forwards
 * bytes between them. It holds no sequence numbers and no slide state,
 * so a server restart (every deploy does one) costs nothing but a
 * reconnect -- both ends resume exactly where they were.
 * ------------------------------------------------------------------ */

// No I/O/0/1: these get misread off a projector.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 4;
const GRACE_MS = 5 * 60 * 1000;   // keep a session alive across an iPad reload
const HEARTBEAT_MS = 30 * 1000;

/** code -> { presenter: ws|null, remotes: Set<ws>, reaper: Timeout|null } */
const sessions = new Map();

const newCode = () => {
  let code;
  do {
    code = Array.from({ length: CODE_LEN },
      () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  } while (sessions.has(code));
  return code;
};

const send = (ws, obj) => {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
};

function cancelReaper(session) {
  if (session.reaper) { clearTimeout(session.reaper); session.reaper = null; }
}

function scheduleReaper(code, session) {
  cancelReaper(session);
  session.reaper = setTimeout(() => {
    if (!session.presenter && session.remotes.size === 0) sessions.delete(code);
  }, GRACE_MS);
}

const wss = new WebSocketServer({ server, path: '/rc' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.role = null;
  ws.code = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // --- registration ------------------------------------------------
    if (msg.role === 'presenter') {
      // Reuse the requested code when possible so an iPad reload rejoins the
      // same session and any paired phone stays paired.
      let code = typeof msg.code === 'string' ? msg.code.toUpperCase() : null;
      let session = code ? sessions.get(code) : null;

      if (session && session.presenter && session.presenter !== ws) {
        code = null; session = null;          // someone else holds it
      }
      if (!code || !session) {
        if (!code) code = newCode();
        session = sessions.get(code) ?? { presenter: null, remotes: new Set(), reaper: null };
        sessions.set(code, session);
      }

      cancelReaper(session);
      session.presenter = ws;
      ws.role = 'presenter';
      ws.code = code;

      send(ws, { type: 'ready', code, remotes: session.remotes.size });
      for (const r of session.remotes) send(r, { type: 'presenter', connected: true });
      return;
    }

    if (msg.role === 'remote') {
      const code = typeof msg.code === 'string' ? msg.code.toUpperCase().trim() : '';
      const session = sessions.get(code);
      if (!session) { send(ws, { type: 'nosession' }); return; }

      cancelReaper(session);
      session.remotes.add(ws);
      ws.role = 'remote';
      ws.code = code;

      send(ws, { type: 'joined', code, presenter: !!session.presenter });
      send(session.presenter, { type: 'remote', connected: true, count: session.remotes.size });
      return;
    }

    // --- phone -> deck ------------------------------------------------
    if (ws.role !== 'remote') return;
    const session = sessions.get(ws.code);
    if (!session) return;

    if (msg.type === 'cmd') {
      // Forwarded verbatim, seq included. The deck decides whether to act.
      send(session.presenter, { type: 'cmd', cmd: msg.cmd, seq: msg.seq });
    } else if (msg.type === 'caption') {
      // Speech is recognised on the phone; only text crosses this server.
      // No audio is ever received, buffered or stored here.
      send(session.presenter, { type: 'caption', text: String(msg.text ?? ''), final: !!msg.final });
    } else if (msg.type === 'captions') {
      send(session.presenter, { type: 'captions', on: !!msg.on });
    } else if (msg.type === 'point') {
      send(session.presenter, { type: 'point', on: !!msg.on });
    } else if (msg.type === 'move') {
      // Deliberately NOT sequence-guarded, unlike 'cmd'. Pointer frames are a
      // lossy stream where the latest one is the only one that matters: a
      // dropped frame is invisible, whereas a frame replayed in order behind
      // a newer one would drag the cursor backwards.
      send(session.presenter, { type: 'move', x: Number(msg.x) || 0, y: Number(msg.y) || 0 });
    } else if (msg.type === 'ping') {
      send(session.presenter, { type: 'ping' });
    }
  });

  ws.on('close', () => {
    const session = ws.code && sessions.get(ws.code);
    if (!session) return;

    if (ws.role === 'presenter' && session.presenter === ws) {
      session.presenter = null;
      for (const r of session.remotes) send(r, { type: 'presenter', connected: false });
      scheduleReaper(ws.code, session);
    } else if (ws.role === 'remote') {
      session.remotes.delete(ws);
      send(session.presenter, { type: 'remote', connected: session.remotes.size > 0, count: session.remotes.size });
      if (!session.presenter && session.remotes.size === 0) scheduleReaper(ws.code, session);
    }
  });
});

// Mobile networks drop sockets without a close frame; ping to notice.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));
