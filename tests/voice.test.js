import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const speechSource = appSource.slice(appSource.indexOf('let neuralAudio = null;'), appSource.indexOf('const LOCAL_TASKS_KEY'));
function setup(fetchImpl = async () => new Response(new Blob(['audio']), { headers: { 'content-type': 'audio/mpeg' } })) {
  const audio = [], revoked = [], utterances = [];
  const context = vm.createContext({
    fetch: fetchImpl, AbortController, setTimeout, clearTimeout,
    window: { speechSynthesis: {} },
    speechSynthesis: { cancel() {}, speak(u) { utterances.push(u); } },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    URL: { createObjectURL() { return 'blob:test'; }, revokeObjectURL(url) { revoked.push(url); } },
    Audio: class {
      constructor(src) { this.src = src; audio.push(this); }
      async play() {}
      pause() { this.paused = true; }
    }
  });
  vm.runInContext('let voiceReplies = true, speaking = false, handsFree = false, restartRequested = false; let availableVoices = [], selectedVoiceURI = null;\n' + speechSource, context);
  return { run: code => vm.runInContext(code, context), audio, revoked, utterances };
}

test('neural audio completes and releases its object URL', async () => {
  const s = setup();
  await s.run('speak("Online")');
  assert.equal(s.audio.length, 1);
  assert.equal(s.run('speaking'), true);
  s.audio[0].onended();
  assert.equal(s.run('speaking'), false);
  assert.deepEqual(s.revoked, ['blob:test']);
});
test('late audio decoding error falls back once and releases its URL', async () => {
  const s = setup();
  await s.run('speak("Online")');
  const onerror = s.audio[0].onerror;
  onerror(); onerror();
  assert.equal(s.utterances.length, 1);
  assert.equal(s.utterances[0].text, 'Online');
  assert.deepEqual(s.revoked, ['blob:test']);
});
test('stopping speech aborts a pending request without fallback', async () => {
  let signal;
  const s = setup((_url, options) => new Promise((_resolve, reject) => {
    signal = options.signal;
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const pending = s.run('speak("Online")');
  s.run('stopSpeech()');
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(s.audio.length, 0);
  assert.equal(s.utterances.length, 0);
});
test('stopping active neural audio pauses playback and revokes its URL', async () => {
  const s = setup();
  await s.run('speak("Online")');
  s.run('stopSpeech()');
  assert.equal(s.audio[0].paused, true);
  assert.equal(s.audio[0].onerror, null);
  assert.deepEqual(s.revoked, ['blob:test']);
});
test('non-audio server responses use browser fallback', async () => {
  const s = setup(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
  await s.run('speak("Online")');
  assert.equal(s.audio.length, 0);
  assert.equal(s.utterances.length, 1);
});
test('callbacks from cancelled browser speech cannot end newer playback', async () => {
  const s = setup(async () => new Response('', { status: 503 }));
  await s.run('speak("First")');
  await s.run('speak("Second")');
  s.utterances[1].onstart();
  s.utterances[0].onend();
  assert.equal(s.run('speaking'), true);
  s.utterances[1].onend();
  assert.equal(s.run('speaking'), false);
});
