import { randomUUID } from 'node:crypto';
import { Router } from '../lib/http.js';
import { ok, created, readJsonBody, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';

const router = new Router();

// "Karma Match" - a once-a-day memory-flip mini-game (see client/src/pages/
// KarmaMatch.js). Distinct from the Daily Spin: that's a passive claim, this
// is an actual few-seconds-of-play activity, so it earns real coins scaled
// by how well you played rather than a flat random amount.
const MIN_PAIRS = 6;
const BEST_REWARD = 40;
const WORST_REWARD = 12;
// Fewest possible moves to clear the board is MIN_PAIRS (one lucky flip per
// pair); anything at or below that gets the max reward, anything double
// that or worse gets the floor, linear in between.
const PAR_MOVES = MIN_PAIRS;
const WORST_MOVES = MIN_PAIRS * 3;

function isSameCalendarDay(isoA, isoB) {
  if (!isoA || !isoB) return false;
  return isoA.slice(0, 10) === isoB.slice(0, 10);
}

function rewardForMoves(moves) {
  const clamped = Math.min(Math.max(moves, PAR_MOVES), WORST_MOVES);
  const t = (clamped - PAR_MOVES) / (WORST_MOVES - PAR_MOVES); // 0 (great) -> 1 (bad)
  return Math.round(BEST_REWARD - t * (BEST_REWARD - WORST_REWARD));
}

router.get('/api/karma-match/status', requireAuth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const available = !isSameCalendarDay(req.user.last_match_at, today);
  ok(res, { available, lastMatchAt: req.user.last_match_at, pairs: MIN_PAIRS });
});

router.post('/api/karma-match/complete', requireAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  if (isSameCalendarDay(req.user.last_match_at, today)) {
    throw new HttpError(400, "You've already played today's Karma Match. Come back tomorrow!");
  }

  const body = await readJsonBody(req);
  const moves = Number(body.moves);
  if (!Number.isFinite(moves) || moves < MIN_PAIRS || moves > 200) {
    throw new HttpError(400, 'Invalid move count');
  }

  const reward = rewardForMoves(moves);
  db.prepare(`UPDATE users SET karma_coins = karma_coins + ?, last_match_at = datetime('now') WHERE id = ?`).run(reward, req.user.id);
  db.prepare(`
    INSERT INTO wallet_transactions (id, user_id, direction, amount, description, status)
    VALUES (?, ?, 'earn', ?, 'Karma Match mini-game', 'completed')
  `).run(randomUUID(), req.user.id, reward);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  created(res, { reward, karmaCoins: updated.karma_coins, perfect: moves <= PAR_MOVES });
});

export default router;
