# Nexus AI — backend API

Node.js Express API for the Nexus AI Android app and web client. Postgres is the source of truth for synced data; LiteLLM fronts Gemini/Groq.

This repository is only the API and its Docker / LiteLLM / nginx config. The Flutter app and the React web client are separate GitHub repos.

## Repositories

| Piece | GitHub |
| --- | --- |
| **Backend (this repo)** | https://github.com/monish0612/ainexus |
| Android (Flutter) | https://github.com/monish0612/ainexus-app- |
| Web (React) | https://github.com/monish0612/ainexus-web |
| Narration (TTS) | https://github.com/monish0612/narrator |
| Speech-to-text | https://github.com/monish0612/stt-gateway |

Live site: `https://monishlabs.com` — API under `/nexusai/api/v1`.

## Layout

- `api/` — Express app (`api/src/index.js`), prompts, Gemini direct path, news, cloud/NAS, tests
- `database/` — SQL schema / migrations
- `litellm/` — LiteLLM proxy config
- `docker-compose.yml` — API + Postgres + Redis + LiteLLM
- `env.example` — copy to `.env`; never commit real keys

## Local run

```bash
cp env.example .env   # fill secrets locally only
cd api
npm install
npm test
npm run dev           # nodemon on :3000
```

Or `docker compose up --build` from the repo root. Required env (see `env.example`): `DATABASE_URL` / `DB_PASSWORD`, `JWT_SECRET`, LiteLLM keys, `GOOGLE_API_KEY`. Optional: Drive, NAS WebDAV, Tavily, xGrok — those features return a friendly 503 when unset.

## Recent API behavior (for agents)

- `/api/v1/ai/rephrase` uses SwiftSlate-style `<input>` wrapping, platform tones (fix/improve/shorten/expand/human/formal/emoji/reply/define), and refuses to return model safety refusals.
- News, cloud backups, NAS stats/files, expense sync, and narration hooks stay in `api/src/`. Do not put tokens in git.
