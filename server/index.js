import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { GoogleGenerativeAI } from '@google/generative-ai';
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

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Gemini request timed out after ' + ms + 'ms');
        error.status = 504;
        reject(error);
      }, ms);
    })
  ]).finally(() => clearTimeout(timer));
}


app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/status', (_req, res) => res.json({
  ok: true, aiConfigured: Boolean(process.env.GEMINI_API_KEY),
  model: process.env.GEMINI_MODEL || defaultGeminiModel, voice: 'browser-dependent'
}));

app.post('/api/chat', chatLimiter, async (req, res) => {
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
      generationConfig: { maxOutputTokens: 768 }
    });
    // Gemini chat history must begin with a user turn. The UI sends only the
    // latest eight messages, which can start on an assistant turn when sliced.
    const historyMessages = normalized.slice(0, -1);
    while (historyMessages.length && historyMessages[0].role !== 'user') historyMessages.shift();
    const history = historyMessages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const chat = model.startChat({ history });
    let result;
    let lastError;
    // Keep the entire provider recovery path inside one 18-second budget.
    // A 429 usually needs a fallback, not another call to the same throttled model.
    const deadlineAt = Date.now() + 18000;
    const remainingBudget = () => Math.max(0, deadlineAt - Date.now());
    const sendWithinBudget = async (targetChat, capMs = 8000) => {
      const remaining = remainingBudget();
      if (remaining <= 0) {
        const error = new Error('Gemini request exceeded the 18-second response budget');
        error.status = 504;
        throw error;
      }
      return withTimeout(targetChat.sendMessage(normalized.at(-1).content), Math.min(capMs, remaining));
    };
    const configuredModel = process.env.GEMINI_MODEL || defaultGeminiModel;
    const transientStatus = error => {
      const message = String(error?.message || '');
      const match = message.match(/\[(\d{3})\s*\]/);
      const status = Number(error?.status || error?.response?.status || match?.[1] || 0);
      return {
        status,
        transient: [429, 500, 502, 503, 504].includes(status) ||
          /high demand|temporarily unavailable|overloaded|rate limit/i.test(message),
        timedOut: /timed out|response budget/i.test(message)
      };
    };
    const tryFallback = async () => {
      if (configuredModel !== 'gemini-3.8-flash') throw lastError;
      const remaining = remainingBudget();
      if (remaining <= 0) throw lastError;
      console.warn('Gemini 3.8 Flash unavailable/slow; trying fallback model gemini-3.6-flash (' + remaining + 'ms budget left).');
      const fallbackModel = client.getGenerativeModel({
        model: 'gemini-3.6-flash',
        systemInstruction: 'You are J.A.R.V.I.S. Mark II, a helpful, calm, concise assistant. Be transparent about limitations. Do not claim to control devices or services unless a real integration exists.',
        generationConfig: { maxOutputTokens: 768 }
      });
      const fallbackChat = fallbackModel.startChat({ history });
      result = await sendWithinBudget(fallbackChat, remaining);
      console.info('Gemini fallback model gemini-3.6-flash completed request in ' + (Date.now() - requestStartedAt) + 'ms');
    };

    try {
      result = await sendWithinBudget(chat);
    } catch (error) {
      lastError = error;
      const state = transientStatus(error);
      if (!state.transient) throw error;

      // Rate limits and timeouts go straight to fallback; retrying the same model
      // adds latency without helping the common quota/overload case.
      if (state.status === 429 || state.timedOut) {
        await tryFallback();
      } else {
        console.warn('Gemini temporary provider error (' + (state.status || 'unknown') + '); one quick retry allowed.');
        if (remainingBudget() > 9000) {
          await new Promise(resolve => setTimeout(resolve, 500));
          try {
            result = await sendWithinBudget(chat);
          } catch (retryError) {
            lastError = retryError;
            const retryState = transientStatus(retryError);
            if (!retryState.transient) throw retryError;
            await tryFallback();
          }
        } else {
          await tryFallback();
        }
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
      return res.status(503).json({ code: 'GEMINI_TEMPORARY', error: 'Gemini is temporarily busy or rate-limited. Wait a few seconds and retry; J.A.R.V.I.S. does not require an access token.' });
    }
    return res.status(502).json({ code: 'GEMINI_ERROR', error: 'Gemini request failed. Check the server-side Gemini model/API-key configuration and provider status.' });
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
  console.info('Gemini API key startup check: ' + (process.env.GEMINI_API_KEY?.trim() ? 'loaded from server environment' : 'MISSING — set GEMINI_API_KEY in Render Environment'));
  console.info('Gemini model: ' + (process.env.GEMINI_MODEL || defaultGeminiModel));
  console.info('J.A.R.V.I.S. access-token prompt disabled; AI requests are protected by per-IP rate limiting.');
});
