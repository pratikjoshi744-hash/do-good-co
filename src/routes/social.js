import { randomUUID } from 'node:crypto';
import { Router } from '../lib/http.js';
import { ok, created, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';
import { xpProgress } from '../lib/levels.js';

const router = new Router();

// Instagram-style directional follow graph. No approval step — public
// profiles, MVP scope. Kept in its own routes file (rather than bolted onto
// profile.js) since it's really a distinct resource (the follows table)
// even though profile.js is the main consumer of the counts it produces.

function briefUser(user) {
  if (!user) return null;
  const progress = xpProgress(user.xp);
  return {
    id: user.id,
    name: user.name,
    avatar: user.avatar,
    mohalla: user.mohalla,
    city: user.city,
    level: progress.level,
    tier: progress.tier,
    tierColor: progress.tierColor,
  };
}

function isFollowing(followerId, followingId) {
  if (!followerId || !followingId) return false;
  return !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(followerId, followingId);
}

router.post('/api/social/follow/:userId', requireAuth, (req, res) => {
  const targetId = req.params.userId;
  if (targetId === req.user.id) throw new HttpError(400, "You can't follow yourself.");
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) throw new HttpError(404, 'User not found');

  db.prepare(`INSERT OR IGNORE INTO follows (id, follower_id, following_id) VALUES (?, ?, ?)`)
    .run(randomUUID(), req.user.id, targetId);

  const followerCount = db.prepare('SELECT COUNT(*) as n FROM follows WHERE following_id = ?').get(targetId).n;
  created(res, { following: true, followerCount });
});

router.delete('/api/social/follow/:userId', requireAuth, (req, res) => {
  const targetId = req.params.userId;
  db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').run(req.user.id, targetId);
  const followerCount = db.prepare('SELECT COUNT(*) as n FROM follows WHERE following_id = ?').get(targetId).n;
  ok(res, { following: false, followerCount });
});

router.get('/api/social/followers/:userId', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT u.* FROM follows f JOIN users u ON u.id = f.follower_id
    WHERE f.following_id = ? ORDER BY f.created_at DESC
  `).all(req.params.userId);
  ok(res, {
    users: rows.map((u) => ({ ...briefUser(u), isFollowing: isFollowing(req.user.id, u.id) })),
  });
});

router.get('/api/social/following/:userId', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT u.* FROM follows f JOIN users u ON u.id = f.following_id
    WHERE f.follower_id = ? ORDER BY f.created_at DESC
  `).all(req.params.userId);
  ok(res, {
    users: rows.map((u) => ({ ...briefUser(u), isFollowing: isFollowing(req.user.id, u.id) })),
  });
});

export { isFollowing };
export default router;
