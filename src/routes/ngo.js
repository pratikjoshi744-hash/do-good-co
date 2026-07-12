import { randomUUID } from 'node:crypto';
import { Router } from '../lib/http.js';
import { ok, readJsonBody, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { serializeNgo, serializeQuest, serializeProof } from '../lib/serialize.js';
import { requireAuth } from '../middleware/auth.js';
import { awardForApprovedProof } from '../lib/gamification.js';

const router = new Router();

function requireNgoAdmin(req, res, next) {
  if (!req.user?.is_ngo_admin || !req.user?.ngo_id) {
    throw new HttpError(403, 'NGO admin access required.');
  }
  next();
}

function getNgoOr404(ngoId) {
  const ngo = db.prepare('SELECT * FROM ngos WHERE id = ?').get(ngoId);
  if (!ngo) throw new HttpError(404, 'NGO not found');
  return ngo;
}

// Public NGO directory — any signed-in citizen can see it (used by the
// Wallet's "Donate Cash Directly" section), unlike the routes below which
// are gated to that NGO's own admin.
router.get('/api/ngo/public', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM ngos ORDER BY is_premium DESC, name ASC').all();
  ok(res, rows.map(serializeNgo));
});

router.get('/api/ngo/organization', requireAuth, requireNgoAdmin, (req, res) => {
  ok(res, serializeNgo(getNgoOr404(req.user.ngo_id)));
});

// Dashboard: how the deck's "NGO Premium Listings" + "NGO Verified Badges" revenue
// stream shows up operationally — featured quest reach, verification workload, impact.
router.get('/api/ngo/dashboard', requireAuth, requireNgoAdmin, (req, res) => {
  const ngo = getNgoOr404(req.user.ngo_id);
  const ngoId = ngo.id;

  const questStats = db.prepare(`SELECT COUNT(*) as total, SUM(ngo_featured) as featured FROM quests WHERE ngo_id = ? AND status = 'active'`).get(ngoId);
  const impactStats = db.prepare(`
    SELECT COUNT(*) as deeds_completed, COALESCE(SUM(q.xp_reward),0) as xp_driven, COUNT(DISTINCT p.user_id) as unique_participants
    FROM proofs p JOIN quests q ON q.id = p.quest_id
    WHERE q.ngo_id = ? AND p.status = 'approved'
  `).get(ngoId);
  const pendingVerification = db.prepare(`
    SELECT COUNT(*) as c FROM proofs p JOIN quests q ON q.id = p.quest_id
    WHERE q.ngo_id = ? AND p.status = 'approved' AND p.ngo_verified = 0
  `).get(ngoId);
  const pendingApproval = db.prepare(`
    SELECT COUNT(*) as c FROM proofs p JOIN quests q ON q.id = p.quest_id
    WHERE q.ngo_id = ? AND p.status = 'pending'
  `).get(ngoId);

  ok(res, {
    ngo: serializeNgo(ngo),
    totalQuests: questStats.total,
    featuredQuests: questStats.featured || 0,
    deedsCompleted: impactStats.deeds_completed,
    xpDriven: impactStats.xp_driven,
    uniqueParticipants: impactStats.unique_participants,
    pendingVerification: pendingVerification.c,
    pendingApproval: pendingApproval.c,
  });
});

// Proofs on this NGO's quests still awaiting the NGO's first-pass approval —
// these never got the simulated community-upvote fast-track (see the
// needsRealReview gate in routes/quests.js), so an NGO admin here is the
// only path that credits XP/coins to the citizen. This is the "proper
// verification, not just a simple screen" review loop for NGO-backed deeds.
router.get('/api/ngo/proofs/pending', requireAuth, requireNgoAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, u.name as user_name, u.avatar as user_avatar, u.trust_score as user_trust_score,
           q.title as quest_title, q.xp_reward as quest_xp, q.coin_reward as quest_coin
    FROM proofs p JOIN quests q ON q.id = p.quest_id JOIN users u ON u.id = p.user_id
    WHERE q.ngo_id = ? AND p.status = 'pending'
    ORDER BY p.submitted_at ASC
  `).all(req.user.ngo_id);
  ok(res, rows.map((p) => ({
    ...serializeProof(p),
    quest: { id: p.quest_id, title: p.quest_title, xpReward: p.quest_xp, coinReward: p.quest_coin },
    user: { id: p.user_id, name: p.user_name, avatar: p.user_avatar, trustScore: p.user_trust_score },
  })));
});

router.post('/api/ngo/proofs/:proofId/approve', requireAuth, requireNgoAdmin, async (req, res) => {
  const proof = db.prepare(`
    SELECT p.* FROM proofs p JOIN quests q ON q.id = p.quest_id WHERE p.id = ? AND q.ngo_id = ?
  `).get(req.params.proofId, req.user.ngo_id);
  if (!proof) throw new HttpError(404, 'Proof not found for this NGO');
  if (proof.status !== 'pending') throw new HttpError(400, 'This proof was already reviewed');

  const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(proof.quest_id);
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(proof.user_id);

  db.prepare(`
    UPDATE proofs SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ?, ngo_verified = 1 WHERE id = ?
  `).run(`NGO: ${req.user.name}`, proof.id);
  db.prepare('UPDATE users SET trust_score = MIN(100, trust_score + 3) WHERE id = ?').run(owner.id);
  const newBadges = awardForApprovedProof(owner, quest, proof.id);

  ok(res, {
    proof: serializeProof(db.prepare('SELECT * FROM proofs WHERE id = ?').get(proof.id)),
    newBadges: newBadges.map((b) => ({ id: b.id, name: b.name, icon: b.icon })),
  });
});

router.post('/api/ngo/proofs/:proofId/reject', requireAuth, requireNgoAdmin, async (req, res) => {
  const proof = db.prepare(`
    SELECT p.* FROM proofs p JOIN quests q ON q.id = p.quest_id WHERE p.id = ? AND q.ngo_id = ?
  `).get(req.params.proofId, req.user.ngo_id);
  if (!proof) throw new HttpError(404, 'Proof not found for this NGO');
  if (proof.status !== 'pending') throw new HttpError(400, 'This proof was already reviewed');
  const body = await readJsonBody(req);

  db.prepare(`
    UPDATE proofs SET status = 'rejected', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?
  `).run(`NGO: ${req.user.name}`, proof.id);
  db.prepare('UPDATE users SET trust_score = MAX(0, trust_score - 5) WHERE id = ?').run(proof.user_id);

  ok(res, { proof: serializeProof(db.prepare('SELECT * FROM proofs WHERE id = ?').get(proof.id)), reason: body.reason ?? null });
});

router.get('/api/ngo/quests', requireAuth, requireNgoAdmin, (req, res) => {
  const rows = db.prepare(`SELECT * FROM quests WHERE ngo_id = ? ORDER BY created_at DESC`).all(req.user.ngo_id);
  const data = rows.map((q) => {
    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(q.category_id);
    const stats = db.prepare(`SELECT COUNT(*) as completions FROM proofs WHERE quest_id = ? AND status = 'approved'`).get(q.id);
    return { ...serializeQuest(q, category), completions: stats.completions };
  });
  ok(res, data);
});

// Toggle "premium listing" featuring for one of this NGO's quests — bumps it to
// the top of the citizen quest feed (see ORDER BY ngo_featured in routes/quests.js).
router.post('/api/ngo/quests/:questId/feature', requireAuth, requireNgoAdmin, async (req, res) => {
  const quest = db.prepare('SELECT * FROM quests WHERE id = ? AND ngo_id = ?').get(req.params.questId, req.user.ngo_id);
  if (!quest) throw new HttpError(404, 'Quest not found for this NGO');

  const next = quest.ngo_featured ? 0 : 1;
  db.prepare('UPDATE quests SET ngo_featured = ? WHERE id = ?').run(next, quest.id);
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(quest.category_id);
  const updated = db.prepare('SELECT * FROM quests WHERE id = ?').get(quest.id);
  ok(res, serializeQuest(updated, category));
});

// Proofs from this NGO's quests awaiting an on-the-ground NGO verification badge
router.get('/api/ngo/proofs', requireAuth, requireNgoAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, u.name as user_name, u.avatar as user_avatar, q.title as quest_title
    FROM proofs p JOIN quests q ON q.id = p.quest_id JOIN users u ON u.id = p.user_id
    WHERE q.ngo_id = ? AND p.status = 'approved'
    ORDER BY p.ngo_verified ASC, p.submitted_at DESC
    LIMIT 50
  `).all(req.user.ngo_id);
  ok(res, rows.map((p) => ({
    ...serializeProof(p),
    quest: { id: p.quest_id, title: p.quest_title },
    user: { id: p.user_id, name: p.user_name, avatar: p.user_avatar },
  })));
});

router.post('/api/ngo/proofs/:proofId/verify', requireAuth, requireNgoAdmin, async (req, res) => {
  const proof = db.prepare(`
    SELECT p.* FROM proofs p JOIN quests q ON q.id = p.quest_id WHERE p.id = ? AND q.ngo_id = ?
  `).get(req.params.proofId, req.user.ngo_id);
  if (!proof) throw new HttpError(404, 'Proof not found for this NGO');

  db.prepare('UPDATE proofs SET ngo_verified = 1 WHERE id = ?').run(proof.id);
  db.prepare('UPDATE users SET trust_score = MIN(100, trust_score + 3) WHERE id = ?').run(proof.user_id);

  ok(res, serializeProof(db.prepare('SELECT * FROM proofs WHERE id = ?').get(proof.id)));
});

export default router;
