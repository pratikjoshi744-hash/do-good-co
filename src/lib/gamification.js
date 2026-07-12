import { randomUUID } from 'node:crypto';
import { db } from '../db/connection.js';

/**
 * Awards XP + Karma Coins to a user and checks for newly-earned badges.
 * Returns the list of badges newly unlocked by this action (for toast/confetti UI).
 */
export function awardForApprovedProof(user, quest, proofId) {
  db.prepare('UPDATE users SET xp = xp + ?, karma_coins = karma_coins + ? WHERE id = ?')
    .run(quest.xp_reward, quest.coin_reward, user.id);

  db.prepare(`
    INSERT INTO wallet_transactions (id, user_id, direction, amount, description, related_proof_id, redemption_option_id, status)
    VALUES (?, ?, 'earn', ?, ?, ?, NULL, 'completed')
  `).run(randomUUID(), user.id, quest.coin_reward, `Completed '${quest.title}'`, proofId);

  return checkAndAwardBadges(user.id);
}

export function checkAndAwardBadges(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const approvedCount = db.prepare("SELECT COUNT(*) as c FROM proofs WHERE user_id = ? AND status = 'approved'").get(userId).c;
  const upvotesGiven = db.prepare('SELECT COUNT(*) as c FROM upvotes WHERE user_id = ?').get(userId).c;
  const alreadyEarned = new Set(
    db.prepare('SELECT badge_id FROM user_badges WHERE user_id = ?').all(userId).map((r) => r.badge_id)
  );

  const toAward = [];
  const maybe = (badgeId, condition) => {
    if (condition && !alreadyEarned.has(badgeId)) toAward.push(badgeId);
  };

  maybe('first-deed', approvedCount >= 1);
  maybe('century', user.xp >= 100);
  maybe('streak-7', user.streak_days >= 7);
  maybe('trusted-verifier', upvotesGiven >= 25);

  const insertBadge = db.prepare('INSERT OR IGNORE INTO user_badges (id, user_id, badge_id, earned_at) VALUES (?, ?, ?, datetime(\'now\'))');
  const badgeRows = [];
  for (const badgeId of toAward) {
    insertBadge.run(randomUUID(), userId, badgeId);
    badgeRows.push(db.prepare('SELECT * FROM badges WHERE id = ?').get(badgeId));
  }
  return badgeRows;
}
