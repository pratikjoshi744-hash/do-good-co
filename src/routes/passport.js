import { Router } from '../lib/http.js';
import { ok, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { serializeBadge } from '../lib/serialize.js';

const router = new Router();

// The Impact Passport — a public, shareable, verified credential built
// entirely from proofs that actually cleared human-or-witness review (never
// pending/rejected/flagged ones). This is the artifact a student attaches
// to a college application, or a professional puts on LinkedIn: real,
// checkable evidence of volunteering, not a self-reported claim. Public
// (no auth) on purpose — an admissions officer or recruiter viewing it has
// no Do Good Co. account.
router.get('/api/passport/:userId', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!user) throw new HttpError(404, 'No passport found for this user');

  const totals = db.prepare(`
    SELECT COUNT(*) as deeds, COALESCE(SUM(q.estimated_minutes), 0) as minutes, COALESCE(SUM(q.xp_reward), 0) as xp
    FROM proofs p JOIN quests q ON q.id = p.quest_id
    WHERE p.user_id = ? AND p.status = 'approved'
  `).get(user.id);

  const witnessed = db.prepare(`
    SELECT COUNT(*) as c FROM proof_witnesses w JOIN proofs p ON p.id = w.proof_id
    WHERE p.user_id = ? AND w.status = 'confirmed'
  `).get(user.id);

  const categoryBreakdown = db.prepare(`
    SELECT c.name as category, c.icon as icon, COUNT(*) as n
    FROM proofs p JOIN quests q ON q.id = p.quest_id JOIN categories c ON c.id = q.category_id
    WHERE p.user_id = ? AND p.status = 'approved'
    GROUP BY c.id ORDER BY n DESC
  `).all(user.id);

  const ngoPartners = db.prepare(`
    SELECT DISTINCT n.name, n.logo, COUNT(p.id) as n
    FROM proofs p JOIN quests q ON q.id = p.quest_id JOIN ngos n ON n.id = q.ngo_id
    WHERE p.user_id = ? AND p.status = 'approved'
    GROUP BY n.id ORDER BY n DESC
  `).all(user.id);

  const badges = db.prepare(`
    SELECT b.*, ub.earned_at FROM user_badges ub JOIN badges b ON b.id = ub.badge_id
    WHERE ub.user_id = ? ORDER BY ub.earned_at ASC
  `).all(user.id);

  const institution = user.institution_id ? db.prepare('SELECT name, type FROM institutions WHERE id = ?').get(user.institution_id) : null;

  const highlights = db.prepare(`
    SELECT p.caption, p.submitted_at, q.title as quest_title
    FROM proofs p JOIN quests q ON q.id = p.quest_id
    WHERE p.user_id = ? AND p.status = 'approved'
    ORDER BY p.submitted_at DESC LIMIT 6
  `).all(user.id);

  ok(res, {
    name: user.name,
    avatar: user.avatar,
    city: user.city,
    mohalla: user.mohalla,
    memberSince: user.created_at,
    trustScore: user.trust_score,
    institution: institution ? { name: institution.name, type: institution.type } : null,
    totals: {
      deedsVerified: totals.deeds,
      hoursVerified: Math.round((totals.minutes / 60) * 10) / 10,
      xpEarned: totals.xp,
      timesWitnessed: witnessed.c,
    },
    categoryBreakdown: categoryBreakdown.map((c) => ({ category: c.category, icon: c.icon, count: c.n })),
    ngoPartners: ngoPartners.map((n) => ({ name: n.name, logo: n.logo, deeds: n.n })),
    badges: badges.map((b) => serializeBadge(b, b.earned_at)),
    highlights: highlights.map((h) => ({ caption: h.caption, questTitle: h.quest_title, date: h.submitted_at })),
    generatedAt: new Date().toISOString(),
  });
});

export default router;
