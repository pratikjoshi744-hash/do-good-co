import { randomUUID } from 'node:crypto';
import { Router } from '../lib/http.js';
import { ok, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';

const router = new Router();

function serializeBoss(quest, extra = {}) {
  return {
    id: quest.id,
    title: quest.title,
    description: quest.description,
    icon: quest.icon,
    target: quest.target,
    current: quest.current,
    progressPct: Math.min(100, Math.round((quest.current / quest.target) * 100)),
    rewardCoins: quest.reward_coins,
    status: quest.status,
    endsAt: quest.ends_at,
    ...extra,
  };
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

// GET /api/boss-quest/active — the current city-wide raid, if any, plus
// whether the requesting user has joined and how much they've personally
// contributed. A "raid" everyone chips into together, not a solo quest.
router.get('/api/boss-quest/active', requireAuth, (req, res) => {
  const quest = db.prepare(`SELECT * FROM boss_quests WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`).get();
  if (!quest) return ok(res, null);

  const participantCount = db.prepare('SELECT COUNT(*) as c FROM boss_quest_participants WHERE boss_quest_id = ?').get(quest.id).c;
  const mine = db.prepare('SELECT * FROM boss_quest_participants WHERE boss_quest_id = ? AND user_id = ?').get(quest.id, req.user.id);
  const topContributors = db.prepare(`
    SELECT bp.contributions, u.name, u.avatar FROM boss_quest_participants bp
    JOIN users u ON u.id = bp.user_id
    WHERE bp.boss_quest_id = ? ORDER BY bp.contributions DESC LIMIT 5
  `).all(quest.id);

  ok(res, serializeBoss(quest, {
    participantCount,
    joined: !!mine,
    myContributions: mine?.contributions ?? 0,
    canContributeToday: !mine || mine.last_contributed_at !== todayDate(),
    topContributors: topContributors.map((c) => ({ name: c.name, avatar: c.avatar, contributions: c.contributions })),
  }));
});

// POST /api/boss-quest/:id/join
router.post('/api/boss-quest/:id/join', requireAuth, async (req, res) => {
  const quest = db.prepare('SELECT * FROM boss_quests WHERE id = ?').get(req.params.id);
  if (!quest) throw new HttpError(404, 'Boss quest not found');
  if (quest.status !== 'active') throw new HttpError(400, 'This raid has already ended.');

  const existing = db.prepare('SELECT * FROM boss_quest_participants WHERE boss_quest_id = ? AND user_id = ?').get(quest.id, req.user.id);
  if (!existing) {
    db.prepare('INSERT INTO boss_quest_participants (id, boss_quest_id, user_id) VALUES (?, ?, ?)').run(randomUUID(), quest.id, req.user.id);
  }
  ok(res, { joined: true });
});

// POST /api/boss-quest/:id/contribute — once per real day per participant,
// keeping this a steady community push rather than something one person
// could grind alone to finish overnight.
router.post('/api/boss-quest/:id/contribute', requireAuth, async (req, res) => {
  const quest = db.prepare('SELECT * FROM boss_quests WHERE id = ?').get(req.params.id);
  if (!quest) throw new HttpError(404, 'Boss quest not found');
  if (quest.status !== 'active') throw new HttpError(400, 'This raid has already ended.');

  const participant = db.prepare('SELECT * FROM boss_quest_participants WHERE boss_quest_id = ? AND user_id = ?').get(quest.id, req.user.id);
  if (!participant) throw new HttpError(400, 'Join the raid before contributing.');
  if (participant.last_contributed_at === todayDate()) throw new HttpError(400, "You've already contributed today — come back tomorrow!");

  db.prepare('UPDATE boss_quest_participants SET contributions = contributions + 1, last_contributed_at = ? WHERE id = ?').run(todayDate(), participant.id);
  const newCurrent = Math.min(quest.target, quest.current + 1);
  const justCompleted = newCurrent >= quest.target && quest.status === 'active';
  db.prepare('UPDATE boss_quests SET current = ? WHERE id = ?').run(newCurrent, quest.id);

  let rewardsGiven = 0;
  if (justCompleted) {
    db.prepare(`UPDATE boss_quests SET status = 'completed' WHERE id = ?`).run(quest.id);
    const participants = db.prepare('SELECT user_id FROM boss_quest_participants WHERE boss_quest_id = ?').all(quest.id);
    const insertTx = db.prepare(`INSERT INTO wallet_transactions (id, user_id, direction, amount, description, status) VALUES (?, ?, 'earn', ?, ?, 'completed')`);
    for (const p of participants) {
      db.prepare('UPDATE users SET karma_coins = karma_coins + ? WHERE id = ?').run(quest.reward_coins, p.user_id);
      insertTx.run(randomUUID(), p.user_id, quest.reward_coins, `Boss Quest defeated: "${quest.title}"`);
      rewardsGiven++;
    }
  }

  const updated = db.prepare('SELECT * FROM boss_quests WHERE id = ?').get(quest.id);
  ok(res, { quest: serializeBoss(updated), justCompleted, rewardsGiven });
});

export default router;
