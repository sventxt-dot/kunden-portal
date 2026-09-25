// Supabase-Client im Namen des eingeloggten Users: anon key + dessen JWT.
// Damit greifen alle RLS-Policies genau wie bei einem Aufruf aus dem Browser.
// Der service_role key wird bewusst nirgends verwendet.
import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

export function supabaseForUser(token) {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
