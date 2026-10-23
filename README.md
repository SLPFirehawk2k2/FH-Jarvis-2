# J.A.R.V.I.S. Mark II

A browser-based J.A.R.V.I.S. assistant with a cyan HUD, text chat, browser speech input/output, server-side Google Gemini chat, local timers/reminders, and local weather lookup.

## Requirements

- Node.js 20 or newer
- A Google Gemini API key for AI chat

## Run locally

1. Copy `.env.example` to `.env`.
2. Put your Gemini key in `GEMINI_API_KEY` in `.env`. Keep this key on the server; never put it in browser code or commit your real `.env` file.
3. Install dependencies: `npm install`.
4. Run tests: `npm test`.
5. Start the app: `npm start`.
6. Open http://localhost:3000.

No J.A.R.V.I.S. access-token prompt is required.

## Environment variables

- `GEMINI_API_KEY`: required for AI chat; server-side only.
- `GEMINI_MODEL`: defaults to `gemini-3.8-flash`. If that model is unavailable, overloaded, rate-limited, or times out, the server can fall back to `gemini-3.6-flash` within a bounded response budget.
- `ALLOWED_ORIGINS`: optional comma-separated browser-origin allowlist. Set this to the frontend origin(s) allowed to call this server. Allowed origins receive the CORS headers needed for cross-origin use; this is not authentication.
- `CONNECT_SRC_ORIGINS`: optional comma-separated list of trusted backend origins that the dashboard browser may connect to. Configure this on the frontend/dashboard service when using a different backend URL. Use exact `https://host` origins, not paths or wildcards. The backend service must also list the frontend origin in its own `ALLOWED_ORIGINS`.
- `PORT`: port for the local/server process; defaults to `3000` (Render provides its own value).

## Render deployment

The live Mark II service is configured in Render to deploy the `main` branch of this repository automatically. It uses `npm install`, `npm start`, and the `/health` health check. Configure `GEMINI_API_KEY` as a secret environment variable in Render. Do not add an access-token variable unless the application is intentionally redesigned to use one.

The `render.yaml` file describes the service and its non-secret settings. Review the Blueprint before applying it to an existing service.

### Using a separate backend

For the dashboard's **Backend URL** setting to work cross-origin, add the backend's exact origin to `CONNECT_SRC_ORIGINS` on the dashboard service, and add the dashboard's exact origin to `ALLOWED_ORIGINS` on the backend service. Both sides must be configured; this avoids broad CSP or CORS wildcards. Same-origin deployment needs no extra configuration.

## Weather

The dashboard can use browser location permission or a manually entered city. Weather lookup uses the Open-Meteo geocoding and forecast APIs; no API key is needed for the current non-commercial setup. The dashboard includes Open-Meteo attribution. Location permission can be denied; entering a city is the fallback.

## Voice

Speech recognition depends on browser/OS support and microphone permission; current Chrome and Edge are recommended. Push-to-talk is user-initiated. Hands-free mode uses browser speech recognition to detect “Jarvis” and is not a guaranteed always-on wake-word engine; browser suspension may stop it. Speech output uses browser voices.

## Timers and reminders

Timers and reminders are stored in this browser's local storage and run in the page. Keep the J.A.R.V.I.S. tab open for due notifications; these are not server-side or guaranteed background reminders.

## Security and scope

- Never expose the Gemini API key in frontend code.
- The API uses per-IP rate limiting and can restrict browser origins with `ALLOWED_ORIGINS`; neither is a replacement for authentication. The current public service does not require a shared access token.
- The cloud app does not run shell commands or directly control Windows or OBS. Those capabilities require a separately designed local companion and explicit security controls.
- The legacy `FH-Jarvis-1.0` repository and `fh-jarvis-cloud-ai` Render service are separate and are not modified by Mark II changes.
