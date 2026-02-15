# Kolony Backend API Contract (MVP)

Base URL: `http://localhost:4000`

## Operator APIs (`/api/v1`)

Auth: Supabase user access token via `Authorization: Bearer <token>`.

- `GET /agents`
  - Lists all known agents.

- `POST /agents` (`operator` or `admin`)
  - Creates allowlisted agent credentials.
  - Body:
    - `name: string`
    - `externalId?: string`
    - `capabilities?: string[]`
    - `token?: string` (optional caller-provided token)
  - Response includes generated token once.

- `POST /commands` (`operator` or `admin`)
  - Body:
    - `agentId: uuid`
    - `instruction: string`
    - `payload?: object`
    - `priority?: 1..10`

- `GET /commands/:id`
  - Returns command state and metadata.

- `GET /commands/:id/results`
  - Returns ordered output chunks.

- `GET /commands/:id/stream`
  - SSE stream for live status/output updates.
  - Supports bearer auth or `?access_token=` query for browser EventSource.

- `POST /commands/:id/cancel` (`operator` or `admin`)
  - Cancels command if transition is valid.

- `GET /events?agentId=&commandId=&limit=`
  - Timeline and audit events.

## MCP/Agent APIs (`/api/v1/mcp`)

Auth: static agent token via `Authorization: Bearer <agent_token>`.

- `POST /agents/register`
  - Binds runtime metadata to allowlisted agent.
- `POST /agents/heartbeat`
  - Updates status + heartbeat timestamp.
- `POST /commands/:id/progress`
  - Valid transitions: `queued -> dispatching -> executing`.
- `POST /commands/:id/result`
  - Appends output; `isFinal=true` completes command.
- `POST /commands/:id/fail`
  - Marks command failed with error.
