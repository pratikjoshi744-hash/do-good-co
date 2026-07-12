import { Router } from '../lib/http.js';
import { ok, readJsonBody, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { serializeProof } from '../lib/serialize.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { awardForApprovedProof } from '../lib/gamification.js';

const router = new Router();

// Queue combines two independent trust signals that both land here for a
// human to resolve: proofs the community flagged after the fact (status =
// 'flagged'), and proofs our AI-style screen caught before they ever got
// the fast-track (status = 'pending' with an ai_flag_reason). NGO-featured
// quests also stay 'pending' with no ai_flag_reason since they route to the
// NGO's own queue (see routes/ngo.js) rather than the platform admin queue —
// excluded here so the two review paths don't double up on the same proof.
router.get('/api/moderation/queue', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, u.name as user_name, u.avatar as user_avatar, u.trust_score as user_trust_score,
           q.title as quest_title, q.xp_reward as quest_xp, q.coin_reward as quest_coin, q.ngo_featured as quest_ngo_featured
    FROM proofs p
    JOIN users u ON u.id = p.user_id
    JOIN quests q ON q.id = p.quest_id
    WHERE p.status = 'flagged' OR (p.status = 'pending' AND p.ai_flag_reason IS NOT NULL)
    ORDER BY
      CASE WHEN p.ai_flag_reason IS NOT NULL THEN 0 ELSE 1 END,
      p.flag_count DESC, p.submitted_at ASC
  `).all();

  const flagsByProof = {};
  for (const row of rows) {
    flagsByProof[row.id] = db.prepare(`
      SELECT f.*, u.name as flagger_name FROM flags f JOIN users u ON u.id = f.user_id WHERE proof_id = ?
    `).all(row.id);
  }

  ok(res, rows.map((p) => ({
    ...serializeProof(p),
    quest: { id: p.quest_id, title: p.quest_title, xpReward: p.quest_xp, coinReward: p.quest_coin },
    user: { id: p.user_id, name: p.user_name, avatar: p.user_avatar, trustScore: p.user_trust_score },
    flags: flagsByProof[p.id].map((f) => ({ reason: f.reason, flaggedBy: f.flagger_name, createdAt: f.created_at })),
    queueReason: p.ai_flag_reason ? 'ai' : 'community',
  })));
});

router.get('/api/moderation/stats', requireAuth, requireAdmin, (req, res) => {
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM proofs WHERE status = 'flagged') as flagged,
      (SELECT COUNT(*) FROM proofs WHERE status = 'pending') as pending,
      (SELECT COUNT(*) FROM proofs WHERE status = 'pending' AND ai_flag_reason IS NOT NULL) as ai_flagged,
      (SELECT COUNT(*) FROM proofs WHERE status = 'approved') as approved,
      (SELECT COUNT(*) FROM proofs WHERE status = 'rejected') as rejected,
      (SELECT COUNT(*) FROM users) as total_users,
      (SELECT COUNT(*) FROM quests WHERE status = 'active') as active_quests
  `).get();
  const avgTrust = db.prepare('SELECT AVG(trust_score) as avg FROM users').get().avg;
  ok(res, {
    flaggedCount: stats.flagged,
    pendingCount: stats.pending,
    aiFlaggedCount: stats.ai_flagged,
    approvedCount: stats.approved,
    rejectedCount: stats.rejected,
    totalUsers: stats.total_users,
    activeQuests: stats.active_quests,
    avgTrustScore: Math.round(avgTrust),
  });
});

router.post('/api/moderation/:proofId/approve', requireAuth, requireAdmin, async (req, res) => {
  const proof = db.prepare('SELECT * FROM proofs WHERE id = ?').get(req.params.proofId);
  if (!proof) throw new HttpError(404, 'Proof not found');

  db.prepare(`UPDATE proofs SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?`)
    .run(req.user.name, proof.id);

  const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(proof.quest_id);
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(proof.user_id);
  // Moderator override restores trust in the reporting user rather than penalizing wrongly-flagged users
  db.prepare('UPDATE users SET trust_score = MIN(100, trust_score + 2) WHERE id = ?').run(owner.id);
  const newBadges = awardForApprovedProof(owner, quest, proof.id);

  ok(res, { proof: serializeProof(db.prepare('SELECT * FROM proofs WHERE id = ?').get(proof.id)), newBadges });
});

router.post('/api/moderation/:proofId/reject', requireAuth, requireAdmin, async (req, res) => {
  const proof = db.prepare('SELECT * FROM proofs WHERE id = ?').get(req.params.proofId);
  if (!proof) throw new HttpError(404, 'Proof not found');
  const body = await readJsonBody(req);

  db.prepare(`UPDATE proofs SET status = 'rejected', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?`)
    .run(req.user.name, proof.id);
  db.prepare('UPDATE users SET trust_score = MAX(0, trust_score - 8) WHERE id = ?').run(proof.user_id);

  ok(res, { proof: serializeProof(db.prepare('SELECT * FROM proofs WHERE id = ?').get(proof.id)), reason: body.reason ?? null });
});

export default router;
