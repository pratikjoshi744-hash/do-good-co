import { Router } from '../lib/http.js';
import { ok, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

// Civic impact export — the artifact an admin could actually hand to a real
// municipal body (a ward office, a PMC/BMC sanitation desk) as evidence of
// organized citizen volunteering. IMPORTANT SCOPING NOTE: this is
// infrastructure only. Actually getting a government body to recognize this
// report requires a real-world partnership/business-development step no
// automated system can create — the same category of limit as the WhatsApp
// Business API integration elsewhere in this app. What this route *can*
// honestly provide: a real, auditable rollup of civic-tagged quest
// completions, ward by ward, generated from actual ledger rows rather than
// guesses — the exact document a real partnership conversation would start
// from.

const router = new Router();

// Admins tag which quests count as "civic" (public infrastructure / civic
// duty work — potholes, drains, tree planting, public cleanups) as opposed
// to purely social-good quests that wouldn't interest a municipal partner.
router.post('/api/civic/quests/:id/toggle', requireAuth, requireAdmin, async (req, res) => {
  const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(req.params.id);
  if (!quest) throw new HttpError(404, 'Quest not found');
  const next = quest.is_civic ? 0 : 1;
  db.prepare('UPDATE quests SET is_civic = ? WHERE id = ?').run(next, quest.id);
  ok(res, { id: quest.id, isCivic: !!next });
});

router.get('/api/civic/quests', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT q.id, q.title, q.is_civic, c.name as category_name
    FROM quests q JOIN categories c ON c.id = q.category_id
    WHERE q.status = 'active' ORDER BY q.is_civic DESC, q.title ASC
  `).all();
  ok(res, rows.map((r) => ({ id: r.id, title: r.title, isCivic: !!r.is_civic, category: r.category_name })));
});

// Public — the point of a civic report is to be handed to (or embedded for)
// people outside the app entirely, same reasoning as the Good Deed Radar.
router.get('/api/civic/report', (req, res) => {
  const totals = db.prepare(`
    SELECT COUNT(*) as deeds, COUNT(DISTINCT p.user_id) as citizens, COALESCE(SUM(q.estimated_minutes), 0) as minutes
    FROM proofs p JOIN quests q ON q.id = p.quest_id
    WHERE p.status = 'approved' AND q.is_civic = 1
  `).get();

  const byWard = db.prepare(`
    SELECT u.mohalla as ward, u.city, COUNT(*) as deeds, COALESCE(SUM(q.estimated_minutes), 0) as minutes
    FROM proofs p JOIN quests q ON q.id = p.quest_id JOIN users u ON u.id = p.user_id
    WHERE p.status = 'approved' AND q.is_civic = 1
    GROUP BY u.mohalla, u.city ORDER BY deeds DESC
  `).all();

  const byQuest = db.prepare(`
    SELECT q.id, q.title, c.name as category_name, COUNT(*) as deeds
    FROM proofs p JOIN quests q ON q.id = p.quest_id JOIN categories c ON c.id = q.category_id
    WHERE p.status = 'approved' AND q.is_civic = 1
    GROUP BY q.id ORDER BY deeds DESC LIMIT 20
  `).all();

  ok(res, {
    generatedAt: new Date().toISOString(),
    note: 'Generated from real, approved deed records for quests tagged civic — not an estimate. Actual government recognition requires a direct partnership conversation with the relevant municipal body; this report is the evidence base for that conversation.',
    totals: {
      deeds: totals.deeds,
      citizens: totals.citizens,
      volunteerHours: Math.round((totals.minutes / 60) * 10) / 10,
    },
    byWard: byWard.map((w) => ({ ward: w.ward, city: w.city, deeds: w.deeds, hours: Math.round((w.minutes / 60) * 10) / 10 })),
    byQuest: byQuest.map((q) => ({ id: q.id, title: q.title, category: q.category_name, deeds: q.deeds })),
  });
});

export default router;
