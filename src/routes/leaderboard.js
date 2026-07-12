import { Router } from '../lib/http.js';
import { ok } from '../lib/http.js';
import { db } from '../db/connection.js';
import { serializeUser } from '../lib/serialize.js';
import { requireAuth } from '../middleware/auth.js';

const router = new Router();

// GET /api/leaderboard?scope=mohalla|city&mohalla=Kothrud
router.get('/api/leaderboard', requireAuth, (req, res) => {
  const { scope = 'city' } = req.query;
  const mohalla = req.query.mohalla || req.user.mohalla;

  let rows;
  if (scope === 'mohalla') {
    rows = db.prepare('SELECT * FROM users WHERE mohalla = ? ORDER BY xp DESC LIMIT 50').all(mohalla);
  } else {
    rows = db.prepare('SELECT * FROM users ORDER BY xp DESC LIMIT 50').all();
  }

  const ranked = rows.map((u, i) => ({ rank: i + 1, ...serializeUser(u) }));
  const myRank = ranked.find((r) => r.id === req.user.id) ?? null;

  ok(res, { scope, mohalla: scope === 'mohalla' ? mohalla : null, leaderboard: ranked, myRank });
});

// GET /api/leaderboard/mohallas?period=week - list mohallas with aggregate XP,
// for the "compete with your colony" view. period=week powers the Mohalla
// Territory Wars panel (resets weekly by definition — only counts deeds
// approved in the last 7 days) instead of the all-time total.
router.get('/api/leaderboard/mohallas', (req, res) => {
  const period = req.query.period === 'week' ? 'week' : 'all';

  let rows;
  if (period === 'week') {
    rows = db.prepare(`
      SELECT u.mohalla as mohalla, COUNT(DISTINCT u.id) as members,
             COALESCE(SUM(q.xp_reward), 0) as total_xp,
             COUNT(p.id) as deeds_this_week
      FROM users u
      LEFT JOIN proofs p ON p.user_id = u.id AND p.status = 'approved' AND p.submitted_at >= datetime('now', '-7 days')
      LEFT JOIN quests q ON q.id = p.quest_id
      GROUP BY u.mohalla ORDER BY total_xp DESC
    `).all();
  } else {
    rows = db.prepare(`
      SELECT mohalla, COUNT(*) as members, SUM(xp) as total_xp, AVG(xp) as avg_xp
      FROM users GROUP BY mohalla ORDER BY total_xp DESC
    `).all();
  }

  ok(res, rows.map((r, i) => ({
    rank: i + 1,
    mohalla: r.mohalla,
    members: r.members,
    totalXp: r.total_xp,
    avgXp: r.avg_xp != null ? Math.round(r.avg_xp) : null,
    deedsThisWeek: r.deeds_this_week ?? null,
  })));
});

export default router;
