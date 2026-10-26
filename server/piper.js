import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const piperConfigured = existsSync(path.join(root, '.piper/en_GB-northern_english_male-medium.onnx'));
let active = false;
export async function synthesizePiper(text) {
  if (active) throw new Error('Cloud voice is busy');
  active = true;
  try {
    return await new Promise((resolve, reject) => {
      const child = execFile(process.env.PIPER_PYTHON || 'python3', [path.join(root, 'server/piper-speech.py')], {
        encoding: 'buffer', timeout: 22000, maxBuffer: 8_000_000,
        env: { ...process.env, PYTHONPATH: path.join(root, '.piper/packages'), OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' }
      }, (error, stdout) => {
        if (error) return reject(new Error(error.killed ? 'Cloud speech timed out' : 'Cloud speech synthesis failed'));
        if (stdout.length < 44 || stdout.toString('ascii', 0, 4) !== 'RIFF' || stdout.toString('ascii', 8, 12) !== 'WAVE') return reject(new Error('Cloud speech returned invalid audio'));
        resolve(stdout);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ text }));
    });
  } finally { active = false; }
}
