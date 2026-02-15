import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(4000),
  FRONTEND_ORIGIN: z.string().default('http://localhost:3000'),
  BACKEND_BASE_URL: z.string().default('http://localhost:4000'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional()
});

const parsed = configSchema.parse(process.env);
const supabaseAdminKey = parsed.SUPABASE_SECRET_KEY ?? parsed.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseAdminKey) {
  throw new Error('Set SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) in backend env');
}

const supabaseAuthKey = parsed.SUPABASE_PUBLISHABLE_KEY ?? parsed.SUPABASE_ANON_KEY;
if (!supabaseAuthKey) {
  throw new Error('Set SUPABASE_PUBLISHABLE_KEY (or legacy SUPABASE_ANON_KEY) in backend env');
}

export const config = {
  ...parsed,
  SUPABASE_ADMIN_KEY: supabaseAdminKey,
  SUPABASE_AUTH_KEY: supabaseAuthKey
};
