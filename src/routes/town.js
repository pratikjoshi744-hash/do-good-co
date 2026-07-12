import { randomUUID } from 'node:crypto';
import { Router } from '../lib/http.js';
import { ok, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { serializeUser, serializeCategory } from '../lib/serialize.js';
import { requireAuth } from '../middleware/auth.js';

const router = new Router();

// Deed-count thresholds that bump a building up a level (0 = empty lot, 5 = maxed
// out). Deliberately low so a new player sees their first building appear fast.
const BUILDING_THRESHOLDS = [0, 1, 3, 6, 10, 16];

function buildingLevelFor(deedsCompleted) {
  let level = 0;
  for (let i = 0; i < BUILDING_THRESHOLDS.length; i++) {
    if (deedsCompleted >= BUILDING_THRESHOLDS[i]) level = i;
  }
  return level;
}

// Shared by both "my town" and "visit a friend's town" — a town is fully
// derived from a user's approved proofs, so viewing someone else's is just
// running the same aggregation for their id instead of the caller's.
function buildTown(user) {
  const categories = db.prepare('SELECT * FROM categories ORDER BY slug').all();
  const counts = db.prepare(`
    SELECT q.category_id as category_id, COUNT(*) as n
    FROM proofs p JOIN quests q ON q.id = p.quest_id
    WHERE p.user_id = ? AND p.status = 'approved'
    GROUP BY q.category_id
  `).all(user.id);
  const countByCategory = Object.fromEntries(counts.map((c) => [c.category_id, c.n]));

  const buildings = categories.map((cat) => {
    const deedsCompleted = countByCategory[cat.id] || 0;
    return {
      category: serializeCategory(cat),
      deedsCompleted,
      buildingLevel: buildingLevelFor(deedsCompleted),
      maxLevel: BUILDING_THRESHOLDS.length - 1,
      nextThreshold: BUILDING_THRESHOLDS[Math.min(buildingLevelFor(deedsCompleted) + 1, BUILDING_THRESHOLDS.length - 1)],
    };
  });

  const totalDeeds = counts.reduce((sum, c) => sum + c.n, 0);

  return { user: serializeUser(user), totalDeeds, buildings };
}

// "Your Town" — an isometric base that grows as you complete quests. Each
// category becomes a building; the building's level is driven by how many
// approved deeds the player has logged in that category. Purely derived from
// existing quest/proof data, no new tables needed.
router.get('/api/town/me', requireAuth, (req, res) => {
  ok(res, buildTown(req.user));
});

// GET /api/town/:userId — read-only visit to someone else's town, so
// checking out a friend's base becomes part of the social loop.
router.get('/api/town/:userId', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!user) throw new HttpError(404, 'User not found');
  ok(res, { ...buildTown(user), isOwnTown: user.id === req.user.id });
});

// Clash-of-Clans-style clearable obstacles — a couple of decorative
// rocks/bushes dotted around the island that regrow daily and pay out a
// small coin bonus the first time each day they're cleared. Same
// once-per-day pattern as the Karma Spin in routes/wallet.js.
const OBSTACLE_REWARDS = [5, 8, 10, 12, 15];

function isSameCalendarDay(isoA, isoB) {
  if (!isoA || !isoB) return false;
  return isoA.slice(0, 10) === isoB.slice(0, 10);
}

router.get('/api/town/obstacle/status', requireAuth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  ok(res, { available: !isSameCalendarDay(req.user.last_obstacle_clear_at, today) });
});

router.post('/api/town/obstacle/clear', requireAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  if (isSameCalendarDay(req.user.last_obstacle_clear_at, today)) {
    throw new HttpError(400, "You've already cleared today's obstacles. Check back tomorrow!");
  }
  const reward = OBSTACLE_REWARDS[Math.floor(Math.random() * OBSTACLE_REWARDS.length)];
  db.prepare(`UPDATE users SET karma_coins = karma_coins + ?, last_obstacle_clear_at = datetime('now') WHERE id = ?`).run(reward, req.user.id);
  db.prepare(`
    INSERT INTO wallet_transactions (id, user_id, direction, amount, description, status)
    VALUES (?, ?, 'earn', ?, 'Cleared a town obstacle', 'completed')
  `).run(randomUUID(), req.user.id, reward);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  ok(res, { reward, karmaCoins: updated.karma_coins });
});

export default router;
