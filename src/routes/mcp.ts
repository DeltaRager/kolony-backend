import { Router } from 'express';
import { z } from 'zod';
import { createEvent } from '../lib/events.js';
import { canTransition } from '../lib/lifecycle.js';
import { realtimeHub } from '../lib/realtime-hub.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAgent, type AgentRequest } from '../middleware/agent-auth.js';
import type { AgentStatus, CommandStatus } from '../types.js';

const registerSchema = z.object({
  externalId: z.string().min(1),
  name: z.string().min(1),
  capabilities: z.array(z.string()).default([])
});

const heartbeatSchema = z.object({
  status: z.enum(['online', 'offline', 'busy', 'error']),
  metadata: z.record(z.unknown()).optional()
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

function asStatus(value: string): CommandStatus {
  return value as CommandStatus;
}

export const mcpRouter = Router();

mcpRouter.post('/agents/register', requireAgent, async (request: AgentRequest, response) => {
  const parsed = registerSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }
  const payload = parsed.data;

  const { data, error } = await supabaseAdmin
    .from('agents')
    .update({
      external_id: payload.externalId,
      name: payload.name,
      capabilities: payload.capabilities,
      status: 'online' satisfies AgentStatus,
      last_heartbeat_at: new Date().toISOString()
    })
    .eq('id', request.agentId)
    .select('id,name,status,external_id,capabilities,last_heartbeat_at')
    .single();

  if (error) return response.status(500).json({ error: error.message });

  await createEvent({
    eventType: 'agent.registered',
    agentId: request.agentId,
    payload: { externalId: payload.externalId }
  });

  return response.json({ data });
});

mcpRouter.post('/agents/heartbeat', requireAgent, async (request: AgentRequest, response) => {
  const parsed = heartbeatSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('agents')
    .update({
      status: parsed.data.status,
      metadata: parsed.data.metadata ?? {},
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
