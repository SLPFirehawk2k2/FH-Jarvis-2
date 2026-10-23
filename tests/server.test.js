import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

async function startServer(t, port, extraEnv = {}) {
  const child = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      GEMINI_API_KEY: '',
      ALLOWED_ORIGINS: '',
      JARVIS_ACCESS_TOKEN: '',
      ...extraEnv
    },
    stdio: 'ignore'
  });
  t.after(() => child.kill('SIGTERM'));
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/health');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not start');
}

test('production server starts without a J.A.R.V.I.S. access token', async t => {
  const port = 4317 + Math.floor(Math.random() * 300);
  await startServer(t, port, { NODE_ENV: 'production', JARVIS_ACCESS_TOKEN: '' });
  const response = await fetch('http://127.0.0.1:' + port + '/api/status');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).aiConfigured, false);
});

test('health endpoint responds with ok true', async t => {
  const port = 4617 + Math.floor(Math.random() * 300);
  await startServer(t, port);
  const response = await fetch('http://127.0.0.1:' + port + '/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('API status is available without an access-token header', async t => {
  const port = 4717 + Math.floor(Math.random() * 300);
  await startServer(t, port);
  const response = await fetch('http://127.0.0.1:' + port + '/api/status');
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.ok, true);
  assert.equal(status.aiConfigured, false);
  assert.equal(status.model, 'gemini-3.8-flash');
});

test('chat without a Gemini key returns a helpful 503', async t => {
  const port = 4817 + Math.floor(Math.random() * 300);
  await startServer(t, port);
  const response = await fetch('http://127.0.0.1:' + port + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] })
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /GEMINI_API_KEY/);
});

test('invalid chat payload is rejected before provider access', async t => {
  const port = 4917 + Math.floor(Math.random() * 300);
  await startServer(t, port);
  const response = await fetch('http://127.0.0.1:' + port + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [] })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /messages must contain 1–20 items/);
});
