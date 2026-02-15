import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { canTransition } from '../lib/lifecycle.js';
import { sha256 } from '../lib/crypto.js';
import { realtimeHub } from '../lib/realtime-hub.js';
import { supabaseAdmin } from '../lib/supabase.js';
import type { CommandStatus } from '../types.js';
import { createEvent } from '../lib/events.js';
import { requireRole, requireUser, type AuthenticatedRequest } from '../middleware/user-auth.js';

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

function asCommandStatus(value: string): CommandStatus {
  return value as CommandStatus;
}

export const operatorRouter = Router();

operatorRouter.use(requireUser);

operatorRouter.get('/agents', async (_request, response) => {
  const { data, error } = await supabaseAdmin
    .from('agents')
    .select('id,name,external_id,status,capabilities,last_heartbeat_at,created_at,updated_at')
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
