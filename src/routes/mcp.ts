import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { createEvent } from '../lib/events.js';
import { canTransition } from '../lib/lifecycle.js';
import { sha256 } from '../lib/crypto.js';
import { realtimeHub } from '../lib/realtime-hub.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAgent, type AgentRequest } from '../middleware/agent-auth.js';
import type { AgentStatus, CommandStatus } from '../types.js';

const registerSchema = z.object({
  externalId: z.string().min(1),
  name: z.string().min(1),
  purpose: z.string().max(500).optional().default(''),
  capabilities: z.array(z.string()).optional(),
  tools: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        inputSchema: z.record(z.unknown()).optional()
      })
    )
    .optional()
    .default([])
});

const exchangeSchema = z.object({
  setupCode: z.string().min(6),
  agentExternalId: z.string().min(1)
});

const heartbeatSchema = z.object({
  status: z.enum(['online', 'offline', 'busy', 'error']),
  metadata: z.record(z.unknown()).optional()
});

const activeTaskSchema = z.object({
  externalTaskId: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  startedAt: z.string().datetime().optional(),
  errorMessage: z.string().optional()
});

const taskLogsSchema = z.object({
  lines: z
    .array(
      z.object({
        ts: z.string().datetime().optional(),
        level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
        line: z.string().min(1)
      })
    )
    .min(1)
});

const boardStatusSchema = z.object({
  boardStatus: z.enum(['backlog', 'ready', 'in_progress', 'done']),
  boardOrder: z.coerce.number().optional()
});

const codeSessionOutputSchema = z.object({
  lines: z
    .array(
      z.object({
        ts: z.string().datetime().optional(),
        level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
        line: z.string().min(1)
      })
    )
    .min(1),
  status: z.enum(['active', 'idle', 'closed', 'error']).optional()
});

const workspaceSnapshotSchema = z.object({
  snapshotVersion: z.number().int().nonnegative(),
  tree: z.record(z.unknown()),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string().optional(),
        contentHash: z.string().optional(),
        size: z.number().int().nonnegative().optional(),
        language: z.string().optional()
      })
    )
    .optional()
    .default([])
});

const progressSchema = z.object({
  status: z.enum(['dispatching', 'executing']),
  payload: z.record(z.unknown()).optional()
});

const resultSchema = z.object({
  chunkIndex: z.number().int().min(0),
  output: z.string().min(1),
  isFinal: z.boolean(),
  metadata: z.record(z.unknown()).optional()
});

const failSchema = z.object({
  errorMessage: z.string().min(1)
});

const claimCommandsSchema = z.object({
  maxClaims: z.number().int().min(1).max(10).optional().default(1),
  leaseSeconds: z.number().int().min(15).max(300).optional().default(60),
  waitMs: z.number().int().min(0).max(25000).optional().default(0)
});

const extendLeaseSchema = z.object({
  leaseSeconds: z.number().int().min(15).max(300)
});

const releaseCommandSchema = z.object({
  reason: z.string().max(500).optional()
});

function asStatus(value: string): CommandStatus {
  return value as CommandStatus;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export const mcpRouter = Router();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

mcpRouter.post('/commands/claim', requireAgent, async (request: AgentRequest, response) => {
  const parsed = claimCommandsSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  const { maxClaims, leaseSeconds, waitMs } = parsed.data;
  const start = Date.now();
  const timeoutAt = start + waitMs;

  while (true) {
    const { data, error } = await supabaseAdmin.rpc('claim_agent_commands', {
      p_agent_id: request.agentId!,
      p_max_claims: maxClaims,
      p_lease_seconds: leaseSeconds
    });
    if (error) return response.status(500).json({ error: error.message });

    const items = Array.isArray(data) ? data : [];
    if (items.length > 0) {
      const timestamp = new Date().toISOString();
      await Promise.all(
        items.map((item) =>
          createEvent({
            eventType: 'command.claimed',
            commandId: typeof item.id === 'string' ? item.id : null,
            agentId: request.agentId,
            payload: { leaseSeconds }
          })
        )
      );

      items.forEach((item) => {
        if (typeof item.id !== 'string') return;
        realtimeHub.publish(item.id, {
          commandId: item.id,
          status: 'dispatching',
          eventType: 'command.claimed',
          timestamp
        });
      });

      return response.json({ data: { items } });
    }

    if (Date.now() >= timeoutAt) {
      return response.json({ data: { items: [] } });
    }

    await sleep(Math.min(1000, Math.max(100, timeoutAt - Date.now())));
  }
});

mcpRouter.post('/commands/:id/lease/extend', requireAgent, async (request: AgentRequest, response) => {
  const parsed = extendLeaseSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }
  const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
  if (!id) return response.status(400).json({ error: 'Missing command id' });

  const { data: command, error: commandError } = await supabaseAdmin
    .from('commands')
    .select('id,agent_id,status,claimed_by_agent_id')
    .eq('id', id)
    .maybeSingle();
  if (commandError) return response.status(500).json({ error: commandError.message });
  if (!command) return response.status(404).json({ error: 'Command not found' });
  if (command.agent_id !== request.agentId) return response.status(403).json({ error: 'Command does not belong to agent' });
  if (command.claimed_by_agent_id !== request.agentId) {
    return response.status(409).json({ error: 'Command is not currently claimed by this agent' });
  }

  const status = asStatus(command.status);
  if (status !== 'dispatching' && status !== 'executing') {
    return response.status(409).json({ error: `Cannot extend lease in status ${status}` });
  }

  const now = Date.now();
  const leaseExpiresAt = new Date(now + parsed.data.leaseSeconds * 1000).toISOString();
  const { error: updateError } = await supabaseAdmin
    .from('commands')
    .update({ lease_expires_at: leaseExpiresAt })
    .eq('id', id);
  if (updateError) return response.status(500).json({ error: updateError.message });

  await createEvent({
    eventType: 'command.lease_extended',
    commandId: id,
    agentId: request.agentId,
    payload: { leaseSeconds: parsed.data.leaseSeconds }
  });

  return response.json({ data: { id, leaseExpiresAt } });
});

mcpRouter.post('/commands/:id/release', requireAgent, async (request: AgentRequest, response) => {
  const parsed = releaseCommandSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }
  const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
  if (!id) return response.status(400).json({ error: 'Missing command id' });

  const { data: command, error: commandError } = await supabaseAdmin
    .from('commands')
    .select('id,agent_id,status,claimed_by_agent_id')
    .eq('id', id)
    .maybeSingle();
  if (commandError) return response.status(500).json({ error: commandError.message });
  if (!command) return response.status(404).json({ error: 'Command not found' });
  if (command.agent_id !== request.agentId) return response.status(403).json({ error: 'Command does not belong to agent' });
  if (command.claimed_by_agent_id !== request.agentId) {
    return response.status(409).json({ error: 'Command is not currently claimed by this agent' });
  }

  const status = asStatus(command.status);
  if (status !== 'dispatching' && status !== 'executing') {
    return response.status(409).json({ error: `Cannot release command in status ${status}` });
  }

  const { error: updateError } = await supabaseAdmin
    .from('commands')
    .update({
      status: 'queued',
      claimed_by_agent_id: null,
      claimed_at: null,
      lease_expires_at: null,
      started_at: null,
      last_claim_error: parsed.data.reason ?? null
    })
    .eq('id', id);
  if (updateError) return response.status(500).json({ error: updateError.message });

  await createEvent({
    eventType: 'command.released',
    commandId: id,
    agentId: request.agentId,
    payload: { reason: parsed.data.reason ?? null }
  });

  realtimeHub.publish(id, {
    commandId: id,
    status: 'queued',
    eventType: 'command.released',
    timestamp: new Date().toISOString()
  });

  return response.json({ data: { id, status: 'queued' } });
});

mcpRouter.post('/connect/exchange', async (request, response) => {
  const parsed = exchangeSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  const setupCodeHash = sha256(parsed.data.setupCode);
  const nowIso = new Date().toISOString();
  const { data: intent, error: intentError } = await supabaseAdmin
    .from('agent_connect_intents')
    .select('id,agent_id,expires_at,consumed_at')
    .eq('setup_code_hash', setupCodeHash)
    .maybeSingle();

  if (intentError) return response.status(500).json({ error: intentError.message });
  if (!intent || intent.consumed_at) {
    return response.status(404).json({ error: 'Invalid or already consumed setup code' });
  }

  if (new Date(intent.expires_at).getTime() <= Date.now()) {
    return response.status(410).json({ error: 'Setup code expired' });
  }

  const token = randomBytes(24).toString('hex');
  const tokenHash = sha256(token);
  const tokenHint = `${token.slice(0, 4)}...${token.slice(-4)}`;

  const { error: agentError } = await supabaseAdmin
    .from('agents')
    .update({
      external_id: parsed.data.agentExternalId,
      token_hash: tokenHash,
      token_hint: tokenHint,
      token_active: true,
      status: 'offline' satisfies AgentStatus
    })
    .eq('id', intent.agent_id);
  if (agentError) return response.status(500).json({ error: agentError.message });

  const { error: consumeError } = await supabaseAdmin
    .from('agent_connect_intents')
    .update({ consumed_at: nowIso })
    .eq('id', intent.id);
  if (consumeError) return response.status(500).json({ error: consumeError.message });

  await createEvent({
    eventType: 'agent.connected',
    agentId: intent.agent_id,
    payload: { externalId: parsed.data.agentExternalId }
  });

  return response.json({
    data: {
      agentId: intent.agent_id,
      token,
      mcpBaseUrl: `${config.BACKEND_BASE_URL}/api/v1/mcp`
    }
  });
});

mcpRouter.post('/agents/register', requireAgent, async (request: AgentRequest, response) => {
  const parsed = registerSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }
  const payload = parsed.data;

  const { data: currentAgent, error: currentError } = await supabaseAdmin
    .from('agents')
    .select('metadata')
    .eq('id', request.agentId)
    .maybeSingle();
  if (currentError) return response.status(500).json({ error: currentError.message });

  const metadata = {
    ...asObject(currentAgent?.metadata),
    purpose: payload.purpose,
    tools: payload.tools,
    provisional: false,
    connected_at: new Date().toISOString()
  };

  const capabilities = payload.capabilities ?? payload.tools.map((tool) => tool.name);

  const { data, error } = await supabaseAdmin
    .from('agents')
    .update({
      external_id: payload.externalId,
      name: payload.name,
      capabilities,
      metadata,
      status: 'online' satisfies AgentStatus,
      last_heartbeat_at: new Date().toISOString()
    })
    .eq('id', request.agentId)
    .select('id,name,status,external_id,capabilities,metadata,last_heartbeat_at')
    .single();

  if (error) return response.status(500).json({ error: error.message });

  await createEvent({
    eventType: 'agent.registered',
    agentId: request.agentId,
    payload: { externalId: payload.externalId, purpose: payload.purpose, toolCount: payload.tools.length }
  });

  return response.json({ data });
});

mcpRouter.post('/agents/heartbeat', requireAgent, async (request: AgentRequest, response) => {
  const parsed = heartbeatSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  const now = new Date().toISOString();
  const { data: currentAgent, error: currentError } = await supabaseAdmin
    .from('agents')
    .select('metadata')
    .eq('id', request.agentId)
    .maybeSingle();
  if (currentError) return response.status(500).json({ error: currentError.message });

  const mergedMetadata = {
    ...asObject(currentAgent?.metadata),
    ...(parsed.data.metadata ?? {})
  };

  const { data, error } = await supabaseAdmin
    .from('agents')
    .update({
      status: parsed.data.status,
      metadata: mergedMetadata,
      last_heartbeat_at: now
    })
    .eq('id', request.agentId)
    .select('id,status,last_heartbeat_at')
    .single();

  if (error) return response.status(500).json({ error: error.message });

  await createEvent({
    eventType: 'agent.heartbeat',
    agentId: request.agentId,
    payload: { status: parsed.data.status }
  });

  return response.json({ data });
});

mcpRouter.post('/agents/active-task', requireAgent, async (request: AgentRequest, response) => {
  const parsed = activeTaskSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  const payload = parsed.data;
  const nowIso = new Date().toISOString();
  const isTerminal = payload.status === 'completed' || payload.status === 'failed' || payload.status === 'cancelled';
  const { data: existingTask, error: existingTaskError } = await supabaseAdmin
    .from('agent_tasks')
    .select('id,started_at,completed_at,board_status,board_order')
    .eq('agent_id', request.agentId!)
    .eq('external_task_id', payload.externalTaskId)
    .maybeSingle();
  if (existingTaskError) return response.status(500).json({ error: existingTaskError.message });

  const startedAt =
    payload.startedAt ??
    existingTask?.started_at ??
    (payload.status === 'running' ? nowIso : null);
  const completedAt = isTerminal ? (existingTask?.completed_at ?? nowIso) : null;

  const taskPatch: {
    agent_id: string;
    external_task_id: string;
    title: string;
    status: string;
    error_message: string | null;
    started_at: string | null;
    completed_at: string | null;
    board_status: 'backlog' | 'ready' | 'in_progress' | 'done';
    board_order: number;
    board_updated_at: string;
    updated_at: string;
  } = {
    agent_id: request.agentId!,
    external_task_id: payload.externalTaskId,
    title: payload.title,
    status: payload.status,
    error_message: payload.errorMessage ?? null,
    started_at: startedAt,
    completed_at: completedAt,
    board_status:
      payload.status === 'running'
        ? 'in_progress'
        : isTerminal
          ? 'done'
          : ((existingTask?.board_status as 'backlog' | 'ready' | 'in_progress' | 'done' | undefined) ?? 'ready'),
    board_order: typeof existingTask?.board_order === 'number' ? existingTask.board_order : Date.now(),
    board_updated_at: nowIso,
    updated_at: nowIso
  };

  const { data: task, error: taskError } = await supabaseAdmin
    .from('agent_tasks')
    .upsert(taskPatch, { onConflict: 'agent_id,external_task_id' })
    .select('id,agent_id,external_task_id,title,status,board_status,board_order,error_message,started_at,completed_at,updated_at,created_at')
    .single();

  if (taskError || !task) return response.status(500).json({ error: taskError?.message ?? 'Failed to upsert task' });

  const { data: agentRow, error: agentError } = await supabaseAdmin
    .from('agents')
    .select('metadata')
    .eq('id', request.agentId)
    .maybeSingle();
  if (agentError) return response.status(500).json({ error: agentError.message });

  const mergedMetadata = {
    ...asObject(agentRow?.metadata),
    active_task_id: isTerminal ? null : task.id,
    active_task_external_id: isTerminal ? null : payload.externalTaskId,
    active_task_updated_at: nowIso
  };

  const nextAgentStatus: AgentStatus = payload.status === 'running' ? 'busy' : 'online';
  const { error: updateAgentError } = await supabaseAdmin
    .from('agents')
    .update({
      status: nextAgentStatus,
      metadata: mergedMetadata,
      last_heartbeat_at: nowIso
    })
    .eq('id', request.agentId);
  if (updateAgentError) return response.status(500).json({ error: updateAgentError.message });

  await createEvent({
    eventType: 'agent.task.active_changed',
    agentId: request.agentId,
    payload: {
      taskId: task.id,
      externalTaskId: task.external_task_id,
      status: task.status,
      title: task.title
    }
  });

  realtimeHub.publish(`agent:${request.agentId}`, {
    commandId: task.id,
    status: task.status,
    eventType: 'agent.task.active_changed',
    timestamp: nowIso
  });

  return response.json({ data: task });
});

mcpRouter.post('/agents/tasks/:taskId/logs', requireAgent, async (request: AgentRequest, response) => {
  const taskId = Array.isArray(request.params.taskId) ? request.params.taskId[0] : request.params.taskId;
  if (!taskId) return response.status(400).json({ error: 'Missing task id' });

  const parsed = taskLogsSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  const { data: task, error: taskError } = await supabaseAdmin
    .from('agent_tasks')
    .select('id,agent_id')
    .eq('id', taskId)
    .maybeSingle();
  if (taskError) return response.status(500).json({ error: taskError.message });
  if (!task) return response.status(404).json({ error: 'Task not found' });
  if (task.agent_id !== request.agentId) return response.status(403).json({ error: 'Task does not belong to agent' });

  const { data: latestLog, error: latestLogError } = await supabaseAdmin
    .from('agent_task_logs')
    .select('seq')
    .eq('task_id', taskId)
    .order('seq', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestLogError) return response.status(500).json({ error: latestLogError.message });

  const startSeq = typeof latestLog?.seq === 'number' ? latestLog.seq : 0;
  const nowIso = new Date().toISOString();
  const rows = parsed.data.lines.map((line, idx) => ({
    task_id: taskId,
    seq: startSeq + idx + 1,
    ts: line.ts ?? nowIso,
    level: line.level ?? 'info',
    line: line.line
  }));

  const { error: insertError } = await supabaseAdmin.from('agent_task_logs').insert(rows);
  if (insertError) return response.status(500).json({ error: insertError.message });

  await createEvent({
    eventType: 'agent.task.log_appended',
    agentId: request.agentId,
    payload: { taskId, count: rows.length }
  });

  realtimeHub.publish(`agent:${request.agentId}`, {
    commandId: taskId,
    eventType: 'agent.task.log_appended',
    timestamp: nowIso
  });

  return response.json({
    data: {
      taskId,
      accepted: true,
      count: rows.length,
      nextSeq: startSeq + rows.length
    }
  });
});

mcpRouter.post('/agents/tasks/:taskId/board-status', requireAgent, async (request: AgentRequest, response) => {
  const taskId = Array.isArray(request.params.taskId) ? request.params.taskId[0] : request.params.taskId;
  if (!taskId) return response.status(400).json({ error: 'Missing task id' });
  const parsed = boardStatusSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  const { data: task, error: taskError } = await supabaseAdmin
    .from('agent_tasks')
    .select('id,agent_id')
    .eq('id', taskId)
    .maybeSingle();
  if (taskError) return response.status(500).json({ error: taskError.message });
  if (!task) return response.status(404).json({ error: 'Task not found' });
  if (task.agent_id !== request.agentId) return response.status(403).json({ error: 'Task does not belong to agent' });

  const nowIso = new Date().toISOString();
  const boardOrder = typeof parsed.data.boardOrder === 'number' ? parsed.data.boardOrder : Date.now();
  const { error: updateError } = await supabaseAdmin
    .from('agent_tasks')
    .update({
      board_status: parsed.data.boardStatus,
      board_order: boardOrder,
      board_updated_at: nowIso,
      updated_at: nowIso
    })
    .eq('id', taskId);
  if (updateError) return response.status(500).json({ error: updateError.message });

  await createEvent({
    eventType: 'agent.board.updated',
    agentId: request.agentId,
    payload: { taskId, boardStatus: parsed.data.boardStatus, boardOrder, source: 'agent' }
  });

  realtimeHub.publish(`agent:${request.agentId}`, {
    commandId: taskId,
    eventType: 'agent.board.updated',
    timestamp: nowIso
  });

  return response.json({ data: { taskId, accepted: true } });
});

mcpRouter.post('/agents/code/sessions/:sessionId/output', requireAgent, async (request: AgentRequest, response) => {
  const sessionId = Array.isArray(request.params.sessionId) ? request.params.sessionId[0] : request.params.sessionId;
  if (!sessionId) return response.status(400).json({ error: 'Missing session id' });
  const parsed = codeSessionOutputSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  const { data: session, error: sessionError } = await supabaseAdmin
    .from('code_sessions')
    .select('id,agent_id,status')
    .eq('id', sessionId)
    .maybeSingle();
  if (sessionError) return response.status(500).json({ error: sessionError.message });
  if (!session) return response.status(404).json({ error: 'Session not found' });
  if (session.agent_id !== request.agentId) return response.status(403).json({ error: 'Session does not belong to agent' });

  const { data: latest, error: latestError } = await supabaseAdmin
    .from('code_session_events')
    .select('seq')
    .eq('session_id', sessionId)
    .order('seq', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) return response.status(500).json({ error: latestError.message });

  const startSeq = typeof latest?.seq === 'number' ? latest.seq : 0;
  const nowIso = new Date().toISOString();
  const rows = parsed.data.lines.map((line, idx) => ({
    session_id: sessionId,
    seq: startSeq + idx + 1,
    direction: 'output',
    payload: {
      ts: line.ts ?? nowIso,
      level: line.level ?? 'info',
      line: line.line
    }
  }));

  const { error: insertError } = await supabaseAdmin.from('code_session_events').insert(rows);
  if (insertError) return response.status(500).json({ error: insertError.message });

  if (parsed.data.status) {
    const patch: { status: string; closed_at?: string | null } = { status: parsed.data.status };
    if (parsed.data.status === 'closed') patch.closed_at = nowIso;
    const { error: patchError } = await supabaseAdmin.from('code_sessions').update(patch).eq('id', sessionId);
    if (patchError) return response.status(500).json({ error: patchError.message });
  }

  await createEvent({
    eventType: 'agent.code.session.output',
    agentId: request.agentId,
    payload: { sessionId, count: rows.length }
  });

  rows.forEach((row) => {
    realtimeHub.publish(`code-session:${sessionId}`, {
      commandId: sessionId,
      eventType: 'agent.code.session.output',
      timestamp: nowIso,
      data: {
        seq: row.seq,
        direction: row.direction,
        payload: row.payload
      }
    });
  });

  return response.json({ data: { accepted: true, count: rows.length } });
});

mcpRouter.post('/agents/workspace/snapshot', requireAgent, async (request: AgentRequest, response) => {
  const parsed = workspaceSnapshotSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  const { data: snapshot, error: snapshotError } = await supabaseAdmin
    .from('agent_workspace_snapshots')
    .upsert(
      {
        agent_id: request.agentId!,
        snapshot_version: parsed.data.snapshotVersion,
        tree_json: parsed.data.tree
      },
      { onConflict: 'agent_id,snapshot_version' }
    )
    .select('id,agent_id,snapshot_version,created_at')
    .single();
  if (snapshotError || !snapshot) {
    return response.status(500).json({ error: snapshotError?.message ?? 'Failed to upsert snapshot' });
  }

  if (parsed.data.files.length > 0) {
    const fileRows = parsed.data.files.map((file) => ({
      snapshot_id: snapshot.id,
      path: file.path,
      content: file.content ?? null,
      content_hash: file.contentHash ?? null,
      size: file.size ?? null,
      language: file.language ?? null,
      updated_at: new Date().toISOString()
    }));
    const { error: filesError } = await supabaseAdmin
      .from('agent_workspace_files')
      .upsert(fileRows, { onConflict: 'snapshot_id,path' });
    if (filesError) return response.status(500).json({ error: filesError.message });
  }

  await createEvent({
    eventType: 'agent.workspace.snapshot.updated',
    agentId: request.agentId,
    payload: { snapshotVersion: snapshot.snapshot_version, fileCount: parsed.data.files.length }
  });

  realtimeHub.publish(`agent:${request.agentId}`, {
    commandId: snapshot.id,
    eventType: 'agent.workspace.snapshot.updated',
    timestamp: new Date().toISOString()
  });

  return response.json({ data: { accepted: true, snapshotId: snapshot.id, fileCount: parsed.data.files.length } });
});

mcpRouter.post('/commands/:id/progress', requireAgent, async (request: AgentRequest, response) => {
  const parsed = progressSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }
  const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
  if (!id) return response.status(400).json({ error: 'Missing command id' });
  const nextStatus = parsed.data.status;

  const { data: command, error: commandError } = await supabaseAdmin
    .from('commands')
    .select('id,agent_id,status')
    .eq('id', id)
    .maybeSingle();
  if (commandError) return response.status(500).json({ error: commandError.message });
  if (!command) return response.status(404).json({ error: 'Command not found' });
  if (command.agent_id !== request.agentId) return response.status(403).json({ error: 'Command does not belong to agent' });

  const current = asStatus(command.status);
  if (!canTransition(current, nextStatus)) {
    return response.status(409).json({ error: `Invalid status transition ${current} -> ${nextStatus}` });
  }

  const patch: { status: CommandStatus; started_at?: string } = { status: nextStatus };
  if (nextStatus === 'executing' && current !== 'executing') {
    patch.started_at = new Date().toISOString();
  }

  const { error: updateError } = await supabaseAdmin.from('commands').update(patch).eq('id', id);
  if (updateError) return response.status(500).json({ error: updateError.message });

  await createEvent({
    eventType: 'command.progress',
    commandId: id,
    agentId: request.agentId,
    payload: { status: nextStatus, detail: parsed.data.payload ?? {} }
  });

  realtimeHub.publish(id, {
    commandId: id,
    status: nextStatus,
    eventType: 'command.progress',
    timestamp: new Date().toISOString()
  });

  return response.json({ data: { id, status: nextStatus } });
});

mcpRouter.post('/commands/:id/result', requireAgent, async (request: AgentRequest, response) => {
  const parsed = resultSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
  if (!id) return response.status(400).json({ error: 'Missing command id' });
  const { data: command, error: commandError } = await supabaseAdmin
    .from('commands')
    .select('id,agent_id,status')
    .eq('id', id)
    .maybeSingle();
  if (commandError) return response.status(500).json({ error: commandError.message });
  if (!command) return response.status(404).json({ error: 'Command not found' });
  if (command.agent_id !== request.agentId) return response.status(403).json({ error: 'Command does not belong to agent' });

  const { error: resultError } = await supabaseAdmin.from('command_results').insert({
    command_id: id,
    chunk_index: parsed.data.chunkIndex,
    output: parsed.data.output,
    is_final: parsed.data.isFinal,
    metadata: parsed.data.metadata ?? {}
  });
  if (resultError) return response.status(500).json({ error: resultError.message });

  if (parsed.data.isFinal) {
    const current = asStatus(command.status);
    if (!canTransition(current, 'completed')) {
      return response.status(409).json({ error: `Invalid status transition ${current} -> completed` });
    }
    const { error: updateError } = await supabaseAdmin
      .from('commands')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', id);
    if (updateError) return response.status(500).json({ error: updateError.message });
  }

  await createEvent({
    eventType: parsed.data.isFinal ? 'command.completed' : 'command.result_chunk',
    commandId: id,
    agentId: request.agentId,
    payload: { chunkIndex: parsed.data.chunkIndex, isFinal: parsed.data.isFinal }
  });

  realtimeHub.publish(id, {
    commandId: id,
    status: parsed.data.isFinal ? 'completed' : command.status,
    result: parsed.data.output,
    isFinal: parsed.data.isFinal,
    eventType: parsed.data.isFinal ? 'command.completed' : 'command.result_chunk',
    timestamp: new Date().toISOString()
  });

  return response.json({ data: { id, accepted: true } });
});

mcpRouter.post('/commands/:id/fail', requireAgent, async (request: AgentRequest, response) => {
  const parsed = failSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }
  const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
  if (!id) return response.status(400).json({ error: 'Missing command id' });

  const { data: command, error: commandError } = await supabaseAdmin
    .from('commands')
    .select('id,agent_id,status')
    .eq('id', id)
    .maybeSingle();
  if (commandError) return response.status(500).json({ error: commandError.message });
  if (!command) return response.status(404).json({ error: 'Command not found' });
  if (command.agent_id !== request.agentId) return response.status(403).json({ error: 'Command does not belong to agent' });

  const current = asStatus(command.status);
  if (!canTransition(current, 'failed')) {
    return response.status(409).json({ error: `Invalid status transition ${current} -> failed` });
  }

  const { error: updateError } = await supabaseAdmin
    .from('commands')
    .update({
      status: 'failed',
      error_message: parsed.data.errorMessage,
      completed_at: new Date().toISOString()
    })
    .eq('id', id);
  if (updateError) return response.status(500).json({ error: updateError.message });

  await createEvent({
    eventType: 'command.failed',
    commandId: id,
    agentId: request.agentId,
    level: 'error',
    payload: { errorMessage: parsed.data.errorMessage }
  });

  realtimeHub.publish(id, {
    commandId: id,
    status: 'failed',
    eventType: 'command.failed',
    timestamp: new Date().toISOString()
  });

  return response.json({ data: { id, status: 'failed' } });
});
