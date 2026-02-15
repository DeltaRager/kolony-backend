import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { canTransition } from '../lib/lifecycle.js';
import { sha256 } from '../lib/crypto.js';
import { realtimeHub } from '../lib/realtime-hub.js';
import { supabaseAdmin } from '../lib/supabase.js';
import type { CommandStatus } from '../types.js';
import { createEvent } from '../lib/events.js';
import { requireRole, requireUser, type AuthenticatedRequest } from '../middleware/user-auth.js';

const CONNECT_INTENT_TTL_MINUTES = 10;

const createCommandSchema = z.object({
  agentId: z.string().uuid(),
  instruction: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
  priority: z.number().int().min(1).max(10).optional()
});

const createAgentSchema = z.object({
  name: z.string().min(1),
  externalId: z.string().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  token: z.string().min(16).optional()
});

const createConnectIntentSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional()
});

const activeTaskParamsSchema = z.object({
  id: z.string().uuid()
});

const taskLogsParamsSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid()
});

const taskLogsQuerySchema = z.object({
  cursor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200)
});

const listAgentTasksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

const boardStatusSchema = z.enum(['backlog', 'ready', 'in_progress', 'done']);

const boardTaskParamsSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid()
});

const boardTaskPatchSchema = z.object({
  boardStatus: boardStatusSchema,
  boardOrder: z.coerce.number().optional()
});

const codeSessionParamsSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid()
});

const codeSessionCreateSchema = z.object({
  reopen: z.boolean().optional().default(true)
});

const codeSessionInputSchema = z.object({
  input: z.string().min(1)
});

const codeSessionEventsQuerySchema = z.object({
  cursor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200)
});

const workspaceFileQuerySchema = z.object({
  path: z.string().min(1)
});

const agentParamsSchema = z.object({
  id: z.string().uuid()
});

function asCommandStatus(value: string): CommandStatus {
  return value as CommandStatus;
}

export const operatorRouter = Router();

operatorRouter.use(requireUser);

operatorRouter.get('/agents', async (_request, response) => {
  const { data, error } = await supabaseAdmin
    .from('agents')
    .select('id,name,external_id,status,capabilities,metadata,last_heartbeat_at,created_at,updated_at')
    .order('created_at', { ascending: false });

  if (error) return response.status(500).json({ error: error.message });
  return response.json({ data });
});

operatorRouter.post('/agents', requireRole('operator'), async (request: AuthenticatedRequest, response) => {
  const parsed = createAgentSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  const token = parsed.data.token ?? randomBytes(24).toString('hex');
  const tokenHash = sha256(token);
  const tokenHint = `${token.slice(0, 4)}...${token.slice(-4)}`;

  const { data, error } = await supabaseAdmin
    .from('agents')
    .insert({
      name: parsed.data.name,
      external_id: parsed.data.externalId ?? null,
      capabilities: parsed.data.capabilities ?? [],
      status: 'offline',
      token_hash: tokenHash,
      token_hint: tokenHint,
      token_active: true,
      created_by: request.userId
    })
    .select('id,name,external_id,status,capabilities,token_hint,created_at')
    .single();

  if (error || !data) {
    return response.status(500).json({ error: error?.message ?? 'Failed to create agent' });
  }

  await createEvent({
    eventType: 'agent.created',
    agentId: data.id,
    payload: { createdBy: request.userId, externalId: data.external_id }
  });

  return response.status(201).json({
    data,
    credentials: { token }
  });
});

operatorRouter.post('/agents/connect-intents', requireRole('operator'), async (request: AuthenticatedRequest, response) => {
  const parsed = createConnectIntentSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  const displayName = parsed.data.displayName ?? 'Pending Agent';
  const setupCode = randomBytes(6).toString('hex');
  const setupCodeHash = sha256(setupCode);
  const expiresAt = new Date(Date.now() + CONNECT_INTENT_TTL_MINUTES * 60 * 1000).toISOString();

  const { data: agent, error: agentError } = await supabaseAdmin
    .from('agents')
    .insert({
      name: displayName,
      status: 'offline',
      capabilities: [],
      metadata: {
        purpose: '',
        tools: [],
        provisional: true
      },
      created_by: request.userId
    })
    .select('id,name')
    .single();

  if (agentError || !agent) {
    return response.status(500).json({ error: agentError?.message ?? 'Failed to create provisional agent' });
  }

  const { data: intent, error: intentError } = await supabaseAdmin
    .from('agent_connect_intents')
    .insert({
      agent_id: agent.id,
      setup_code_hash: setupCodeHash,
      expires_at: expiresAt,
      created_by: request.userId
    })
    .select('id,agent_id,expires_at,created_at')
    .single();

  if (intentError || !intent) {
    return response.status(500).json({ error: intentError?.message ?? 'Failed to create connect intent' });
  }

  await createEvent({
    eventType: 'agent.connect_intent_created',
    agentId: agent.id,
    payload: { intentId: intent.id, expiresAt: intent.expires_at }
  });

  return response.status(201).json({
    data: {
      intentId: intent.id,
      agentId: intent.agent_id,
      setupCode,
      setupUrl: `${config.BACKEND_BASE_URL}/api/v1/mcp/connect/exchange`,
      expiresAt: intent.expires_at,
      createdAt: intent.created_at
    }
  });
});

operatorRouter.delete('/agents/:id', requireRole('operator'), async (request: AuthenticatedRequest, response) => {
  const parsed = agentParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid agent id', details: parsed.error.flatten() });
  }

  const agentId = parsed.data.id;
  const { data: agent, error: agentError } = await supabaseAdmin
    .from('agents')
    .select('id,name,external_id')
    .eq('id', agentId)
    .maybeSingle();

  if (agentError) return response.status(500).json({ error: agentError.message });
  if (!agent) return response.status(404).json({ error: 'Agent not found' });

  const { count, error: countError } = await supabaseAdmin
    .from('commands')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId);
  if (countError) return response.status(500).json({ error: countError.message });
  if ((count ?? 0) > 0) {
    return response.status(409).json({
      error: 'Cannot delete agent with command history. Keep the agent or archive manually.'
    });
  }

  await createEvent({
    eventType: 'agent.deleted',
    agentId,
    payload: {
      deletedBy: request.userId,
      name: agent.name,
      externalId: agent.external_id
    }
  });

  const { error: deleteError } = await supabaseAdmin.from('agents').delete().eq('id', agentId);
  if (deleteError) return response.status(500).json({ error: deleteError.message });

  return response.json({ data: { id: agentId, deleted: true } });
});

operatorRouter.get('/agents/:id/active-task', async (request, response) => {
  const parsed = activeTaskParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid agent id', details: parsed.error.flatten() });
  }

  const { data, error } = await supabaseAdmin
    .from('agent_tasks')
    .select('id,agent_id,external_task_id,title,status,board_status,board_order,error_message,started_at,completed_at,updated_at,created_at')
    .eq('agent_id', parsed.data.id)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return response.status(500).json({ error: error.message });
  return response.json({ data: data ?? null });
});

operatorRouter.get('/agents/:id/tasks', async (request, response) => {
  const paramsParsed = activeTaskParamsSchema.safeParse(request.params);
  const queryParsed = listAgentTasksQuerySchema.safeParse(request.query);
  if (!paramsParsed.success || !queryParsed.success) {
    return response.status(400).json({
      error: 'Invalid request',
      details: {
        params: paramsParsed.success ? undefined : paramsParsed.error.flatten(),
        query: queryParsed.success ? undefined : queryParsed.error.flatten()
      }
    });
  }

  const { id } = paramsParsed.data;
  const { limit } = queryParsed.data;
  const { data, error } = await supabaseAdmin
    .from('agent_tasks')
    .select('id,agent_id,external_task_id,title,status,board_status,board_order,error_message,started_at,completed_at,updated_at,created_at')
    .eq('agent_id', id)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) return response.status(500).json({ error: error.message });
  return response.json({ data });
});

operatorRouter.get('/agents/:id/tasks/:taskId/logs', async (request, response) => {
  const paramsParsed = taskLogsParamsSchema.safeParse(request.params);
  const queryParsed = taskLogsQuerySchema.safeParse(request.query);
  if (!paramsParsed.success || !queryParsed.success) {
    return response.status(400).json({
      error: 'Invalid request',
      details: {
        params: paramsParsed.success ? undefined : paramsParsed.error.flatten(),
        query: queryParsed.success ? undefined : queryParsed.error.flatten()
      }
    });
  }

  const { id: agentId, taskId } = paramsParsed.data;
  const { cursor, limit } = queryParsed.data;

  const { data: task, error: taskError } = await supabaseAdmin
    .from('agent_tasks')
    .select('id,agent_id')
    .eq('id', taskId)
    .maybeSingle();
  if (taskError) return response.status(500).json({ error: taskError.message });
  if (!task || task.agent_id !== agentId) {
    return response.status(404).json({ error: 'Task not found for agent' });
  }

  let query = supabaseAdmin
    .from('agent_task_logs')
    .select('id,task_id,seq,ts,level,line,created_at')
    .eq('task_id', taskId)
    .order('seq', { ascending: true })
    .limit(limit);

  if (typeof cursor === 'number') {
    query = query.gt('seq', cursor);
  }

  const { data, error } = await query;
  if (error) return response.status(500).json({ error: error.message });

  const last = data.length > 0 ? data[data.length - 1] : null;
  return response.json({
    data: {
      items: data,
      nextCursor: data.length === limit && last ? last.seq : null
    }
  });
});

operatorRouter.get('/agents/:id/tasks/:taskId/result', async (request, response) => {
  const paramsParsed = taskLogsParamsSchema.safeParse(request.params);
  if (!paramsParsed.success) {
    return response.status(400).json({ error: 'Invalid request', details: paramsParsed.error.flatten() });
  }

  const { id: agentId, taskId } = paramsParsed.data;
  const { data: task, error: taskError } = await supabaseAdmin
    .from('agent_tasks')
    .select('id,agent_id,external_task_id')
    .eq('id', taskId)
    .maybeSingle();
  if (taskError) return response.status(500).json({ error: taskError.message });
  if (!task || task.agent_id !== agentId) {
    return response.status(404).json({ error: 'Task not found for agent' });
  }

  const asRaw = task.external_task_id.trim();
  const commandIdCandidate = asRaw.startsWith('command-') ? asRaw.slice('command-'.length) : asRaw;
  const parsedCommandId = z.string().uuid().safeParse(commandIdCandidate);
  if (!parsedCommandId.success) {
    return response.json({ data: null });
  }

  const { data: rows, error } = await supabaseAdmin
    .from('command_results')
    .select('id,chunk_index,is_final,output,created_at')
    .eq('command_id', parsedCommandId.data)
    .order('chunk_index', { ascending: true });

  if (error) return response.status(500).json({ error: error.message });
  if (!rows || rows.length === 0) return response.json({ data: null });

  const content = rows.map((row) => row.output).join('\n');
  const isFinal = rows.some((row) => row.is_final);
  return response.json({
    data: {
      commandId: parsedCommandId.data,
      content,
      isFinal,
      chunkCount: rows.length,
      updatedAt: rows[rows.length - 1]?.created_at ?? null
    }
  });
});

operatorRouter.get('/agents/:id/board', async (request, response) => {
  const parsed = activeTaskParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid agent id', details: parsed.error.flatten() });
  }

  const { data, error } = await supabaseAdmin
    .from('agent_tasks')
    .select('id,agent_id,external_task_id,title,status,board_status,board_order,error_message,started_at,completed_at,updated_at,created_at')
    .eq('agent_id', parsed.data.id)
    .order('board_status', { ascending: true })
    .order('board_order', { ascending: true })
    .order('updated_at', { ascending: false });

  if (error) return response.status(500).json({ error: error.message });
  return response.json({ data });
});

operatorRouter.patch('/agents/:id/tasks/:taskId/board-status', requireRole('operator'), async (request: AuthenticatedRequest, response) => {
  const paramsParsed = boardTaskParamsSchema.safeParse(request.params);
  const bodyParsed = boardTaskPatchSchema.safeParse(request.body);
  if (!paramsParsed.success || !bodyParsed.success) {
    return response.status(400).json({
      error: 'Invalid payload',
      details: {
        params: paramsParsed.success ? undefined : paramsParsed.error.flatten(),
        body: bodyParsed.success ? undefined : bodyParsed.error.flatten()
      }
    });
  }

  const { id: agentId, taskId } = paramsParsed.data;
  const { boardStatus, boardOrder } = bodyParsed.data;

  const { data: task, error: taskError } = await supabaseAdmin
    .from('agent_tasks')
    .select('id,agent_id')
    .eq('id', taskId)
    .maybeSingle();
  if (taskError) return response.status(500).json({ error: taskError.message });
  if (!task || task.agent_id !== agentId) return response.status(404).json({ error: 'Task not found for agent' });

  const patch = {
    board_status: boardStatus,
    board_order: typeof boardOrder === 'number' ? boardOrder : Date.now(),
    board_updated_at: new Date().toISOString()
  };
  const { data, error } = await supabaseAdmin
    .from('agent_tasks')
    .update(patch)
    .eq('id', taskId)
    .select('id,agent_id,external_task_id,title,status,board_status,board_order,error_message,started_at,completed_at,updated_at,created_at')
    .single();
  if (error) return response.status(500).json({ error: error.message });

  await createEvent({
    eventType: 'agent.board.updated',
    agentId,
    payload: { taskId, boardStatus, boardOrder: patch.board_order, updatedBy: request.userId }
  });

  realtimeHub.publish(`agent:${agentId}`, {
    commandId: taskId,
    eventType: 'agent.board.updated',
    timestamp: new Date().toISOString()
  });

  return response.json({ data });
});

operatorRouter.post('/agents/:id/code/sessions', requireRole('operator'), async (request: AuthenticatedRequest, response) => {
  const paramsParsed = activeTaskParamsSchema.safeParse(request.params);
  const bodyParsed = codeSessionCreateSchema.safeParse(request.body ?? {});
  if (!paramsParsed.success || !bodyParsed.success) {
    return response.status(400).json({
      error: 'Invalid payload',
      details: {
        params: paramsParsed.success ? undefined : paramsParsed.error.flatten(),
        body: bodyParsed.success ? undefined : bodyParsed.error.flatten()
      }
    });
  }

  const { id: agentId } = paramsParsed.data;
  if (bodyParsed.data.reopen) {
    const { data: existing, error: existingError } = await supabaseAdmin
      .from('code_sessions')
      .select('id,agent_id,status,started_at,closed_at,created_at,updated_at')
      .eq('agent_id', agentId)
      .in('status', ['active', 'idle'])
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingError) return response.status(500).json({ error: existingError.message });
    if (existing) return response.json({ data: existing });
  }

  const { data, error } = await supabaseAdmin
    .from('code_sessions')
    .insert({
      agent_id: agentId,
      status: 'active',
      created_by: request.userId
    })
    .select('id,agent_id,status,started_at,closed_at,created_at,updated_at')
    .single();
  if (error) return response.status(500).json({ error: error.message });

  await createEvent({
    eventType: 'agent.code.session.started',
    agentId,
    payload: { sessionId: data.id, createdBy: request.userId }
  });

  return response.status(201).json({ data });
});

operatorRouter.post('/agents/:id/code/sessions/:sessionId/input', requireRole('operator'), async (request: AuthenticatedRequest, response) => {
  const paramsParsed = codeSessionParamsSchema.safeParse(request.params);
  const bodyParsed = codeSessionInputSchema.safeParse(request.body);
  if (!paramsParsed.success || !bodyParsed.success) {
    return response.status(400).json({
      error: 'Invalid payload',
      details: {
        params: paramsParsed.success ? undefined : paramsParsed.error.flatten(),
        body: bodyParsed.success ? undefined : bodyParsed.error.flatten()
      }
    });
  }

  const { id: agentId, sessionId } = paramsParsed.data;
  const input = bodyParsed.data.input.trim();
  const { data: session, error: sessionError } = await supabaseAdmin
    .from('code_sessions')
    .select('id,agent_id,status')
    .eq('id', sessionId)
    .maybeSingle();
  if (sessionError) return response.status(500).json({ error: sessionError.message });
  if (!session || session.agent_id !== agentId) return response.status(404).json({ error: 'Session not found for agent' });
  if (session.status === 'closed') return response.status(409).json({ error: 'Session is closed' });

  const { data: latest, error: latestError } = await supabaseAdmin
    .from('code_session_events')
    .select('seq')
    .eq('session_id', sessionId)
    .order('seq', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) return response.status(500).json({ error: latestError.message });
  const nextSeq = (typeof latest?.seq === 'number' ? latest.seq : 0) + 1;

  const payload = { text: input, by: request.userId };
  const { error: insertError } = await supabaseAdmin
    .from('code_session_events')
    .insert({
      session_id: sessionId,
      seq: nextSeq,
      direction: 'input',
      payload
    });
  if (insertError) return response.status(500).json({ error: insertError.message });

  await createEvent({
    eventType: 'agent.code.session.input',
    agentId,
    payload: { sessionId, seq: nextSeq, by: request.userId }
  });

  realtimeHub.publish(`code-session:${sessionId}`, {
    commandId: sessionId,
    eventType: 'agent.code.session.input',
    timestamp: new Date().toISOString(),
    data: { seq: nextSeq, direction: 'input', payload }
  });

  return response.status(202).json({ data: { accepted: true, seq: nextSeq } });
});

operatorRouter.get('/agents/:id/code/sessions/active', async (request, response) => {
  const paramsParsed = activeTaskParamsSchema.safeParse(request.params);
  if (!paramsParsed.success) {
    return response.status(400).json({ error: 'Invalid agent id', details: paramsParsed.error.flatten() });
  }

  const { data, error } = await supabaseAdmin
    .from('code_sessions')
    .select('id,agent_id,status,started_at,closed_at,created_at,updated_at')
    .eq('agent_id', paramsParsed.data.id)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return response.status(500).json({ error: error.message });
  return response.json({ data: data ?? null });
});

operatorRouter.get('/agents/:id/code/sessions/:sessionId/events', async (request, response) => {
  const paramsParsed = codeSessionParamsSchema.safeParse(request.params);
  const queryParsed = codeSessionEventsQuerySchema.safeParse(request.query);
  if (!paramsParsed.success || !queryParsed.success) {
    return response.status(400).json({
      error: 'Invalid query',
      details: {
        params: paramsParsed.success ? undefined : paramsParsed.error.flatten(),
        query: queryParsed.success ? undefined : queryParsed.error.flatten()
      }
    });
  }

  const { id: agentId, sessionId } = paramsParsed.data;
  const { cursor, limit } = queryParsed.data;
  const { data: session, error: sessionError } = await supabaseAdmin
    .from('code_sessions')
    .select('id,agent_id')
    .eq('id', sessionId)
    .maybeSingle();
  if (sessionError) return response.status(500).json({ error: sessionError.message });
  if (!session || session.agent_id !== agentId) return response.status(404).json({ error: 'Session not found for agent' });

  let query = supabaseAdmin
    .from('code_session_events')
    .select('id,session_id,seq,direction,payload,created_at')
    .eq('session_id', sessionId)
    .order('seq', { ascending: true })
    .limit(limit);
  if (typeof cursor === 'number') {
    query = query.gt('seq', cursor);
  }
  const { data, error } = await query;
  if (error) return response.status(500).json({ error: error.message });

  const last = data.length > 0 ? data[data.length - 1] : null;
  return response.json({
    data: {
      items: data,
      nextCursor: data.length === limit && last ? last.seq : null
    }
  });
});

operatorRouter.get('/agents/:id/code/sessions/:sessionId/stream', (request, response) => {
  const paramsParsed = codeSessionParamsSchema.safeParse(request.params);
  if (!paramsParsed.success) {
    return response.status(400).json({ error: 'Invalid session parameters', details: paramsParsed.error.flatten() });
  }

  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();

  response.write(`event: ready\ndata: ${JSON.stringify({ sessionId: paramsParsed.data.sessionId })}\n\n`);
  const unsubscribe = realtimeHub.subscribe(`code-session:${paramsParsed.data.sessionId}`, response);
  request.on('close', () => {
    unsubscribe();
    response.end();
  });
});

operatorRouter.get('/agents/:id/workspace/tree', async (request, response) => {
  const paramsParsed = activeTaskParamsSchema.safeParse(request.params);
  if (!paramsParsed.success) {
    return response.status(400).json({ error: 'Invalid agent id', details: paramsParsed.error.flatten() });
  }

  const { data, error } = await supabaseAdmin
    .from('agent_workspace_snapshots')
    .select('id,agent_id,snapshot_version,tree_json,created_at')
    .eq('agent_id', paramsParsed.data.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return response.status(500).json({ error: error.message });
  return response.json({ data: data ?? null });
});

operatorRouter.get('/agents/:id/workspace/file', async (request, response) => {
  const paramsParsed = activeTaskParamsSchema.safeParse(request.params);
  const queryParsed = workspaceFileQuerySchema.safeParse(request.query);
  if (!paramsParsed.success || !queryParsed.success) {
    return response.status(400).json({
      error: 'Invalid query',
      details: {
        params: paramsParsed.success ? undefined : paramsParsed.error.flatten(),
        query: queryParsed.success ? undefined : queryParsed.error.flatten()
      }
    });
  }

  const { data: snapshot, error: snapshotError } = await supabaseAdmin
    .from('agent_workspace_snapshots')
    .select('id,snapshot_version,created_at')
    .eq('agent_id', paramsParsed.data.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (snapshotError) return response.status(500).json({ error: snapshotError.message });
  if (!snapshot) return response.json({ data: null });

  const { data: file, error: fileError } = await supabaseAdmin
    .from('agent_workspace_files')
    .select('path,content,content_hash,size,language,updated_at')
    .eq('snapshot_id', snapshot.id)
    .eq('path', queryParsed.data.path)
    .maybeSingle();
  if (fileError) return response.status(500).json({ error: fileError.message });

  return response.json({
    data: file
      ? {
          ...file,
          snapshotVersion: snapshot.snapshot_version,
          snapshotCreatedAt: snapshot.created_at
        }
      : null
  });
});

operatorRouter.post('/commands', requireRole('operator'), async (request: AuthenticatedRequest, response) => {
  const parsed = createCommandSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  const payload = parsed.data;
  const { data, error } = await supabaseAdmin
    .from('commands')
    .insert({
      agent_id: payload.agentId,
      instruction: payload.instruction,
      payload: payload.payload ?? {},
      priority: payload.priority ?? 5,
      requested_by: request.userId,
      status: 'queued'
    })
    .select('id,status,created_at')
    .single();

  if (error || !data) return response.status(500).json({ error: error?.message ?? 'Failed to create command' });

  await createEvent({
    eventType: 'command.created',
    commandId: data.id,
    agentId: payload.agentId,
    payload: { requestedBy: request.userId }
  });

  realtimeHub.publish(data.id, {
    commandId: data.id,
    status: data.status,
    eventType: 'command.created',
    timestamp: new Date().toISOString()
  });

  return response.status(201).json({ data });
});

operatorRouter.get('/commands/:id', async (request, response) => {
  const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
  if (!id) return response.status(400).json({ error: 'Missing command id' });
  const { data, error } = await supabaseAdmin
    .from('commands')
    .select('id,agent_id,instruction,payload,status,priority,requested_by,started_at,completed_at,error_message,created_at,updated_at')
    .eq('id', id)
    .maybeSingle();

  if (error) return response.status(500).json({ error: error.message });
  if (!data) return response.status(404).json({ error: 'Command not found' });
  return response.json({ data });
});

operatorRouter.get('/commands/:id/results', async (request, response) => {
  const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
  if (!id) return response.status(400).json({ error: 'Missing command id' });
  const { data, error } = await supabaseAdmin
    .from('command_results')
    .select('id,chunk_index,is_final,output,metadata,created_at')
    .eq('command_id', id)
    .order('chunk_index', { ascending: true });

  if (error) return response.status(500).json({ error: error.message });
  return response.json({ data });
});

operatorRouter.get('/events', async (request, response) => {
  const schema = z.object({
    agentId: z.string().uuid().optional(),
    commandId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50)
  });
  const parsed = schema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
  }
  let query = supabaseAdmin
    .from('events')
    .select('id,event_type,level,agent_id,command_id,payload,occurred_at,created_at')
    .order('occurred_at', { ascending: false })
    .limit(parsed.data.limit);

  if (parsed.data.agentId) query = query.eq('agent_id', parsed.data.agentId);
  if (parsed.data.commandId) query = query.eq('command_id', parsed.data.commandId);

  const { data, error } = await query;
  if (error) return response.status(500).json({ error: error.message });
  return response.json({ data });
});

operatorRouter.get('/commands/:id/stream', (request, response) => {
  const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
  if (!id) return response.status(400).json({ error: 'Missing command id' });
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();
  response.write(`event: ready\ndata: ${JSON.stringify({ commandId: id })}\n\n`);

  const unsubscribe = realtimeHub.subscribe(id, response);
  request.on('close', () => {
    unsubscribe();
    response.end();
  });
});

operatorRouter.post('/commands/:id/cancel', requireRole('operator'), async (request, response) => {
  const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
  if (!id) return response.status(400).json({ error: 'Missing command id' });
  const { data: current, error: fetchError } = await supabaseAdmin
    .from('commands')
    .select('id,agent_id,status')
    .eq('id', id)
    .maybeSingle();

  if (fetchError) return response.status(500).json({ error: fetchError.message });
  if (!current) return response.status(404).json({ error: 'Command not found' });
  if (!canTransition(asCommandStatus(current.status), 'cancelled')) {
    return response.status(409).json({ error: 'Invalid status transition' });
  }

  const { error } = await supabaseAdmin
    .from('commands')
    .update({ status: 'cancelled', completed_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return response.status(500).json({ error: error.message });

  await createEvent({
    eventType: 'command.cancelled',
    commandId: id,
    agentId: current.agent_id
  });

  realtimeHub.publish(id, {
    commandId: id,
    status: 'cancelled',
    eventType: 'command.cancelled',
    timestamp: new Date().toISOString()
  });

  return response.json({ data: { id, status: 'cancelled' } });
});
