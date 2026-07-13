import { Router } from '../lib/http.js';
import { ok, HttpError, readJsonBody } from '../lib/http.js';
import { db } from '../db/connection.js';
import { serializeUser, serializeBadge, serializeProof } from '../lib/serialize.js';
import { requireAuth } from '../middleware/auth.js';
import { isFollowing } from './social.js';

const router = new Router();

function buildProfile(user, viewerId) {
  const badgeRows = db.prepare(`
    SELECT b.*, ub.earned_at FROM user_badges ub JOIN badges b ON b.id = ub.badge_id
    WHERE ub.user_id = ? ORDER BY ub.earned_at DESC
  `).all(user.id);

  const allBadges = db.prepare('SELECT * FROM badges').all();
  const earnedIds = new Set(badgeRows.map((b) => b.id));

  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM proofs WHERE user_id = ? AND status = 'approved') as deeds_done,
      (SELECT COUNT(*) FROM proofs WHERE user_id = ? AND status = 'pending') as deeds_pending,
      (SELECT COUNT(*) FROM follows WHERE following_id = ?) as follower_count,
      (SELECT COUNT(*) FROM follows WHERE follower_id = ?) as following_count
  `).get(user.id, user.id, user.id, user.id);

  const recentProofs = db.prepare(`
    SELECT p.*, q.title as quest_title, q.xp_reward as quest_xp, q.coin_reward as quest_coin
    FROM proofs p JOIN quests q ON q.id = p.quest_id
    WHERE p.user_id = ? ORDER BY p.submitted_at DESC LIMIT 10
  `).all(user.id);

  // Instagram-style "posts" grid — every approved deed that carries a photo
  // or video, newest first. Deliberately separate from recentActivity
  // (which includes pending/flagged and has no media requirement) since the
  // grid is meant to read as a curated feed of real proof, not a status log.
  const postRows = db.prepare(`
    SELECT p.*, q.title as quest_title
    FROM proofs p JOIN quests q ON q.id = p.quest_id
    WHERE p.user_id = ? AND p.status = 'approved' AND p.media_data IS NOT NULL
    ORDER BY p.submitted_at DESC LIMIT 60
  `).all(user.id);

  // NGOs the user has done verified work for — derived from approved proofs
  // on quests tied to an NGO partner, deduped.
  const ngoRows = db.prepare(`
    SELECT DISTINCT n.id, n.name, n.logo, n.mission, COUNT(p.id) as deed_count
    FROM proofs p
    JOIN quests q ON q.id = p.quest_id
    JOIN ngos n ON n.id = q.ngo_id
    WHERE p.user_id = ? AND p.status = 'approved'
    GROUP BY n.id ORDER BY deed_count DESC
  `).all(user.id);

  return {
    user: serializeUser(user),
    isFollowing: viewerId ? isFollowing(viewerId, user.id) : false,
    isSelf: viewerId === user.id,
    stats: {
      deedsDone: stats.deeds_done,
      deedsPending: stats.deeds_pending,
      followerCount: stats.follower_count,
      followingCount: stats.following_count,
      postCount: postRows.length,
    },
    badges: {
      earned: badgeRows.map((b) => serializeBadge(b, b.earned_at)),
      locked: allBadges.filter((b) => !earnedIds.has(b.id)).map((b) => serializeBadge(b)),
    },
    posts: postRows.map((p) => ({
      ...serializeProof(p),
      quest: { id: p.quest_id, title: p.quest_title },
    })),
    ngosWorkedWith: ngoRows.map((n) => ({ id: n.id, name: n.name, logo: n.logo, mission: n.mission, deedCount: n.deed_count })),
    recentActivity: recentProofs.map((p) => ({
      ...serializeProof(p),
      quest: { id: p.quest_id, title: p.quest_title, xpReward: p.quest_xp, coinReward: p.quest_coin },
    })),
  };
}

router.get('/api/profile/me', requireAuth, (req, res) => {
  ok(res, buildProfile(req.user, req.user.id));
});

router.patch('/api/profile/me', requireAuth, async (req, res) => {
  const body = await readJsonBody(req);
  if (body.bio !== undefined) {
    const bio = String(body.bio).slice(0, 150);
    db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio, req.user.id);
  }
  // Skills power the AI concierge's quest matching and the institution
  // member directory — stored the same comma-separated-TEXT way as
  // quests.skill_tags so the two columns can be compared directly.
  if (body.skills !== undefined) {
    const skills = Array.isArray(body.skills)
      ? body.skills.map((s) => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 8)
      : [];
    db.prepare('UPDATE users SET skills = ? WHERE id = ?').run(skills.join(','), req.user.id);
  }
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  ok(res, buildProfile(updated, req.user.id));
});

router.get('/api/profile/:userId', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!user) throw new HttpError(404, 'User not found');
  ok(res, buildProfile(user, req.user.id));
});

export default router;
