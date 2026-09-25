// DELETE /api/results/:id – Owner löscht eigenes Ergebnis (RLS: results_delete_owner).
// Läuft über den Server, damit zusätzlich der Flowise-Chatverlauf entfernt werden kann
// (dafür ist der serverseitige API-Key nötig). Lesen/Teilen macht der Browser direkt
// über Supabase – RLS filtert.
import { Router } from 'express';
import { config } from '../lib/config.js';
import { supabaseForUser } from '../lib/supabase.js';
import { deleteChat } from '../lib/flowise.js';

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Ungültige Ergebnis-ID.' });

    const sb = supabaseForUser(req.user.token);
    const { data: row, error } = await sb.from('results').select('id, owner_id, flow_type, output_data').eq('id', id).maybeSingle();
    if (error) throw Object.assign(new Error('Ergebnis konnte nicht geladen werden.'), { status: 500, detail: error.message });
    if (!row) return res.status(404).json({ error: 'Ergebnis nicht gefunden.' });
    if (row.owner_id !== req.user.id) return res.status(403).json({ error: 'Nur der Besitzer kann ein Ergebnis löschen.' });

    const { data: deleted, error: delError } = await sb.from('results').delete().eq('id', id).select('id');
    if (delError) throw Object.assign(new Error('Löschen fehlgeschlagen.'), { status: 500, detail: delError.message });
    if (!deleted?.length) return res.status(403).json({ error: 'Löschen nicht erlaubt.' });

    const flow = config.flows[row.flow_type];
    if (flow && row.output_data?.chat_id) await deleteChat(flow, row.output_data.chat_id);

    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

export default router;
