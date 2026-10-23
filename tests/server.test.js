import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';

const TEST_TOKEN = 'test-jarvis-token';

async function startServer(t, port, extraEnv = {}) {
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), JARVIS_ACCESS_TOKEN: TEST_TOKEN, GEMINI_API_KEY: '', ...extraEnv },
    stdio: 'ignore'
  });
  t.after(() => child.kill('SIGTERM'));
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/health'); if (r.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not start');
}

test('production startup fails closed when access token is missing', () => {
  const result = spawnSync(process.execPath, ['server/index.js'], {
    env: { ...process.env, NODE_ENV: 'production', JARVIS_ACCESS_TOKEN: '', GEMINI_API_KEY: '' },
    encoding: 'utf8',
    timeout: 5000
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Startup blocked: set a strong JARVIS_ACCESS_TOKEN/);
});

function authHeaders(extra = {}) {
  return { authorization: 'Bearer ' + TEST_TOKEN, ...extra };
}

test('health endpoint responds with ok true', async t => {
  const port = 4317 + Math.floor(Math.random() * 300);
  await startServer(t, port);
  const r = await fetch('http://127.0.0.1:' + port + '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('API status rejects requests without the configured token', async t => {
  const port = 4617 + Math.floor(Math.random() * 300);
  await startServer(t, port);
  const r = await fetch('http://127.0.0.1:' + port + '/api/status');
  assert.equal(r.status, 401);
});

test('API status accepts the configured token', async t => {
  const port = 4717 + Math.floor(Math.random() * 300);
  await startServer(t, port);
  const r = await fetch('http://127.0.0.1:' + port + '/api/status', { headers: authHeaders() });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).aiConfigured, false);
});

test('chat without Gemini key returns helpful 503 after authentication', async t => {
  const port = 4817 + Math.floor(Math.random() * 300);
  await startServer(t, port);
  const r = await fetch('http://127.0.0.1:' + port + '/api/chat', {
    method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] })
  });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /GEMINI_API_KEY/);
});

test('chat rejects missing token before processing the request', async t => {
  const port = 4917 + Math.floor(Math.random() * 300);
  await startServer(t, port);
  const r = await fetch('http://127.0.0.1:' + port + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [] })
  });
  assert.equal(r.status, 401);
});

test('invalid chat payload is rejected before provider access', async t => {
  const port = 5017 + Math.floor(Math.random() * 300);
  await startServer(t, port);
  const r = await fetch('http://127.0.0.1:' + port + '/api/chat', {
    method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ messages: [] })
  });
  assert.equal(r.status, 400);
});
