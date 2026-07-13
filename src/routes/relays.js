import { randomUUID } from 'node:crypto';
import { Router } from '../lib/http.js';
import { ok, created, readJsonBody, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { serializeCategory } from '../lib/serialize.js';
import { requireAuth } from '../middleware/auth.js';
import { checkAndAwardBadges } from '../lib/gamification.js';

// --- Deed Relays -------------------------------------------------------
//
// A relay is a chain of tasks where step N only unlocks once step N-1 is
// marked done — a baton pass, not a solo checklist. Anyone can claim an open
// step (including the creator), so a relay is naturally a multi-person
// effort: "Clean 5 blocks of the riverside path, one block per runner."
// Deliberately lightweight compared to the full quest/proof pipeline (no AI
// screening, no GPS check) — the trust model here is social: your name is on
// a public leg of a chain your neighbours can see.

const router = new Router();
const STEP_XP = 25;
const STEP_COINS = 40;
const COMPLETION_BONUS_COINS = 30;

function serializeStep(s) {
  return {
    id: s.id,
    chainId: s.chain_id,
    order: s.step_order,
    task: s.task,
    status: s.status,
    assignee: s.assignee_id ? { id: s.assignee_id, name: s.assignee_name, avatar: s.assignee_avatar } : null,
    proofCaption: s.proof_caption || null,
    proofMediaType: s.proof_media_type || null,
    proofMediaData: s.proof_media_data || null,
    claimedAt: s.claimed_at,
    completedAt: s.completed_at,
  };
}

function loadChainWithSteps(chainId) {
  const chain = db.prepare(`
    SELECT r.*, u.name as creator_name, u.avatar as creator_avatar, c.slug as category_slug
    FROM relay_chains r
    JOIN users u ON u.id = r.creator_id
    LEFT JOIN categories c ON c.id = r.category_id
    WHERE r.id = ?
  `).get(chainId);
  if (!chain) return null;
  const steps = db.prepare(`
    SELECT rs.*, u.name as assignee_name, u.avatar as assignee_avatar
    FROM relay_steps rs
    LEFT JOIN users u ON u.id = rs.assignee_id
    WHERE rs.chain_id = ? ORDER BY rs.step_order ASC
  `).all(chainId);
  const category = chain.category_id ? db.prepare('SELECT * FROM categories WHERE id = ?').get(chain.category_id) : null;
  const doneCount = steps.filter((s) => s.status === 'done').length;
  return {
    id: chain.id,
    title: chain.title,
    description: chain.description,
    icon: chain.icon,
    category: category ? serializeCategory(category) : null,
    creator: { id: chain.creator_id, name: chain.creator_name, avatar: chain.creator_avatar },
    status: chain.status,
    createdAt: chain.created_at,
    totalSteps: steps.length,
    doneSteps: doneCount,
    progressPct: steps.length ? Math.round((doneCount / steps.length) * 100) : 0,
    steps: steps.map(serializeStep),
  };
}

router.get('/api/relays', (req, res) => {
  const rows = db.prepare(`SELECT id FROM relay_chains ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at DESC LIMIT 50`).all();
  ok(res, rows.map((r) => loadChainWithSteps(r.id)));
});

router.get('/api/relays/:id', (req, res) => {
  const chain = loadChainWithSteps(req.params.id);
  if (!chain) throw new HttpError(404, 'Relay not found');
  ok(res, chain);
});

router.post('/api/relays', requireAuth, async (req, res) => {
  const body = await readJsonBody(req);
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const steps = Array.isArray(body.steps) ? body.steps.map((s) => String(s || '').trim()).filter(Boolean) : [];

  if (!title) throw new HttpError(400, 'title is required');
  if (steps.length < 2) throw new HttpError(400, 'A relay needs at least 2 steps — that\'s what makes it a relay');
  if (steps.length > 12) throw new HttpError(400, 'Keep a relay to 12 steps or fewer');

  let categoryId = null;
  if (body.categorySlug) {
    const category = db.prepare('SELECT * FROM categories WHERE slug = ?').get(body.categorySlug);
    if (category) categoryId = category.id;
  }

  const chainId = randomUUID();
  db.prepare(`
    INSERT INTO relay_chains (id, title, description, icon, category_id, creator_id, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `).run(chainId, title, description || 'A community relay — pick a leg and pass the baton.', body.icon || '🔗', categoryId, req.user.id);

  const insertStep = db.prepare(`
    INSERT INTO relay_steps (id, chain_id, step_order, task, status) VALUES (?, ?, ?, ?, ?)
  `);
  steps.forEach((task, i) => {
    insertStep.run(randomUUID(), chainId, i + 1, task, i === 0 ? 'open' : 'locked');
  });

  created(res, loadChainWithSteps(chainId));
});

function getStepOr404(chainId, stepId) {
  const step = db.prepare('SELECT * FROM relay_steps WHERE id = ? AND chain_id = ?').get(stepId, chainId);
  if (!step) throw new HttpError(404, 'Relay step not found');
  return step;
}

router.post('/api/relays/:id/steps/:stepId/claim', requireAuth, async (req, res) => {
  const chain = db.prepare('SELECT * FROM relay_chains WHERE id = ?').get(req.params.id);
  if (!chain) throw new HttpError(404, 'Relay not found');
  const step = getStepOr404(req.params.id, req.params.stepId);
  if (step.status !== 'open') throw new HttpError(400, step.status === 'locked' ? 'This leg is still waiting on an earlier one to finish' : 'This leg is already claimed or done');

  db.prepare(`UPDATE relay_steps SET status = 'claimed', assignee_id = ?, claimed_at = datetime('now') WHERE id = ?`).run(req.user.id, step.id);
  ok(res, loadChainWithSteps(chain.id));
});

router.post('/api/relays/:id/steps/:stepId/complete', requireAuth, async (req, res) => {
  const chain = db.prepare('SELECT * FROM relay_chains WHERE id = ?').get(req.params.id);
  if (!chain) throw new HttpError(404, 'Relay not found');
  const step = getStepOr404(req.params.id, req.params.stepId);
  if (step.status !== 'claimed') throw new HttpError(400, 'Claim this leg before completing it');
  if (step.assignee_id !== req.user.id) throw new HttpError(403, 'Only the person who claimed this leg can complete it');

  const body = await readJsonBody(req);
  const caption = String(body.caption || '').trim();
  if (caption.length < 8) throw new HttpError(400, 'Add a quick note (at least 8 characters) on what you did for your leg');

  db.prepare(`
    UPDATE relay_steps SET status = 'done', proof_caption = ?, proof_media_type = ?, proof_media_data = ?, completed_at = datetime('now') WHERE id = ?
  `).run(caption, body.mediaType ?? null, body.mediaData ?? null, step.id);

  db.prepare('UPDATE users SET xp = xp + ?, karma_coins = karma_coins + ? WHERE id = ?').run(STEP_XP, STEP_COINS, req.user.id);
  db.prepare(`
    INSERT INTO wallet_transactions (id, user_id, direction, amount, description, status)
    VALUES (?, ?, 'earn', ?, ?, 'completed')
  `).run(randomUUID(), req.user.id, STEP_COINS, `Completed a leg of relay '${chain.title}'`);

  // Unlock the next step, if any.
  const nextStep = db.prepare('SELECT * FROM relay_steps WHERE chain_id = ? AND step_order = ?').get(chain.id, step.step_order + 1);
  if (nextStep) {
    db.prepare(`UPDATE relay_steps SET status = 'open' WHERE id = ?`).run(nextStep.id);
  } else {
    // Last leg — the relay is complete. Every participant who ran a leg gets
    // a small shared-finish bonus, the "you were all part of this" payoff.
    db.prepare(`UPDATE relay_chains SET status = 'completed' WHERE id = ?`).run(chain.id);
    const participants = db.prepare(`SELECT DISTINCT assignee_id FROM relay_steps WHERE chain_id = ? AND assignee_id IS NOT NULL`).all(chain.id);
    const bonus = db.prepare('UPDATE users SET karma_coins = karma_coins + ? WHERE id = ?');
    const bonusTx = db.prepare(`INSERT INTO wallet_transactions (id, user_id, direction, amount, description, status) VALUES (?, ?, 'earn', ?, ?, 'completed')`);
    participants.forEach((p) => {
      bonus.run(COMPLETION_BONUS_COINS, p.assignee_id);
      bonusTx.run(randomUUID(), p.assignee_id, COMPLETION_BONUS_COINS, `Relay '${chain.title}' completed — team bonus!`);
    });
  }

  checkAndAwardBadges(req.user.id);
  const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  ok(res, {
    chain: loadChainWithSteps(chain.id),
    xpAwarded: STEP_XP,
    coinsAwarded: STEP_COINS,
    userSnapshot: { xp: updatedUser.xp, karmaCoins: updatedUser.karma_coins },
  });
});

export default router;
