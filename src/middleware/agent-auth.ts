import type { NextFunction, Request, Response } from 'express';
import { sha256 } from '../lib/crypto.js';
import { supabaseAdmin } from '../lib/supabase.js';

export type AgentRequest = Request & {
  agentId?: string;
  externalId?: string;
};

export async function requireAgent(request: AgentRequest, response: Response, next: NextFunction) {
  const authHeader = request.header('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return response.status(401).json({ error: 'Missing agent token' });
  }

  const token = authHeader.slice('Bearer '.length);
  const tokenHash = sha256(token);

  const { data, error } = await supabaseAdmin
    .from('agents')
    .select('id, external_id')
    .eq('token_hash', tokenHash)
    .eq('token_active', true)
    .maybeSingle();

  if (error || !data) {
    return response.status(401).json({ error: 'Invalid agent token' });
  }

  request.agentId = data.id;
  request.externalId = data.external_id ?? undefined;
  return next();
}
