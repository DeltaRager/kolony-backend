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
Set `BACKEND_BASE_URL` to the externally reachable backend base URL for agent connect/exchange responses.

`SUPABASE_DB_URL` is optional and only for external SQL tools/migration workflows.

3. Start dev server:
```bash
npm run dev
```

Server runs on `http://localhost:4000` by default.

## Agent Connect Flow (v1)

Kolony now supports one-time connect intents for external agents:

1. Operator generates connect intent:
- `POST /api/v1/agents/connect-intents`
- returns one-time `setupCode` + `setupUrl`

2. External agent exchanges setup code:
- `POST /api/v1/mcp/connect/exchange`
- request: `{ setupCode, agentExternalId }`
- returns long-lived agent bearer token and MCP base URL

3. External agent registers metadata:
- `POST /api/v1/mcp/agents/register`
- request includes `name`, `purpose`, `tools` (+ optional `capabilities`)

4. External agent reports active task and logs:
- `POST /api/v1/mcp/agents/active-task`
- `POST /api/v1/mcp/agents/tasks/:taskId/logs`

5. Operator reads active task and logs:
- `GET /api/v1/agents/:id/active-task`
- `GET /api/v1/agents/:id/tasks/:taskId/logs`

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
