import { spawnSync } from 'node:child_process';
// Local development remains a plain npm install; Render installs speech at build time.
if (process.env.RENDER === 'true' || process.env.SETUP_PIPER === '1') {
  const result = spawnSync(process.env.PIPER_PYTHON || 'python3', ['scripts/setup-piper.py'], { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
