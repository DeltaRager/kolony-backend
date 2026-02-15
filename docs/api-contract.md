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

- `POST /agents/connect-intents` (`operator` or `admin`)
  - Creates provisional agent onboarding intent.
  - Body:
    - `displayName?: string`
  - Response:
    - `intentId`, `agentId`, `setupCode`, `setupUrl`, `expiresAt`, `createdAt`

- `DELETE /agents/:id` (`operator` or `admin`)
  - Deletes an agent only when it has no command history.
  - Returns `409` when command history exists.

- `GET /agents/:id/active-task`
  - Returns latest active/most-recent task reported by an agent.

- `GET /agents/:id/tasks/:taskId/logs?cursor=&limit=`
  - Returns paginated task logs ordered by `seq`.

- `GET /agents/:id/board`
  - Returns board-oriented task list (`backlog|ready|in_progress|done`).

- `PATCH /agents/:id/tasks/:taskId/board-status` (`operator` or `admin`)
  - Body:
    - `boardStatus: backlog|ready|in_progress|done`
    - `boardOrder?: number`

- `GET /agents/:id/code/sessions/active`
  - Returns latest code session for agent.

- `POST /agents/:id/code/sessions` (`operator` or `admin`)
  - Creates or reuses active code session.

- `POST /agents/:id/code/sessions/:sessionId/input` (`operator` or `admin`)
  - Appends operator terminal input for agent runtime consumption.

- `GET /agents/:id/code/sessions/:sessionId/events?cursor=&limit=`
  - Returns paginated terminal events.

- `GET /agents/:id/code/sessions/:sessionId/stream`
  - SSE stream for live terminal output/input events.

- `GET /agents/:id/workspace/tree`
  - Returns latest agent-reported workspace tree snapshot.

- `GET /agents/:id/workspace/file?path=...`
  - Returns file content from latest snapshot.

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
  - Query-token auth is restricted to this stream endpoint.

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
- `POST /connect/exchange`
  - One-time setup-code exchange for long-lived agent token.
- `POST /agents/active-task`
  - Upserts active task state (`queued|running|completed|failed|cancelled`).
- `POST /agents/tasks/:taskId/logs`
  - Appends task log lines with sequence ordering.
- `POST /agents/tasks/:taskId/board-status`
  - Agent sets board state updates for task.
- `POST /agents/code/sessions/:sessionId/output`
  - Agent appends terminal output lines to code session.
- `POST /agents/workspace/snapshot`
  - Agent upserts workspace tree snapshot and optional file contents.
- `POST /commands/claim`
  - Atomically claims queued commands for this agent.
  - Body:
    - `maxClaims?: 1..10` (default 1)
    - `leaseSeconds?: 15..300` (default 60)
    - `waitMs?: 0..25000` (optional long-poll)
- `POST /commands/:id/lease/extend`
  - Extends lease while command is `dispatching` or `executing`.
- `POST /commands/:id/release`
  - Releases claimed command back to `queued`.
- `POST /commands/:id/progress`
  - Valid transitions: `queued -> dispatching -> executing`.
- `POST /commands/:id/result`
  - Appends output; `isFinal=true` completes command.
- `POST /commands/:id/fail`
  - Marks command failed with error.
