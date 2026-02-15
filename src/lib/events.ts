import { supabaseAdmin } from './supabase.js';

type CreateEventInput = {
  eventType: string;
  level?: 'info' | 'warn' | 'error';
  agentId?: string | null;
  commandId?: string | null;
  payload?: Record<string, unknown>;
};

export async function createEvent({
  eventType,
  level = 'info',
  agentId = null,
  commandId = null,
  payload = {}
}: CreateEventInput): Promise<void> {
  const { error } = await supabaseAdmin.from('events').insert({
    event_type: eventType,
    level,
    agent_id: agentId,
    command_id: commandId,
    payload
  });

  if (error) {
    throw error;
  }
}
