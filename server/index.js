import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { EdgeTTS } from 'node-edge-tts';
import { piperConfigured, synthesizePiper } from './piper.js';
import { providerStatus, routeChat } from './ai-router.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
// Render forwards requests through one trusted proxy hop. Do not use `true` here:
// trusting every forwarded address could let clients spoof their IP and evade rate limits.
app.set('trust proxy', 1);
const port = Number(process.env.PORT || 3000);
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
const connectSrcOrigins = (process.env.CONNECT_SRC_ORIGINS || '').split(',').map(value => {
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : null;
  } catch { return null; }
}).filter(Boolean);
const defaultGeminiModel = 'gemini-3.8-flash';

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://api.open-meteo.com', 'https://geocoding-api.open-meteo.com', ...connectSrcOrigins],
      mediaSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: 'Origin not allowed.' });
  }
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.vary('Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') {
    if (!origin || !allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: 'Origin not allowed for cross-origin requests.' });
    }
    return res.status(204).end();
  }
  next();
});

const chatLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a minute and try again.' } });

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/status', (_req, res) => res.json({ ok: true, ...providerStatus(), voice: piperConfigured ? 'cloud-piper-british-with-browser-fallback' : 'experimental-edge-neural-with-browser-fallback' }));

// Prefer cloud-hosted Piper. Keep the experimental Edge relay for installations without Piper.
const voiceLimiter = rateLimit({ windowMs: 60_000, limit: 6, standardHeaders: 'draft-7', legacyHeaders: false });
const allowedNeuralVoices = new Set(['en-GB-RyanNeural', 'en-GB-ThomasNeural', 'en_GB-northern_english_male-medium']);
app.post('/api/voice', voiceLimiter, async (req, res) => {
  const { text, voice = piperConfigured ? 'en_GB-northern_english_male-medium' : 'en-GB-RyanNeural' } = req.body || {};
  if (typeof text !== 'string' || !text.trim() || text.length > 1200 || !allowedNeuralVoices.has(voice)) {
    return res.status(400).json({ error: 'Provide 1–1200 characters and a supported British voice.' });
  }
  try {
    if (piperConfigured) {
      const audio = await synthesizePiper(text.trim());
      return res.set({ 'Cache-Control': 'no-store', 'X-Voice-Engine': 'piper-british' }).type('audio/wav').send(audio);
    }
    if (voice === 'en_GB-northern_english_male-medium') throw new Error('Piper voice is not installed');
    const tts = new EdgeTTS({ voice, lang: 'en-GB', outputFormat: 'audio-24khz-48kbitrate-mono-mp3', rate: '-8%', timeout: 12000 });
    const chunks = [];
    let size = 0;
    for await (const chunk of tts.streamAudio(text.trim())) {
      if (!Buffer.isBuffer(chunk)) continue;
      size += chunk.length;
      if (size > 2_000_000) throw new Error('Voice response exceeds limit');
      chunks.push(chunk);
    }
    if (!size) throw new Error('Voice service returned no audio');
    res.set('Cache-Control', 'no-store');
    res.type('audio/mpeg').send(Buffer.concat(chunks));
  } catch (error) {
    console.warn('Cloud neural voice unavailable:', error?.message?.slice(0, 120));
    res.status(503).json({ error: 'Cloud neural voice unavailable; use browser voice fallback.' });
  }
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 20) return res.status(400).json({ error: 'messages must contain 1–20 items.' });
  const normalized = [];
  for (const item of messages) {
    if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 6000) {
      return res.status(400).json({ error: 'Each message needs a valid role and 1–6000 characters of content.' });
    }
    if (normalized.length && normalized.at(-1).role === item.role) {
      return res.status(400).json({ error: 'Chat messages must alternate between user and assistant.' });
    }
    normalized.push({ role: item.role, content: item.content.trim() });
  }
  if (normalized.at(-1).role !== 'user') return res.status(400).json({ error: 'The final message must be from the user.' });
  const started = Date.now();
  try {
    const result = await routeChat(normalized);
    return res.json({ ...result, elapsedMs: Date.now() - started });
  } catch (error) {
    console.error('Cloud AI routing failed:', error.status || error.name || 'unknown');
    const status = Number(error.status || 0);
    if (status === 503 && /No cloud AI configured/.test(error.message)) return res.status(503).json({ code: 'AI_NOT_CONFIGURED', error: error.message });
    if (status === 429 || status === 408 || status >= 500 || error.name === 'AbortError') return res.status(503).json({ code: 'AI_TEMPORARY', error: 'Free cloud AI providers are temporarily unavailable or rate-limited. Try again later.' });
    return res.status(502).json({ code: 'AI_PROVIDER_ERROR', error: 'Cloud AI request failed. Check the configured provider keys and model.' });
  }
});

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body exceeds the 32 KB limit.' });
  }
  if (error instanceof SyntaxError && error.status === 400 && Object.hasOwn(error, 'body')) {
    return res.status(400).json({ error: 'Request body must be valid JSON.' });
  }
  return next(error);
});

app.use(express.static(publicDir, { extensions: ['html'] }));
app.get('*path', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.listen(port, () => {
  console.log(`J.A.R.V.I.S. Mark II listening on port ${port}`);
  console.info('Cloud speech:', piperConfigured ? 'Piper British neural' : 'experimental Edge relay');
  console.info('Cloud AI routing:', providerStatus().provider, 'backup configured:', providerStatus().backupConfigured);
  console.info('J.A.R.V.I.S. access-token prompt disabled; AI requests are protected by per-IP rate limiting.');
});
