# Kolony Backend Workspace

This folder owns backend concerns for Kolony.

## Scope
- Supabase/Postgres schema and migrations
- Backend APIs and orchestration services
- Secret keys and server-only credentials

## Initial Structure
- `supabase/migrations/`: SQL migrations for schema evolution
- `docs/`: backend architecture and schema docs
- `.env.example`: backend-only environment template
- `src/`: Express TypeScript API service

## Notes
- Frontend code is isolated under `../frontend`.
- Do not place frontend build/runtime assets in this workspace.

## Run Backend API

1. Install deps:
```bash
npm install
```

2. Configure environment:
```bash
cp .env.example .env
```

Use Supabase publishable key for user-token verification (`SUPABASE_PUBLISHABLE_KEY`).
Use Supabase secret key for backend elevated access (`SUPABASE_SECRET_KEY`).
Legacy `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are compatibility fallbacks in code.
Backend runtime uses Supabase Data API via `SUPABASE_URL` + keys; it does not require a direct Postgres URL.

`SUPABASE_DB_URL` is optional and only for external SQL tools/migration workflows.

3. Start dev server:
```bash
npm run dev
```

Server runs on `http://localhost:4000` by default.

## Run MCP Smoke Test

This script simulates an agent end-to-end:
- creates an agent
- registers + heartbeats
- creates a command
- posts progress + results
- verifies final command state

```bash
ACCESS_TOKEN=<supabase_user_access_token> ./scripts/mcp_smoke_test.sh
```

Optional overrides:
- `BACKEND_URL` (default: `http://localhost:4000`)
- `AGENT_NAME`
- `AGENT_EXTERNAL_ID`
- `INSTRUCTION`
