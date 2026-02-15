import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

export const supabaseAdmin = createClient(config.SUPABASE_URL, config.SUPABASE_ADMIN_KEY, {
  auth: { persistSession: false }
});

export const supabaseAuthClient = createClient(config.SUPABASE_URL, config.SUPABASE_AUTH_KEY, {
  auth: { persistSession: false }
});
