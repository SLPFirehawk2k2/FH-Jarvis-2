import test from 'node:test';
import assert from 'node:assert/strict';
import { piperConfigured, synthesizePiper } from '../server/piper.js';

test('installed Piper synthesizes PCM WAV and rejects overlapping jobs', { skip: !piperConfigured, timeout: 25000 }, async () => {
  const synthesis = synthesizePiper('JARVIS Mark Two online.');
  await assert.rejects(synthesizePiper('Second request'), /busy/);
  const audio = await synthesis;
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(audio.toString('ascii', 8, 12), 'WAVE');
  assert.ok(audio.length > 1000);
  assert.equal(audio.readUInt16LE(20), 1);
  assert.equal(audio.readUInt16LE(22), 1);
  assert.equal(audio.readUInt32LE(24), 22050);
  // A completed job must release the single-job slot.
  const next = await synthesizePiper('Ready.');
  assert.ok(next.length > 1000);
});
