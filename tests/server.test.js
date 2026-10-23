import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

async function startServer(t, port) {
  const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(port), JARVIS_ACCESS_TOKEN: '', GEMINI_API_KEY: '' }, stdio: 'ignore' });
  t.after(() => child.kill('SIGTERM'));
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch('http://127.0.0.1:'+port+'/health'); if (r.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not start');
}
test('health endpoint responds with ok true', async t => { const port=4317+Math.floor(Math.random()*300);await startServer(t,port);const r=await fetch('http://127.0.0.1:'+port+'/health');assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true}) });
test('chat without Gemini key returns helpful 503', async t => { const port=4717+Math.floor(Math.random()*300);await startServer(t,port);const r=await fetch('http://127.0.0.1:'+port+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'Hello'}]})});assert.equal(r.status,503);assert.match((await r.json()).error,/GEMINI_API_KEY/) });
test('invalid chat payload is rejected before provider access', async t => { const port=5017+Math.floor(Math.random()*300);await startServer(t,port);const r=await fetch('http://127.0.0.1:'+port+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[]})});assert.equal(r.status,400) });
