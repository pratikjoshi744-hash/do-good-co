import { randomUUID } from 'node:crypto';
import { Router } from '../lib/http.js';
import { ok, created, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { serializeCampaign, serializeQuest } from '../lib/serialize.js';
import { requireAuth } from '../middleware/auth.js';
import { getSessionUser } from '../middleware/auth.js';

const router = new Router();

function questsFor(campaignId) {
  return db.prepare(`
    SELECT q.* FROM campaign_quests cq JOIN quests q ON q.id = cq.quest_id
    WHERE cq.campaign_id = ? ORDER BY cq.sort_order ASC
  `).all(campaignId);
}

function completedQuestIdsFor(userId, questIds) {
  if (!userId || !questIds.length) return new Set();
  const placeholders = questIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT DISTINCT quest_id FROM proofs WHERE user_id = ? AND status = 'approved' AND quest_id IN (${placeholders})
  `).all(userId, ...questIds);
  return new Set(rows.map((r) => r.quest_id));
}

function buildCampaignDetail(campaign, userId) {
  const quests = questsFor(campaign.id);
  const completedIds = completedQuestIdsFor(userId, quests.map((q) => q.id));
  const claimed = userId ? !!db.prepare('SELECT 1 FROM campaign_claims WHERE campaign_id = ? AND user_id = ?').get(campaign.id, userId) : false;
  return {
    ...serializeCampaign(campaign),
    quests: quests.map((q) => ({ ...serializeQuest(q, db.prepare('SELECT * FROM categories WHERE id = ?').get(q.category_id)), completed: completedIds.has(q.id) })),
    progress: { done: completedIds.size, total: quests.length },
    isComplete: quests.length > 0 && completedIds.size === quests.length,
    claimed,
  };
}

router.get('/api/campaigns', (req, res) => {
  const user = getSessionUser(req);
  const rows = db.prepare(`SELECT * FROM campaigns WHERE status = 'active' ORDER BY created_at DESC`).all();
  ok(res, rows.map((c) => buildCampaignDetail(c, user?.id)));
});

router.get('/api/campaigns/:id', (req, res) => {
  const user = getSessionUser(req);
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) throw new HttpError(404, 'Campaign not found');
  ok(res, buildCampaignDetail(campaign, user?.id));
});

router.post('/api/campaigns/:id/claim', requireAuth, (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) throw new HttpError(404, 'Campaign not found');

  const already = db.prepare('SELECT 1 FROM campaign_claims WHERE campaign_id = ? AND user_id = ?').get(campaign.id, req.user.id);
  if (already) throw new HttpError(400, "You've already claimed this campaign's bonus.");

  const quests = questsFor(campaign.id);
  const completedIds = completedQuestIdsFor(req.user.id, quests.map((q) => q.id));
  if (quests.length === 0 || completedIds.size < quests.length) {
    throw new HttpError(400, 'Complete every quest in this campaign before claiming the bonus.');
  }

  db.prepare('INSERT INTO campaign_claims (id, campaign_id, user_id) VALUES (?, ?, ?)').run(randomUUID(), campaign.id, req.user.id);
  db.prepare('UPDATE users SET xp = xp + ?, karma_coins = karma_coins + ? WHERE id = ?').run(campaign.bonus_xp, campaign.bonus_coins, req.user.id);
  db.prepare(`
    INSERT INTO wallet_transactions (id, user_id, direction, amount, description, status)
    VALUES (?, ?, 'earn', ?, ?, 'completed')
  `).run(randomUUID(), req.user.id, campaign.bonus_coins, `Campaign bonus — ${campaign.title}`);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  created(res, { bonusXp: campaign.bonus_xp, bonusCoins: campaign.bonus_coins, userSnapshot: { xp: updated.xp, karmaCoins: updated.karma_coins } });
});

export default router;
