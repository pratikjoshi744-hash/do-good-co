import { Router } from '../lib/http.js';
import { ok, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { serializeUser } from '../lib/serialize.js';
import { requireAuth } from '../middleware/auth.js';

const router = new Router();

function weeklyStatsFor(userId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(q.xp_reward), 0) as weekly_xp, COUNT(*) as deeds_this_week
    FROM proofs p JOIN quests q ON q.id = p.quest_id
    WHERE p.user_id = ? AND p.status = 'approved' AND p.submitted_at >= datetime('now', '-7 days')
  `).get(userId);
  return { weeklyXp: row.weekly_xp, deedsThisWeek: row.deeds_this_week };
}

// GET /api/rivals/:userId — head-to-head comparison for "Rival Mode": your
// stats vs a chosen rival's, including this week's momentum so it's not
// just a static all-time XP diff. Purely derived from existing data.
router.get('/api/rivals/:userId', requireAuth, (req, res) => {
  if (req.params.userId === req.user.id) throw new HttpError(400, "You can't rival yourself — pick someone else!");
  const rival = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!rival) throw new HttpError(404, 'User not found');

  const me = { ...serializeUser(req.user), ...weeklyStatsFor(req.user.id) };
  const them = { ...serializeUser(rival), ...weeklyStatsFor(rival.id) };
  const xpGap = me.xp - them.xp;

  ok(res, { me, rival: them, xpGap, leading: xpGap > 0 ? 'me' : xpGap < 0 ? 'rival' : 'tied' });
});

export default router;
