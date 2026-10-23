import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { GoogleGenerativeAI } from '@google/generative-ai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NODE_ENV === 'production' && !process.env.JARVIS_ACCESS_TOKEN?.trim()) {
  console.error('Startup blocked: set a strong JARVIS_ACCESS_TOKEN before exposing J.A.R.V.I.S. publicly.');
  process.exit(1);
}

const app = express();
// Render forwards requests through one trusted proxy hop. Do not use `true` here:
// trusting every forwarded address could let clients spoof their IP and evade rate limits.
app.set('trust proxy', 1);
const port = Number(process.env.PORT || 3000);
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
const defaultGeminiModel = 'gemini-3.8-flash';

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) return res.status(403).json({ error: 'Origin not allowed.' });
  next();
});

const chatLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a minute and try again.' } });

function requireAccess(req, res, next) {
  const expected = process.env.JARVIS_ACCESS_TOKEN;
  if (!expected?.trim()) {
    if (process.env.NODE_ENV === 'production') return res.status(503).json({ error: 'Server access protection is not configured.' });
    return next();
  }
  if ((req.get('authorization') || '') !== `Bearer ${expected}`) return res.status(401).json({ error: 'Access token required. Set it in HUD Settings.' });
  next();
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/status', requireAccess, (_req, res) => res.json({
  ok: true, aiConfigured: Boolean(process.env.GEMINI_API_KEY),
  model: process.env.GEMINI_MODEL || defaultGeminiModel, voice: 'browser-dependent'
}));

app.post('/api/chat', requireAccess, chatLimiter, async (req, res) => {
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 20) return res.status(400).json({ error: 'messages must contain 1–20 items.' });
  const normalized = [];
  for (const item of messages) {
    if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 6000) {
      return res.status(400).json({ error: 'Each message needs a valid role and 1–6000 characters of content.' });
    }
    normalized.push({ role: item.role, content: item.content.trim() });
  }
  if (normalized.at(-1).role !== 'user') return res.status(400).json({ error: 'The final message must be from the user.' });
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'Gemini is not configured. Add GEMINI_API_KEY to the server environment.' });

  const requestStartedAt = Date.now();
  try {
    const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = client.getGenerativeModel({
      model: process.env.GEMINI_MODEL || defaultGeminiModel,
      systemInstruction: 'You are J.A.R.V.I.S. Mark II, a helpful, calm, concise assistant. Be transparent about limitations. Do not claim to control devices or services unless a real integration exists.',
      generationConfig: { maxOutputTokens: 256 }
    });
    const history = normalized.slice(0, -1).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const chat = model.startChat({ history });
    let result;
    let lastError;
    // Gemini can temporarily return 429/5xx even when both keys are valid.
    // Retry only transient provider errors once; never retry authentication or input errors.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await chat.sendMessage(normalized.at(-1).content);
        break;
      } catch (error) {
        lastError = error;
        const message = String(error?.message || '');
        const match = message.match(/\[(\d{3})\s*\]/);
        const status = Number(error?.status || error?.response?.status || match?.[1] || 0);
        const transient = [429, 500, 502, 503, 504].includes(status) ||
          /high demand|temporarily unavailable|overloaded|rate limit/i.test(message);
        if (!transient || attempt === 1) throw error;
        console.warn('Gemini temporary provider error (' + (status || 'unknown') + '); retrying once after 1200ms.');
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
    }
    if (!result) throw lastError || new Error('Gemini returned no result.');
    const reply = result.response.text();
    console.info('Gemini request completed in ' + (Date.now() - requestStartedAt) + 'ms');
    return res.json({ reply, elapsedMs: Date.now() - requestStartedAt });
  } catch (error) {
    const message = String(error?.message || 'unknown error');
    const match = message.match(/\[(\d{3})\s*\]/);
    const providerStatus = Number(error?.status || error?.response?.status || match?.[1] || 0);
    console.error('Gemini request failed after ' + (Date.now() - requestStartedAt) + 'ms (provider ' + (providerStatus || 'unknown') + '):', message);
    if (providerStatus === 401 || providerStatus === 403 || /api key not valid|invalid api key/i.test(message)) {
      return res.status(502).json({ code: 'GEMINI_AUTH', error: 'Gemini rejected the server API key. Check GEMINI_API_KEY in Render Environment. Re-entering the J.A.R.V.I.S. access token will not fix this.' });
    }
    if ([429, 500, 502, 503, 504].includes(providerStatus) || /high demand|temporarily unavailable|overloaded|rate limit/i.test(message)) {
      return res.status(503).json({ code: 'GEMINI_TEMPORARY', error: 'Gemini is temporarily busy or rate-limited. Your J.A.R.V.I.S. access token is still accepted; wait a few seconds and retry. No need to re-enter your token.' });
    }
    return res.status(502).json({ code: 'GEMINI_ERROR', error: 'Gemini request failed. Check the server-side Gemini model/API-key configuration and provider status.' });
  }
});

app.use(express.static(publicDir, { extensions: ['html'] }));
app.get('*path', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.listen(port, () => {
  console.log(`J.A.R.V.I.S. Mark II listening on port ${port}`);
  console.info('Gemini API key startup check: ' + (process.env.GEMINI_API_KEY?.trim() ? 'loaded from server environment' : 'MISSING — set GEMINI_API_KEY in Render Environment'));
  console.info('Gemini model: ' + (process.env.GEMINI_MODEL || defaultGeminiModel));
});
