# J.A.R.V.I.S. Mark II

A clean cloud-ready browser assistant starter: cyan holographic HUD, typed chat, browser speech input/output, and server-side Google Gemini integration.

## Requirements
- Node.js 20+
- Google Gemini API key

## Run locally
1. Copy `.env.example` to `.env`.
2. Add your key to `GEMINI_API_KEY`; set a long random `JARVIS_ACCESS_TOKEN`.
3. Run `npm install`, then `npm start`.
4. Open http://localhost:3000 and set the backend URL/token in HUD Settings if needed.

## Environment
- `GEMINI_API_KEY`: required for AI chat; server-side only.
- `GEMINI_MODEL`: defaults to `gemini-2.5-flash`.
- `JARVIS_ACCESS_TOKEN`: optional bearer-token gate; strongly recommended for private hosting.
- `ALLOWED_ORIGINS`: optional comma-separated origin allowlist.
- `PORT`: defaults to 3000.

## Deploy
Use the included `render.yaml` as a Render Blueprint or create a Node web service with `npm install` / `npm start`. Configure Gemini and access-token values as secret environment variables. The repository includes a GitHub Actions test workflow.

## Voice
Speech recognition depends on browser/OS support and microphone permission; current Chrome/Edge are recommended. Push-to-talk is user-initiated. Hands-free mode uses browser speech recognition to detect “Jarvis” and is not a guaranteed always-on wake-word engine; browser suspension may stop it. Speech output uses browser voices.

## Security and scope
Never put the Gemini key in frontend code. Use HTTPS in cloud deployments and set a strong access token. A shared bearer token is a lightweight gate, not full multi-user authentication. This starter does not run shell commands or control Windows/OBS. Add those later as explicit, authenticated integrations.
