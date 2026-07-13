import { randomUUID } from 'node:crypto';
import { db } from '../db/connection.js';
import { pickWeightedCard } from '../db/seed.js';

/**
 * Awards XP + Karma Coins to a user and checks for newly-earned badges.
 * Returns { badges, newCard } — newCard is set only on a milestone deed
 * (see maybeDropKarmaCard below), for toast/confetti UI to react to.
 */
export function awardForApprovedProof(user, quest, proofId) {
  db.prepare('UPDATE users SET xp = xp + ?, karma_coins = karma_coins + ? WHERE id = ?')
    .run(quest.xp_reward, quest.coin_reward, user.id);

  db.prepare(`
    INSERT INTO wallet_transactions (id, user_id, direction, amount, description, related_proof_id, redemption_option_id, status)
    VALUES (?, ?, 'earn', ?, ?, ?, NULL, 'completed')
  `).run(randomUUID(), user.id, quest.coin_reward, `Completed '${quest.title}'`, proofId);

  recordCsrMatch(user, quest, proofId);
  const newCard = maybeDropKarmaCard(user.id);
  const badges = checkAndAwardBadges(user.id);
  badges.newCard = newCard;
  return badges;
}

/**
 * Karma Cards — a collectible drop on every 5th approved deed (5, 10, 15…),
 * weighted by rarity (see pickWeightedCard in db/seed.js). Milestone-gated
 * rather than every deed so a card actually feels earned, and duplicates are
 * allowed (a real collectible-card mechanic — dupes are part of the game,
 * not a bug) since gifting a duplicate to a friend is itself a feature.
 */
const CARD_DROP_EVERY_N_DEEDS = 5;

function maybeDropKarmaCard(userId) {
  const approvedCount = db.prepare("SELECT COUNT(*) as c FROM proofs WHERE user_id = ? AND status = 'approved'").get(userId).c;
  if (approvedCount === 0 || approvedCount % CARD_DROP_EVERY_N_DEEDS !== 0) return null;

  const card = pickWeightedCard();
  if (!card) return null;

  db.prepare('INSERT INTO user_cards (id, user_id, card_id) VALUES (?, ?, ?)').run(randomUUID(), userId, card.id);
  return { id: card.id, name: card.name, rarity: card.rarity, art: card.art, color: card.color, description: card.description };
}

/**
 * CSR matching — every approved deed by an employee of a company running a
 * matching program (matching_rate_paise_per_hour > 0) writes one ledger row
 * converting the deed's estimated_minutes into a real matched-rupee amount.
 * Deliberately not limited to company-sponsored quests: matching *any*
 * volunteering an employee does is what makes this a genuine incentive to
 * go do good deeds, not just a rebate on quests the company already paid to
 * post. Silent no-op for employees whose company isn't running matching, or
 * for non-employees (company_id is null) — never blocks the XP/coin award.
 */
function recordCsrMatch(user, quest, proofId) {
  if (!user.company_id) return;
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(user.company_id);
  if (!company || !company.matching_rate_paise_per_hour) return;

  const minutes = quest.estimated_minutes || 0;
  const amountPaise = Math.round((minutes / 60) * company.matching_rate_paise_per_hour);
  if (amountPaise <= 0) return;

  db.prepare(`
    INSERT INTO csr_matches (id, company_id, user_id, proof_id, quest_id, minutes, amount_paise)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), company.id, user.id, proofId, quest.id, minutes, amountPaise);
}

/**
 * Nudges a user's trust score by `delta`, clamped to [0, 100]. Centralizes
 * every place trust moves so the scale stays consistent as more signals
 * (NGO review, admin review, peer witnessing, community fast-track) feed
 * into the same number.
 */
export function adjustTrustScore(userId, delta) {
  db.prepare('UPDATE users SET trust_score = MAX(0, MIN(100, trust_score + ?)) WHERE id = ?').run(delta, userId);
}

/**
 * Trust-scaled upvote threshold for the simulated community fast-track:
 * a user who has consistently submitted proofs that survive review needs
 * fewer corroborating upvotes to clear, mirroring how real community trust
 * systems (eBay seller ratings, Stack Overflow rep) reduce friction for
 * proven-reliable members instead of treating every submission identically.
 */
export function upvoteThresholdFor(trustScore) {
  if (trustScore >= 90) return 2;
  if (trustScore >= 80) return 3;
  return 5;
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
