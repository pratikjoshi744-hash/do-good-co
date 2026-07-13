import { randomUUID } from 'node:crypto';
import { Router } from '../lib/http.js';
import { ok, created, readJsonBody, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { serializeQuest, serializeProof, serializeComment, serializeWitnessRequest } from '../lib/serialize.js';
import { requireAuth } from '../middleware/auth.js';
import { getSessionUser } from '../middleware/auth.js';
import { awardForApprovedProof, checkAndAwardBadges, adjustTrustScore, upvoteThresholdFor } from '../lib/gamification.js';

const router = new Router();
const FLAG_THRESHOLD = 3;

function getQuestOr404(id) {
  const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(id);
  if (!quest) throw new HttpError(404, 'Quest not found');
  return quest;
}

function getCategory(id) {
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
}

// GET /api/quests?category=slug&type=daily&search=text
// Personalized when a valid token is sent (soft auth — the endpoint itself
// stays public so the logged-out landing/demo flow never breaks): quests in
// categories the user has already completed proofs in get a small ranking
// boost, on top of the existing NGO-featured/sponsored priority. This is the
// "smart stand-in" for a real recommender — same shape, swappable later for
// an actual model without touching the client.
router.get('/api/quests', (req, res) => {
  const { category, type, search, skill } = req.query;
  let sql = `SELECT q.*, c.slug as category_slug FROM quests q JOIN categories c ON c.id = q.category_id WHERE q.status = 'active'`;
  const params = [];
  if (category) { sql += ' AND c.slug = ?'; params.push(category); }
  if (type) { sql += ' AND q.type = ?'; params.push(type); }
  if (search) { sql += ' AND (q.title LIKE ? OR q.description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  // skill_tags is a comma-separated TEXT column (no join table) — match with
  // wrapped-comma LIKE so "art" doesn't false-match "part-time" etc.
  if (skill) { sql += " AND (',' || q.skill_tags || ',') LIKE ?"; params.push(`%,${skill},%`); }
  const rows = db.prepare(sql).all(...params);

  const user = getSessionUser(req);
  let affinity = new Map();
  if (user) {
    const rows2 = db.prepare(`
      SELECT q.category_id as category_id, COUNT(*) as n
      FROM proofs p JOIN quests q ON q.id = p.quest_id
      WHERE p.user_id = ? AND p.status = 'approved'
      GROUP BY q.category_id
    `).all(user.id);
    affinity = new Map(rows2.map((r) => [r.category_id, r.n]));
  }

  const scored = rows.map((q) => {
    let score = 0;
    if (q.ngo_featured) score += 100;
    if (q.is_sponsored) score += 50;
    score += Math.min(30, (affinity.get(q.category_id) || 0) * 6); // capped so it nudges, doesn't dominate
    score += new Date(q.created_at).getTime() / 1e13; // tiny recency tiebreaker
    return { q, score };
  });
  scored.sort((a, b) => b.score - a.score);

  // isRecommended flags quests boosted purely by the user's own category
  // affinity (not already visually distinguished as NGO/sponsored) — the
  // client surfaces this as an "AI Recommended" badge. Same heuristic
  // scoring above, just exposed as a boolean the UI can key off of.
  const data = scored.map(({ q }) => ({
    ...serializeQuest(q, getCategory(q.category_id)),
    isRecommended: !!(user && !q.ngo_featured && !q.is_sponsored && (affinity.get(q.category_id) || 0) > 0),
  }));
  ok(res, data);
});

router.get('/api/quests/:id', (req, res) => {
  const quest = getQuestOr404(req.params.id);
  ok(res, serializeQuest(quest, getCategory(quest.category_id)));
});

// A small "proof gallery" — recent approved, media-bearing proofs from other
// users for this exact quest, shown on the quest detail page as social proof
// and a real example of what counts (alongside the authored proofExampleHint).
router.get('/api/quests/:id/proofs', (req, res) => {
  getQuestOr404(req.params.id);
  const rows = db.prepare(`
    SELECT p.*, u.name as user_name, u.avatar as user_avatar
    FROM proofs p JOIN users u ON u.id = p.user_id
    WHERE p.quest_id = ? AND p.status = 'approved' AND p.media_data IS NOT NULL
    ORDER BY p.submitted_at DESC LIMIT 8
  `).all(req.params.id);
  ok(res, rows.map((p) => ({
    id: p.id,
    mediaType: p.media_type,
    mediaData: p.media_data,
    caption: p.caption,
    user: { name: p.user_name, avatar: p.user_avatar },
  })));
});

// Community feed of recent proofs (approved + pending), optionally filtered by
// mohalla, status, or media type (mediaType=video powers the Reels tab).
router.get('/api/proofs/feed', (req, res) => {
  const { mohalla, status, mediaType } = req.query;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 50);
  let sql = `
    SELECT p.*, u.name as user_name, u.avatar as user_avatar, u.mohalla as user_mohalla, q.title as quest_title,
           q.xp_reward as quest_xp, q.coin_reward as quest_coin
    FROM proofs p
    JOIN users u ON u.id = p.user_id
    JOIN quests q ON q.id = p.quest_id
    WHERE p.status != 'flagged'
  `;
  const params = [];
  if (mohalla) { sql += ' AND u.mohalla = ?'; params.push(mohalla); }
  if (status) { sql += ' AND p.status = ?'; params.push(status); }
  if (mediaType) { sql += ' AND p.media_type = ?'; params.push(mediaType); }
  sql += ' ORDER BY p.submitted_at DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  const data = rows.map((p) => ({
    ...serializeProof(p),
    quest: { id: p.quest_id, title: p.quest_title, xpReward: p.quest_xp, coinReward: p.quest_coin },
    user: { id: p.user_id, name: p.user_name, avatar: p.user_avatar, mohalla: p.user_mohalla },
  }));
  ok(res, data);
});

// Haversine distance in meters — used to sanity-check a submitted GPS point
// against the quest's site coordinates. Approximate by design (both sides
// are simulated in this demo build), just enough to make "prove it" mean
// something more than an unchecked checkbox.
function distanceMeters(a, b) {
  if (!a || !b) return null;
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const GPS_RADIUS_METERS = 30000; // generous — both quest site and user GPS are city-level simulated in this build
const MIN_CAPTION_LENGTH = 12;

// Submit proof for a quest — this is the "prove it" endpoint, and it now
// runs a lightweight AI-style screening pass before anything gets the usual
// simulated-community-upvote fast track (see below): a proof that fails the
// screen goes to real review instead of auto-approving. Heuristic today
// (image variance / duplicate hash / GPS radius) — same shape as a real
// vision-model call, swappable later without touching the client.
router.post('/api/quests/:id/proofs', requireAuth, async (req, res) => {
  const quest = getQuestOr404(req.params.id);
  const body = await readJsonBody(req);

  if (body.mediaData && !/^data:(image|video)\/[a-zA-Z0-9.+-]+;base64,/.test(body.mediaData)) {
    throw new HttpError(400, 'mediaData must be an image or video data URL');
  }
  const caption = (body.caption || '').trim();
  if (caption.length < MIN_CAPTION_LENGTH) {
    throw new HttpError(400, `Add a quick reflection (at least ${MIN_CAPTION_LENGTH} characters) — what did you actually do?`);
  }

  const flagReasons = [];

  // GPS radius check
  let distance = null;
  if (quest.site_lat != null && body.gps?.lat != null) {
    distance = distanceMeters({ lat: quest.site_lat, lng: quest.site_lng }, body.gps);
    if (distance > GPS_RADIUS_METERS) {
      flagReasons.push(`GPS was ${Math.round(distance / 1000)}km from the reported deed site`);
    }
  }

  // Near-blank / low-detail image check (client computes a 0-1 variance score)
  if (typeof body.imageVariance === 'number' && body.imageVariance < 0.04) {
    flagReasons.push('Photo looks blank or very low detail');
  }

  // Duplicate-image check — same perceptual hash already used in an earlier
  // proof by anyone else is a strong fraud signal (recycled stock photo).
  let isDuplicate = false;
  if (body.imageHash) {
    const dupe = db.prepare(`
      SELECT id FROM proofs WHERE image_hash = ? AND user_id != ? LIMIT 1
    `).get(body.imageHash, req.user.id);
    if (dupe) {
      isDuplicate = true;
      flagReasons.push('Matches a photo already submitted by someone else');
    }
  }

  const aiFlagReason = flagReasons.length ? flagReasons.join('; ') : null;

  const proofId = randomUUID();
  db.prepare(`
    INSERT INTO proofs (id, quest_id, user_id, caption, photo_placeholder, media_type, media_data, gps_lat, gps_lng, status, upvote_count, flag_count, ai_duplicate_flag, image_hash, ai_flag_reason, distance_meters, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, ?, ?, datetime('now'))
  `).run(
    proofId,
    quest.id,
    req.user.id,
    caption,
    body.photoPlaceholder ?? '📷',
    body.mediaType ?? null,
    body.mediaData ?? null,
    body.gps?.lat ?? null,
    body.gps?.lng ?? null,
    isDuplicate ? 1 : 0,
    body.imageHash ?? null,
    aiFlagReason,
    distance
  );

  // Demo simulation: in production this waits for real community upvotes.
  // Here we simulate the mohalla community responding so a solo pitch demo
  // can show the full trust-engine loop (proof -> upvotes -> XP) end to end
  // — but only for proofs that passed the AI screen above, and only for
  // quests that aren't NGO-featured. A flagged proof skips the fast track
  // entirely and sits pending for real review; an NGO-featured quest always
  // sits pending for an actual NGO admin to review (see routes/ngo.js) —
  // that's the whole point of the "reviewed by a verified NGO partner" claim
  // shown on the quest detail screen, not just a cosmetic badge.
  const needsRealReview = !!aiFlagReason || !!quest.ngo_featured;
  // Trusted users need fewer corroborating upvotes to clear the fast track —
  // see upvoteThresholdFor in lib/gamification.js.
  const upvoteThreshold = upvoteThresholdFor(req.user.trust_score);
  if (!needsRealReview) {
    const simulatedUpvoters = db.prepare(`
      SELECT id FROM users WHERE id != ? ORDER BY RANDOM() LIMIT ?
    `).all(req.user.id, upvoteThreshold);

    const insertUpvote = db.prepare('INSERT OR IGNORE INTO upvotes (id, proof_id, user_id) VALUES (?, ?, ?)');
    simulatedUpvoters.forEach((u) => insertUpvote.run(randomUUID(), proofId, u.id));
  }

  const upvoteCount = db.prepare('SELECT COUNT(*) as c FROM upvotes WHERE proof_id = ?').get(proofId).c;
  db.prepare('UPDATE proofs SET upvote_count = ? WHERE id = ?').run(upvoteCount, proofId);

  let newBadges = [];
  let approved = false;
  if (!needsRealReview && upvoteCount >= upvoteThreshold) {
    db.prepare(`UPDATE proofs SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = 'community' WHERE id = ?`).run(proofId);
    adjustTrustScore(req.user.id, 2);
    newBadges = awardForApprovedProof(req.user, quest, proofId);
    approved = true;
  }

  const proof = db.prepare('SELECT * FROM proofs WHERE id = ?').get(proofId);
  const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  created(res, {
    proof: serializeProof(proof, { quest }),
    approved,
    xpAwarded: approved ? quest.xp_reward : 0,
    coinsAwarded: approved ? quest.coin_reward : 0,
    newBadges: newBadges.map((b) => ({ id: b.id, name: b.name, description: b.description, icon: b.icon })),
    userSnapshot: { xp: updatedUser.xp, karmaCoins: updatedUser.karma_coins },
  });
});

router.post('/api/proofs/:proofId/upvote', requireAuth, async (req, res) => {
  const proof = db.prepare('SELECT * FROM proofs WHERE id = ?').get(req.params.proofId);
  if (!proof) throw new HttpError(404, 'Proof not found');
  if (proof.user_id === req.user.id) throw new HttpError(400, 'You cannot upvote your own proof');

  try {
    db.prepare('INSERT INTO upvotes (id, proof_id, user_id) VALUES (?, ?, ?)').run(randomUUID(), proof.id, req.user.id);
  } catch {
    throw new HttpError(409, 'You already upvoted this proof');
  }

  const upvoteCount = db.prepare('SELECT COUNT(*) as c FROM upvotes WHERE proof_id = ?').get(proof.id).c;
  db.prepare('UPDATE proofs SET upvote_count = ? WHERE id = ?').run(upvoteCount, proof.id);

  let approved = false;
  let newBadges = [];
  const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(proof.quest_id);
  const needsRealReview = !!proof.ai_flag_reason || !!quest.ngo_featured;
  const proofOwner = db.prepare('SELECT * FROM users WHERE id = ?').get(proof.user_id);
  const upvoteThreshold = upvoteThresholdFor(proofOwner.trust_score);
  if (proof.status === 'pending' && !needsRealReview && upvoteCount >= upvoteThreshold) {
    db.prepare(`UPDATE proofs SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = 'community' WHERE id = ?`).run(proof.id);
    adjustTrustScore(proofOwner.id, 2);
    newBadges = awardForApprovedProof(proofOwner, quest, proof.id);
    approved = true;
  }

  checkAndAwardBadges(req.user.id);
  const updated = db.prepare('SELECT * FROM proofs WHERE id = ?').get(proof.id);
  ok(res, { proof: serializeProof(updated), approved, newBadges: newBadges.map((b) => ({ id: b.id, name: b.name, icon: b.icon })) });
});

router.post('/api/proofs/:proofId/flag', requireAuth, async (req, res) => {
  const proof = db.prepare('SELECT * FROM proofs WHERE id = ?').get(req.params.proofId);
  if (!proof) throw new HttpError(404, 'Proof not found');
  const body = await readJsonBody(req);

  try {
    db.prepare('INSERT INTO flags (id, proof_id, user_id, reason) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), proof.id, req.user.id, body.reason ?? 'No reason given');
  } catch {
    throw new HttpError(409, 'You already flagged this proof');
  }

  const flagCount = db.prepare('SELECT COUNT(*) as c FROM flags WHERE proof_id = ?').get(proof.id).c;
  let status = proof.status;
  if (flagCount >= FLAG_THRESHOLD && status !== 'approved') {
    status = 'flagged';
    adjustTrustScore(proof.user_id, -4);
  }
  db.prepare('UPDATE proofs SET flag_count = ?, status = ? WHERE id = ?').run(flagCount, status, proof.id);

  const updated = db.prepare('SELECT * FROM proofs WHERE id = ?').get(proof.id);
  ok(res, { proof: serializeProof(updated), sentToModeration: status === 'flagged' });
});

// --- Comments (social feed feature) ---------------------------------------

router.get('/api/proofs/:proofId/comments', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, u.name as user_name, u.avatar as user_avatar
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.proof_id = ? ORDER BY c.created_at ASC
  `).all(req.params.proofId);
  ok(res, rows.map((c) => serializeComment(c, { id: c.user_id, name: c.user_name, avatar: c.user_avatar })));
});

router.post('/api/proofs/:proofId/comments', requireAuth, async (req, res) => {
  const proof = db.prepare('SELECT * FROM proofs WHERE id = ?').get(req.params.proofId);
  if (!proof) throw new HttpError(404, 'Proof not found');
  const body = await readJsonBody(req);
  const text = String(body.text || '').trim();
  if (!text) throw new HttpError(400, 'Comment text is required');
  if (text.length > 500) throw new HttpError(400, 'Comment is too long (max 500 characters)');

  const id = randomUUID();
  db.prepare('INSERT INTO comments (id, proof_id, user_id, text) VALUES (?, ?, ?, ?)').run(id, proof.id, req.user.id, text);
  db.prepare('UPDATE proofs SET comment_count = comment_count + 1 WHERE id = ?').run(proof.id);

  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
  created(res, serializeComment(comment, { id: req.user.id, name: req.user.name, avatar: req.user.avatar }));
});

// --- Peer-witness verification (the anti-AI-fraud countermeasure) --------
//
// A proof owner can open their own pending proof for witnessing. Any other
// user browsing "witness requests near me" can claim the open slot and
// confirm they actually saw the deed happen. Confirming pays the witness a
// small reward for the civic labor of verifying someone else, and moves the
// proof owner's trust score more than an algorithmic pass ever could — a
// real second human vouching is a much harder thing to fake at scale than a
// generated photo.

const WITNESS_REWARD_COINS = 5;
const WITNESS_TRUST_BONUS = 6;

router.post('/api/proofs/:proofId/witness-request', requireAuth, async (req, res) => {
  const proof = db.prepare('SELECT * FROM proofs WHERE id = ?').get(req.params.proofId);
  if (!proof) throw new HttpError(404, 'Proof not found');
  if (proof.user_id !== req.user.id) throw new HttpError(403, 'Only the proof owner can request a witness for it');
  if (proof.status !== 'pending') throw new HttpError(400, 'Only a proof still awaiting review can be opened for witnessing');

  const existing = db.prepare(`SELECT id FROM proof_witnesses WHERE proof_id = ? AND status = 'open'`).get(proof.id);
  if (existing) throw new HttpError(409, 'This proof already has an open witness request');

  const body = await readJsonBody(req).catch(() => ({}));
  const id = randomUUID();
  db.prepare(`
    INSERT INTO proof_witnesses (id, proof_id, requester_id, status, note, reward_coins)
    VALUES (?, ?, ?, 'open', ?, ?)
  `).run(id, proof.id, req.user.id, (body?.note || '').trim() || null, WITNESS_REWARD_COINS);

  const row = db.prepare('SELECT * FROM proof_witnesses WHERE id = ?').get(id);
  const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(proof.quest_id);
  created(res, serializeWitnessRequest(row, { quest, requester: req.user }));
});

// Open witness requests near the current user — "near" is approximated by
// same mohalla first (real proximity, same as the rest of this build's GPS
// story), falling back to city-wide if the mohalla has nothing open, so a
// witness marketplace never looks empty in a smaller demo dataset.
router.get('/api/witness-requests/nearby', requireAuth, (req, res) => {
  const localRows = db.prepare(`
    SELECT w.*, p.quest_id, p.caption, p.media_type, p.media_data, u.name as requester_name, u.avatar as requester_avatar, u.mohalla as requester_mohalla
    FROM proof_witnesses w
    JOIN proofs p ON p.id = w.proof_id
    JOIN users u ON u.id = w.requester_id
    WHERE w.status = 'open' AND w.requester_id != ? AND u.mohalla = ?
    ORDER BY w.requested_at ASC LIMIT 20
  `).all(req.user.id, req.user.mohalla);

  const rows = localRows.length ? localRows : db.prepare(`
    SELECT w.*, p.quest_id, p.caption, p.media_type, p.media_data, u.name as requester_name, u.avatar as requester_avatar, u.mohalla as requester_mohalla
    FROM proof_witnesses w
    JOIN proofs p ON p.id = w.proof_id
    JOIN users u ON u.id = w.requester_id
    WHERE w.status = 'open' AND w.requester_id != ?
    ORDER BY w.requested_at ASC LIMIT 20
  `).all(req.user.id);

  ok(res, rows.map((w) => {
    const quest = db.prepare('SELECT id, title FROM quests WHERE id = ?').get(w.quest_id);
    return {
      ...serializeWitnessRequest(w, { quest, requester: { id: w.requester_id, name: w.requester_name, avatar: w.requester_avatar, mohalla: w.requester_mohalla } }),
      proofCaption: w.caption,
      proofMediaType: w.media_type,
      proofMediaData: w.media_data,
    };
  }));
});

router.post('/api/witness-requests/:id/confirm', requireAuth, async (req, res) => {
  const request = db.prepare('SELECT * FROM proof_witnesses WHERE id = ?').get(req.params.id);
  if (!request) throw new HttpError(404, 'Witness request not found');
  if (request.status !== 'open') throw new HttpError(400, 'This witness request is no longer open');
  if (request.requester_id === req.user.id) throw new HttpError(400, 'You cannot witness your own proof');

  db.prepare(`
    UPDATE proof_witnesses SET status = 'confirmed', witness_id = ?, confirmed_at = datetime('now') WHERE id = ?
  `).run(req.user.id, request.id);
  db.prepare('UPDATE proofs SET witness_count = witness_count + 1 WHERE id = ?').run(request.proof_id);

  // Pay the witness for the civic labor of verifying someone else's deed.
  db.prepare('UPDATE users SET karma_coins = karma_coins + ? WHERE id = ?').run(request.reward_coins, req.user.id);
  db.prepare(`
    INSERT INTO wallet_transactions (id, user_id, direction, amount, description, related_proof_id, redemption_option_id, status)
    VALUES (?, ?, 'earn', ?, ?, ?, NULL, 'completed')
  `).run(randomUUID(), req.user.id, request.reward_coins, "Witnessed a fellow citizen's deed", request.proof_id);

  // A real, physically-present second human confirming it happened moves
  // trust further than an algorithmic pass — see WITNESS_TRUST_BONUS above.
  adjustTrustScore(request.requester_id, WITNESS_TRUST_BONUS);
  checkAndAwardBadges(req.user.id);

  const updated = db.prepare('SELECT * FROM proof_witnesses WHERE id = ?').get(request.id);
  const proof = db.prepare('SELECT * FROM proofs WHERE id = ?').get(request.proof_id);
  ok(res, {
    request: serializeWitnessRequest(updated, { witness: req.user }),
    proof: serializeProof(proof),
    coinsEarned: request.reward_coins,
  });
});

// So a proof's own detail screen can show "witness requested, waiting..."
// or "confirmed by X" without a separate lookup.
router.get('/api/proofs/:proofId/witness-request', requireAuth, (req, res) => {
  const row = db.prepare(`
    SELECT w.*, u.name as witness_name, u.avatar as witness_avatar
    FROM proof_witnesses w LEFT JOIN users u ON u.id = w.witness_id
    WHERE w.proof_id = ? ORDER BY w.requested_at DESC LIMIT 1
  `).get(req.params.proofId);
  if (!row) return ok(res, null);
  ok(res, serializeWitnessRequest(row, { witness: row.witness_id ? { id: row.witness_id, name: row.witness_name, avatar: row.witness_avatar } : null }));
});

export default router;
