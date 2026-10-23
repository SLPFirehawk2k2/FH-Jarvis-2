// Free-tier cloud routing: Groq first, Gemini only on transient failures.
// Credentials are read exclusively on the server.
import { GoogleGenerativeAI } from '@google/generative-ai';

export const groqModel = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const systemPrompt = `You are J.A.R.V.I.S. Mark II, the user's personal cloud assistant in the J.A.R.V.I.S. dashboard. When asked who you are, lead with your assistant identity: "I am J.A.R.V.I.S. Mark II, your personal AI assistant." Do not introduce yourself as ChatGPT or simply as an OpenAI assistant. If asked about the underlying technology, explain that the primary model is OpenAI's open-weight GPT-OSS-120B served through Groq, with Google Gemini configured as a fallback; do not claim to know which provider handled the current message because only the server response metadata verifies that. You are helpful, calm, and concise. Be transparent about limitations and never claim device control without an integration.`;

export function providerStatus() {
  const groq = Boolean(process.env.GROQ_API_KEY?.trim());
  const gemini = Boolean(process.env.GEMINI_API_KEY?.trim());
  return { aiConfigured: groq || gemini, model: groq ? groqModel : (process.env.GEMINI_MODEL || 'gemini-3.8-flash'), provider: groq ? 'groq' : gemini ? 'gemini' : 'none', backupConfigured: groq && gemini };
}

function classify(error) {
  const status = Number(error.status || 0);
  return { status, fallback: status === 408 || status === 429 || status >= 500 || error.name === 'AbortError' };
}

async function groqChat(messages, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: groqModel, max_tokens: 768, messages: [{ role: 'system', content: systemPrompt }, ...messages] })
    });
    if (!response.ok) {
      const error = new Error('Groq returned HTTP ' + response.status);
      error.status = response.status;
      throw error;
    }
    const body = await response.json();
    const reply = body?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim()) throw new Error('Groq returned an empty reply.');
    return reply;
  } finally { clearTimeout(timeout); }
}

async function geminiChat(messages, timeoutMs) {
  const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = client.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-3.8-flash', systemInstruction: systemPrompt, generationConfig: { maxOutputTokens: 768 } });
  const history = messages.slice(0, -1);
  while (history.length && history[0].role !== 'user') history.shift();
  const chat = model.startChat({ history: history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })) });
  let timer;
  try {
    const result = await Promise.race([
      chat.sendMessage(messages.at(-1).content),
      new Promise((_, reject) => { timer = setTimeout(() => { const e = new Error('Gemini timeout'); e.status = 504; reject(e); }, timeoutMs); })
    ]);
    const reply = result.response.text();
    if (!reply?.trim()) throw new Error('Gemini returned an empty reply.');
    return reply;
  } finally { clearTimeout(timer); }
}

export async function routeChat(messages) {
  const hasGroq = Boolean(process.env.GROQ_API_KEY?.trim());
  const hasGemini = Boolean(process.env.GEMINI_API_KEY?.trim());
  if (!hasGroq && !hasGemini) { const e = new Error('No cloud AI configured. Set GROQ_API_KEY or GEMINI_API_KEY in Render.'); e.status = 503; throw e; }
  const start = Date.now();
  if (hasGroq) {
    try { return { reply: await groqChat(messages, 11000), provider: 'groq', model: groqModel }; }
    catch (error) {
      if (!hasGemini || !classify(error).fallback) throw error;
      console.warn('Groq temporarily unavailable; switching to Gemini backup. HTTP status:', error.status || 'timeout');
    }
  }
  const remaining = Math.max(1000, 19000 - (Date.now() - start));
  return { reply: await geminiChat(messages, Math.min(remaining, 8000)), provider: 'gemini', model: process.env.GEMINI_MODEL || 'gemini-3.8-flash' };
}
