#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required. Install jq and rerun." >&2
  exit 1
fi

BACKEND_URL="${BACKEND_URL:-http://localhost:4000}"
ACCESS_TOKEN="${ACCESS_TOKEN:-}"
AGENT_NAME="${AGENT_NAME:-Local Smoke Agent}"
AGENT_EXTERNAL_ID="${AGENT_EXTERNAL_ID:-local-smoke-agent-$(date +%s)}"
INSTRUCTION="${INSTRUCTION:-run diagnostics}"

if [[ -z "$ACCESS_TOKEN" ]]; then
  echo "Usage:" >&2
  echo "  ACCESS_TOKEN=<supabase_user_access_token> [BACKEND_URL=http://localhost:4000] $0" >&2
  exit 1
fi

echo "==> Creating agent"
CREATE_AGENT_RESPONSE="$(curl -sS -X POST "$BACKEND_URL/api/v1/agents" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg name "$AGENT_NAME" --arg externalId "$AGENT_EXTERNAL_ID" \
    '{name:$name,externalId:$externalId,capabilities:["echo","status"]}')" \
)"

AGENT_ID="$(jq -r '.data.id // empty' <<<"$CREATE_AGENT_RESPONSE")"
AGENT_TOKEN="$(jq -r '.credentials.token // empty' <<<"$CREATE_AGENT_RESPONSE")"

if [[ -z "$AGENT_ID" || -z "$AGENT_TOKEN" ]]; then
  echo "Failed to create agent. Response:" >&2
  echo "$CREATE_AGENT_RESPONSE" | jq . >&2
  exit 1
fi

echo "Agent ID: $AGENT_ID"
echo "External ID: $AGENT_EXTERNAL_ID"

echo "==> Registering agent"
curl -sS -X POST "$BACKEND_URL/api/v1/mcp/agents/register" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg externalId "$AGENT_EXTERNAL_ID" --arg name "$AGENT_NAME" \
    '{externalId:$externalId,name:$name,capabilities:["echo","status"]}')" \
  | jq .

echo "==> Sending heartbeat"
curl -sS -X POST "$BACKEND_URL/api/v1/mcp/agents/heartbeat" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"online","metadata":{"source":"mcp_smoke_test.sh"}}' \
  | jq .

echo "==> Creating command"
CREATE_COMMAND_RESPONSE="$(curl -sS -X POST "$BACKEND_URL/api/v1/commands" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg agentId "$AGENT_ID" --arg instruction "$INSTRUCTION" \
    '{agentId:$agentId,instruction:$instruction,payload:{smoke_test:true}}')" \
)"

COMMAND_ID="$(jq -r '.data.id // empty' <<<"$CREATE_COMMAND_RESPONSE")"
if [[ -z "$COMMAND_ID" ]]; then
  echo "Failed to create command. Response:" >&2
  echo "$CREATE_COMMAND_RESPONSE" | jq . >&2
  exit 1
fi
echo "Command ID: $COMMAND_ID"

echo "==> Posting progress (dispatching)"
curl -sS -X POST "$BACKEND_URL/api/v1/mcp/commands/$COMMAND_ID/progress" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"dispatching","payload":{"phase":"queued->dispatching"}}' \
  | jq .

echo "==> Posting progress (executing)"
curl -sS -X POST "$BACKEND_URL/api/v1/mcp/commands/$COMMAND_ID/progress" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"executing","payload":{"phase":"dispatching->executing"}}' \
  | jq .

echo "==> Posting result chunk"
curl -sS -X POST "$BACKEND_URL/api/v1/mcp/commands/$COMMAND_ID/result" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chunkIndex":0,"output":"Diagnostics started","isFinal":false}' \
  | jq .

echo "==> Posting final result"
curl -sS -X POST "$BACKEND_URL/api/v1/mcp/commands/$COMMAND_ID/result" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chunkIndex":1,"output":"Diagnostics complete: OK","isFinal":true}' \
  | jq .

echo "==> Verifying command state"
curl -sS "$BACKEND_URL/api/v1/commands/$COMMAND_ID" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  | jq .

echo "==> Verifying command results"
curl -sS "$BACKEND_URL/api/v1/commands/$COMMAND_ID/results" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  | jq .

echo "==> Smoke test complete"
echo "Agent ID: $AGENT_ID"
echo "Command ID: $COMMAND_ID"
