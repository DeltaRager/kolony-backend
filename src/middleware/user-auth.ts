import type { NextFunction, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { supabaseAuthClient } from '../lib/supabase.js';
import type { AppRole } from '../types.js';

export type AuthenticatedRequest = Request & {
  userId?: string;
  role?: AppRole;
};

export async function requireUser(request: AuthenticatedRequest, response: Response, next: NextFunction) {
  const authHeader = request.header('authorization');
  const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;
  const queryToken =
    typeof request.query.access_token === 'string' ? request.query.access_token : null;
  const token = headerToken ?? queryToken;
  if (!token) return response.status(401).json({ error: 'Missing bearer token' });

  const { data, error } = await supabaseAuthClient.auth.getUser(token);
  if (error || !data.user) {
    return response.status(401).json({ error: 'Invalid user token' });
  }

  request.userId = data.user.id;
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', data.user.id)
    .maybeSingle();

  if (profileError) {
    return response.status(500).json({ error: 'Failed to resolve user role from profiles' });
  }

  request.role = (profile?.role as AppRole | undefined) ?? 'viewer';
  return next();
}

export function requireRole(minimumRole: AppRole) {
  const weight: Record<AppRole, number> = {
    viewer: 1,
    operator: 2,
    admin: 3
  };

  return (request: AuthenticatedRequest, response: Response, next: NextFunction) => {
    const current = request.role ?? 'viewer';
    if (weight[current] < weight[minimumRole]) {
      return response.status(403).json({ error: 'Insufficient role' });
    }
    return next();
  };
}
