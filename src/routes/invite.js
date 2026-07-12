import { Router } from '../lib/http.js';
import { ok } from '../lib/http.js';
import { db } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';

const router = new Router();

// Everything the Invite screen needs: the user's own shareable code, plus a
// small "hall of fame" of who they've brought in so far. invited_by is set
// at signup time (see routes/auth.js's POST /api/auth/signup) - no separate
// invites table needed since a referral either converts into a real user
// row or never happened at all.
router.get('/api/invite/me', requireAuth, (req, res) => {
  const invited = db.prepare(`
    SELECT id, name, avatar, mohalla, created_at FROM users WHERE invited_by = ? ORDER BY created_at DESC
  `).all(req.user.id);

  const coinsEarned = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM wallet_transactions
    WHERE user_id = ? AND direction = 'earn' AND description LIKE '%joined using your invite!%'
  `).get(req.user.id).total;

  ok(res, {
    referralCode: req.user.referral_code,
    invitedCount: invited.length,
    coinsEarnedFromInvites: coinsEarned,
    invitedUsers: invited.map((u) => ({ id: u.id, name: u.name, avatar: u.avatar, mohalla: u.mohalla, joinedAt: u.created_at })),
  });
});

export default router;
