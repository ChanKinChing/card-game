import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, AuthResponseSchema, type AuthResponse } from '@card-game/protocol';
import { serverLogger } from '@card-game/engine/shared/game-logger';
import { createGameApplication } from '@server/application';
import { InMemoryStore } from '@server/rooms/state-store';
import { InMemoryDeckStore } from '@server/decks/deck-store';

// Operational surface: the probes a supervisor polls and the log line that makes
// a 500 diagnosable. Both are invisible to the game protocol, so they are tested
// against the real HTTP stack rather than a unit-level stub.
type App = ReturnType<typeof createGameApplication>;

const apps: App[] = [];

function listen(app: App): Promise<void> {
  return new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
}
function origin(app: App): string {
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP port');
  return `http://127.0.0.1:${address.port}`;
}
async function start(options: Parameters<typeof createGameApplication>[0] = {}) {
  const app = createGameApplication({ environment: { NODE_ENV: 'test', DELTA_LOG_PATH: '' }, ...options });
  apps.push(app);
  await listen(app);
  return { app, url: origin(app) };
}
async function guest(url: string): Promise<AuthResponse> {
  const response = await fetch(url + '/api/auth/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION }) });
  expect(response.status).toBe(201);
  return AuthResponseSchema.parse(await response.json());
}
async function register(url: string, username: string): Promise<AuthResponse> {
  const response = await fetch(url + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, username, password: 'health-probe-passphrase-2026' }) });
  expect(response.status).toBe(201);
  return AuthResponseSchema.parse(await response.json());
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await new Promise<void>(resolve => { if (app.server.listening) app.io.close(() => resolve()); else resolve(); });
  }
  vi.restoreAllMocks();
});

describe('health probes', { timeout: 20_000 }, () => {
  it('answers liveness without waiting for readiness', async () => {
    const { url } = await start();
    const response = await fetch(url + '/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('reports readiness once migrations and admin bootstrap have finished', async () => {
    const { app, url } = await start();
    await app.ready;
    const response = await fetch(url + '/readyz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready' });
  });

  it('reports 503 while startup is still failing', async () => {
    // An incomplete admin bootstrap rejects `ready`, which is exactly the state a
    // load balancer must not send traffic to.
    const { url } = await start({ environment: { NODE_ENV: 'test', DELTA_LOG_PATH: '', ADMIN_BOOTSTRAP_USERNAME: 'admin' } });
    const response = await fetch(url + '/readyz');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'starting' });
  });

  it('serves probes to a caller with no Origin header', async () => {
    // A systemd or load-balancer check sends no Origin. The origin policy would
    // reject it, so the probes must be registered ahead of that middleware.
    const { url } = await start();
    const response = await fetch(url + '/healthz', { headers: { Origin: 'https://not-configured.example' } });
    expect(response.status).toBe(200);
  });

  it('still rejects an unconfigured origin on the API surface', async () => {
    const { url } = await start();
    const response = await fetch(url + '/api/platform', { headers: { Origin: 'https://not-configured.example' } });
    expect(response.status).toBe(403);
  });
});

describe('request correlation', { timeout: 20_000 }, () => {
  it('assigns a request id and echoes it to the caller', async () => {
    const { url } = await start();
    const response = await fetch(url + '/healthz');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reuses an upstream request id instead of breaking the chain', async () => {
    const { url } = await start();
    const response = await fetch(url + '/healthz', { headers: { 'x-request-id': 'edge-abc-123' } });
    expect(response.headers.get('x-request-id')).toBe('edge-abc-123');
  });
});

describe('unhandled request failures', { timeout: 20_000 }, () => {
  it('logs a 500 with the request id the client was given', async () => {
    const decks = new InMemoryDeckStore();
    vi.spyOn(decks, 'listDecks').mockImplementation(() => { throw new Error('deck index is corrupt'); });
    const error = vi.spyOn(serverLogger, 'error').mockImplementation(() => undefined);
    const { url } = await start({ store: new InMemoryStore(undefined, decks, undefined) });
    const session = await register(url, 'probe-owner');

    const response = await fetch(url + '/api/decks', { headers: { Authorization: `Bearer ${session.token}` } });
    expect(response.status).toBe(500);
    // The client learns nothing beyond "it failed"; the detail stays server-side.
    expect(await response.json()).toEqual({ protocolVersion: PROTOCOL_VERSION, message: 'Request could not be completed.' });

    const requestId = response.headers.get('x-request-id');
    expect(requestId).toBeTruthy();
    expect(error).toHaveBeenCalledWith('http:request:failed', 'Unhandled request failure', expect.objectContaining({
      requestId,
      method: 'GET',
      path: '/api/decks',
      error: 'deck index is corrupt',
    }));
  });

  it('logs a thrown non-Error value without losing it', async () => {
    // Express permits `next('something')`; the handler must still produce a
    // readable log line rather than `[object Object]` or a crash.
    const decks = new InMemoryDeckStore();
    vi.spyOn(decks, 'listDecks').mockImplementation(() => { throw 'deck store exploded'; });
    const error = vi.spyOn(serverLogger, 'error').mockImplementation(() => undefined);
    const { url } = await start({ store: new InMemoryStore(undefined, decks, undefined) });
    const session = await register(url, 'probe-owner-string');

    const response = await fetch(url + '/api/decks', { headers: { Authorization: `Bearer ${session.token}` } });
    expect(response.status).toBe(500);
    expect(error).toHaveBeenCalledWith('http:request:failed', 'Unhandled request failure', expect.objectContaining({
      error: 'deck store exploded',
      stack: undefined,
    }));
  });

  it('logs a thrown non-Error value without losing it', async () => {
    // Express permits `next('something')`; the handler must still produce a
    // readable log line rather than `[object Object]` or a crash.
    const decks = new InMemoryDeckStore();
    vi.spyOn(decks, 'listDecks').mockImplementation(() => { throw 'deck store exploded'; });
    const error = vi.spyOn(serverLogger, 'error').mockImplementation(() => undefined);
    const { url } = await start({ store: new InMemoryStore(undefined, decks, undefined) });
    const session = await register(url, 'probe-owner-string');

    const response = await fetch(url + '/api/decks', { headers: { Authorization: `Bearer ${session.token}` } });
    expect(response.status).toBe(500);
    expect(error).toHaveBeenCalledWith('http:request:failed', 'Unhandled request failure', expect.objectContaining({
      error: 'deck store exploded',
      stack: undefined,
    }));
  });

  it('does not log a client error the caller can already explain', async () => {
    const error = vi.spyOn(serverLogger, 'error').mockImplementation(() => undefined);
    const { url } = await start();
    const response = await fetch(url + '/api/decks');
    expect(response.status).toBe(401);
    expect(error).not.toHaveBeenCalledWith('http:request:failed', expect.anything(), expect.anything());
  });

  it('does not log a malformed body as a server failure', async () => {
    const error = vi.spyOn(serverLogger, 'error').mockImplementation(() => undefined);
    const { url } = await start();
    const response = await fetch(url + '/api/auth/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    expect(response.status).toBe(400);
    expect(error).not.toHaveBeenCalledWith('http:request:failed', expect.anything(), expect.anything());
  });
});
