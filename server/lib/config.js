// Zentrale Konfiguration aus Environment-Variablen (Coolify-Env in Produktion).
// Alles hier bleibt serverseitig – nur `publicConfig()` geht an den Browser.

const env = (key, fallback) => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};

const required = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_JWT_SECRET',
  'FLOWISE_BASE_URL',
  'FLOWISE_CHATFLOW_KUECHE',
  'FLOWISE_CHATFLOW_OPERATIV',
];

export function assertConfig() {
  const missing = required.filter((k) => !env(k));
  if (missing.length) {
    console.error(`[config] Fehlende Environment-Variablen: ${missing.join(', ')}`);
    process.exit(1);
  }
  for (const k of ['FLOWISE_API_KEY_KUECHE', 'FLOWISE_API_KEY_OPERATIV']) {
    if (!env(k)) console.warn(`[config] Warnung: ${k} ist leer – Flowise-Aufruf ohne API-Key.`);
  }
}

// Basis-URL normalisieren: mit oder ohne "/api/v1/prediction/" am Ende, ohne Slash.
const flowiseBaseUrl = env('FLOWISE_BASE_URL', '')
  .replace(/\/api\/v1\/prediction\/?$/, '')
  .replace(/\/+$/, '');

export const config = {
  port: Number(env('PORT', 3000)),
  supabaseUrl: env('SUPABASE_URL', '').replace(/\/+$/, ''),
  supabaseAnonKey: env('SUPABASE_ANON_KEY', ''),
  supabaseJwtSecret: env('SUPABASE_JWT_SECRET', ''),
  flowiseBaseUrl,
  flowiseTimeoutMs: Number(env('FLOWISE_TIMEOUT_MS', 5 * 60 * 1000)),
  // Die Flow-Typen entsprechen dem CHECK-Constraint auf results.flow_type.
  flows: {
    kueche: {
      type: 'kueche',
      name: 'Küchen-Assistent',
      description: 'Einkaufslisten & Menüplanung',
      icon: '🍽️',
      color: '#f5eaec',
      chatflowId: env('FLOWISE_CHATFLOW_KUECHE', ''),
      apiKey: env('FLOWISE_API_KEY_KUECHE', ''),
    },
    operativ: {
      type: 'operativ',
      name: 'Operativer Assistent',
      description: 'Event-PDFs lesen & Packliste füllen',
      icon: '📋',
      color: '#eaf0f5',
      chatflowId: env('FLOWISE_CHATFLOW_OPERATIV', ''),
      apiKey: env('FLOWISE_API_KEY_OPERATIV', ''),
    },
  },
};

// Was der Browser sehen darf: Supabase-URL + anon key (öffentlich per Design)
// und die Anzeige-Infos der Flows. Keine Chatflow-IDs, keine Flowise-URL, keine Keys.
export function publicConfig() {
  return {
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
    flows: Object.values(config.flows).map(({ type, name, description, icon, color }) => ({
      type, name, description, icon, color,
    })),
  };
}
