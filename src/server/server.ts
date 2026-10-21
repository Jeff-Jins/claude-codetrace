// Local HTTP server: a small JSON API over the transcript store, live updates
// over server-sent events, and the static web UI.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TranscriptStore } from './transcripts.ts';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), 'web');

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/main.js': { file: 'main.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const WATCH_INTERVAL_MS = 1000;
const HEARTBEAT_MS = 15000;

export function createApp(store: TranscriptStore): Server {
  return createServer((req, res) => {
    handle(store, req, res).catch((err: unknown) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Internal server error');
      else res.end();
    });
  });
}

export async function startServer(
  store: TranscriptStore,
  port: number,
): Promise<{ server: Server; url: string }> {
  // Try a few ports so a second instance (or a busy default port) still starts.
  for (let candidate = port; candidate < port + 10; candidate++) {
    const server = createApp(store);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(candidate, '127.0.0.1', () => resolve());
      });
      return { server, url: `http://127.0.0.1:${candidate}` };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`No free port found between ${port} and ${port + 9}`);
}

async function handle(store: TranscriptStore, req: IncomingMessage, res: ServerResponse) {
  // Transcripts contain source code; refuse requests that arrive through any
  // hostname other than loopback (guards against DNS rebinding).
  const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!LOCAL_HOSTNAMES.has(hostname)) return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
  if (req.method !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');

  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (pathname === '/api/sessions') return sendJson(res, await store.list());

  const match = /^\/api\/sessions\/([\w-]+)(\/events)?$/.exec(pathname);
  if (match) {
    const [, id, events] = match;
    if (events) return streamEvents(store, id, req, res);
    const session = await store.get(id);
    return session ? sendJson(res, session) : send(res, 404, 'text/plain; charset=utf-8', 'Session not found');
  }

  const asset = STATIC_FILES[pathname];
  if (asset) return send(res, 200, asset.type, await readFile(join(WEB_DIR, asset.file)));

  send(res, 404, 'text/plain; charset=utf-8', 'Not found');
}

/** Sends a `change` event whenever the session's transcript files change. */
async function streamEvents(store: TranscriptStore, id: string, req: IncomingMessage, res: ServerResponse) {
  let last = await store.fingerprint(id);
  if (last === null) return send(res, 404, 'text/plain; charset=utf-8', 'Session not found');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');

  const watcher = setInterval(async () => {
    try {
      const current = await store.fingerprint(id);
      if (current !== null && current !== last) {
        last = current;
        res.write('event: change\ndata: {}\n\n');
      }
    } catch {
      // A transcript may be mid-write or briefly locked; check again next tick.
    }
  }, WATCH_INTERVAL_MS);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(watcher);
    clearInterval(heartbeat);
  });
}

function sendJson(res: ServerResponse, body: unknown) {
  send(res, 200, 'application/json; charset=utf-8', JSON.stringify(body));
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}
