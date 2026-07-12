import { randomUUID } from 'node:crypto';
import { Router } from '../lib/http.js';
import { ok, created, readJsonBody, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';

const router = new Router();

// Three more once-a-day arcade games alongside Karma Match — Snake, Arrow
// Rush, and Ludo Race. Same shape as Karma Match/Daily Spin: play as much
// as you want, but only the first completed round of the day pays out
// coins, so the games stay fun without turning into an infinite coin
// faucet. Each game gets its own last-played column so playing one doesn't
// use up your turn on another.

function isSameCalendarDay(isoA, isoB) {
  if (!isoA || !isoB) return false;
  return isoA.slice(0, 10) === isoB.slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function awardCoins(userId, amount, description) {
  db.prepare(`UPDATE users SET karma_coins = karma_coins + ? WHERE id = ?`).run(amount, userId);
  db.prepare(`
    INSERT INTO wallet_transactions (id, user_id, direction, amount, description, status)
    VALUES (?, ?, 'earn', ?, ?, 'completed')
  `).run(randomUUID(), userId, amount, description);
}

router.get('/api/arcade/status', requireAuth, (req, res) => {
  const today = todayIso();
  ok(res, {
    snake: { available: !isSameCalendarDay(req.user.last_snake_at, today), lastPlayedAt: req.user.last_snake_at },
    arrow: { available: !isSameCalendarDay(req.user.last_arrow_at, today), lastPlayedAt: req.user.last_arrow_at },
    ludo: { available: !isSameCalendarDay(req.user.last_ludo_at, today), lastPlayedAt: req.user.last_ludo_at },
  });
});

// --- Snake ------------------------------------------------------------------
// score = food eaten. Uncapped play, capped reward: 10 base + 3/food, 80 max.
router.post('/api/arcade/snake/complete', requireAuth, async (req, res) => {
  const today = todayIso();
  if (isSameCalendarDay(req.user.last_snake_at, today)) {
    throw new HttpError(400, "You've already claimed today's Snake reward. Come back tomorrow!");
  }
  const body = await readJsonBody(req);
  const score = Number(body.score);
  if (!Number.isFinite(score) || score < 0 || score > 500) throw new HttpError(400, 'Invalid score');

  const reward = Math.min(80, Math.round(10 + score * 3));
  db.prepare(`UPDATE users SET last_snake_at = datetime('now') WHERE id = ?`).run(req.user.id);
  awardCoins(req.user.id, reward, `Snake — ${score} food`);
  const updated = db.prepare('SELECT karma_coins FROM users WHERE id = ?').get(req.user.id);
  created(res, { reward, karmaCoins: updated.karma_coins });
});

// --- Arrow Rush ---------------------------------------------------------------
// score = correct presses in a row before a miss/timeout. 10 base + 2/hit, 70 max.
router.post('/api/arcade/arrow/complete', requireAuth, async (req, res) => {
  const today = todayIso();
  if (isSameCalendarDay(req.user.last_arrow_at, today)) {
    throw new HttpError(400, "You've already claimed today's Arrow Rush reward. Come back tomorrow!");
  }
  const body = await readJsonBody(req);
  const score = Number(body.score);
  if (!Number.isFinite(score) || score < 0 || score > 500) throw new HttpError(400, 'Invalid score');

  const reward = Math.min(70, Math.round(10 + score * 2));
  db.prepare(`UPDATE users SET last_arrow_at = datetime('now') WHERE id = ?`).run(req.user.id);
  awardCoins(req.user.id, reward, `Arrow Rush — ${score} in a row`);
  const updated = db.prepare('SELECT karma_coins FROM users WHERE id = ?').get(req.user.id);
  created(res, { reward, karmaCoins: updated.karma_coins });
});

// --- Ludo Race ----------------------------------------------------------------
// position = 1..4 finish placement against 3 bots. Reward scales with placement.
const LUDO_REWARDS = { 1: 60, 2: 35, 3: 20, 4: 10 };
router.post('/api/arcade/ludo/complete', requireAuth, async (req, res) => {
  const today = todayIso();
  if (isSameCalendarDay(req.user.last_ludo_at, today)) {
    throw new HttpError(400, "You've already claimed today's Ludo Race reward. Come back tomorrow!");
  }
  const body = await readJsonBody(req);
  const position = Number(body.position);
  if (![1, 2, 3, 4].includes(position)) throw new HttpError(400, 'Invalid finishing position');

  const reward = LUDO_REWARDS[position];
  db.prepare(`UPDATE users SET last_ludo_at = datetime('now') WHERE id = ?`).run(req.user.id);
  awardCoins(req.user.id, reward, `Ludo Race — finished #${position}`);
  const updated = db.prepare('SELECT karma_coins FROM users WHERE id = ?').get(req.user.id);
  created(res, { reward, karmaCoins: updated.karma_coins });
});

export default router;
