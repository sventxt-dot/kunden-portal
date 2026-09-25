// Verifiziert das Supabase-Session-JWT (HS256 mit dem JWT-Secret der Instanz).
// Kein Netzwerkaufruf nötig; abgelaufene oder manipulierte Tokens werden abgelehnt.
import jwt from 'jsonwebtoken';
import { config } from './config.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Nicht angemeldet.' });

  try {
    const payload = jwt.verify(token, config.supabaseJwtSecret, {
      algorithms: ['HS256'],
      audience: 'authenticated',
    });
    if (!payload.sub) throw new Error('sub fehlt');
    req.user = { id: payload.sub, email: payload.email || null, token };
    return next();
  } catch {
    return res.status(401).json({ error: 'Sitzung ungültig oder abgelaufen. Bitte neu anmelden.' });
  }
}
