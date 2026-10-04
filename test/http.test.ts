import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HttpClient } from '../src/net/http.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let base: string;
afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function serve(handler: Handler): Promise<void> {
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address() as { port: number };
  base = `http://127.0.0.1:${a.port}`;
}
const body = (o: unknown) => JSON.stringify(o);

describe('HttpClient', () => {
  it('returns parsed JSON and lower-cased response headers', async () => {
    await serve((_q, res) => {
      res.setHeader('x-ratelimit-remaining', '17');
      res.end(body({ ok: 1 }));
    });
    const r = await new HttpClient().getJson<{ ok: number }>(`${base}/x`);
    expect(r.data).toEqual({ ok: 1 });
    expect(r.headers['x-ratelimit-remaining']).toBe('17');
    expect(r.status).toBe(200);
  });

  it('throws kind=timeout when the upstream exceeds timeoutMs', async () => {
    await serve(() => {
      /* never responds */
    });
    await expect(new HttpClient({ timeoutMs: 150 }).getJson(`${base}/slow`)).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('throws kind=parse on a non-JSON body', async () => {
    await serve((_q, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('<html>nope');
    });
    await expect(new HttpClient().getJson(`${base}/x`)).rejects.toMatchObject({ kind: 'parse' });
  });

  it('throws kind=server_error on 5xx', async () => {
    await serve((_q, res) => {
      res.statusCode = 503;
      res.end('{}');
    });
    await expect(new HttpClient().getJson(`${base}/x`)).rejects.toMatchObject({
      kind: 'server_error',
      status: 503,
    });
  });

  it('throws kind=invalid_request on 4xx and carries the status', async () => {
    await serve((_q, res) => {
      res.statusCode = 400;
      res.end(body({ errors: [{ message: 'bad', status: 400 }] }));
    });
    await expect(new HttpClient().getJson(`${base}/x`)).rejects.toMatchObject({
      kind: 'invalid_request',
      status: 400,
    });
  });

  it('sends the configured User-Agent', async () => {
    let seen = '';
    await serve((q, res) => {
      const ua = q.headers['user-agent'];
      seen = Array.isArray(ua) ? ua.join(',') : (ua ?? '');
      res.end(body({}));
    });
    await new HttpClient({ userAgent: 'anicata-test/1.0' }).getJson(`${base}/x`);
    expect(seen).toBe('anicata-test/1.0');
  });

  it('aborts and throws kind=network when the connection is refused', async () => {
    await serve(() => {});
    const dead = base;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(new HttpClient({ timeoutMs: 500 }).getJson(`${dead}/x`)).rejects.toMatchObject({
      kind: 'network',
    });
  });
});
