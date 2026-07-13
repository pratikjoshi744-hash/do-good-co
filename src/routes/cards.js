import { randomUUID } from 'node:crypto';
import { Router } from '../lib/http.js';
import { ok, created, readJsonBody, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { serializeKarmaCard } from '../lib/serialize.js';
import { requireAuth } from '../middleware/auth.js';

// Karma Cards — collectible drops on milestone deeds (see
// maybeDropKarmaCard in lib/gamification.js). This route surfaces the full
// catalog with per-card ownership counts, and lets a user gift a duplicate
// to a friend — the actual social hook of a collectible mechanic.

const router = new Router();

router.get('/api/cards/me', requireAuth, (req, res) => {
  const catalog = db.prepare('SELECT * FROM karma_cards ORDER BY CASE rarity WHEN \'legendary\' THEN 0 WHEN \'epic\' THEN 1 WHEN \'rare\' THEN 2 ELSE 3 END, name ASC').all();
  const owned = db.prepare(`
    SELECT card_id, COUNT(*) as count, MAX(obtained_at) as last_obtained_at
    FROM user_cards WHERE user_id = ? GROUP BY card_id
  `).all(req.user.id);
  const ownedMap = new Map(owned.map((o) => [o.card_id, o]));

  ok(res, catalog.map((c) => {
    const o = ownedMap.get(c.id);
    return serializeKarmaCard(c, { owned: !!o, count: o?.count || 0, lastObtainedAt: o?.last_obtained_at || null });
  }));
});

router.get('/api/cards/inventory', requireAuth, (req, res) => {
  // Alias k.id explicitly — SELECT uc.*, k.* would otherwise let the join
  // silently overwrite user_cards.id with karma_cards.id in the result row.
  const rows = db.prepare(`
    SELECT uc.id as user_card_id, uc.obtained_at, uc.gifted_from,
           k.id, k.name, k.rarity, k.art, k.description, k.color
    FROM user_cards uc JOIN karma_cards k ON k.id = uc.card_id
    WHERE uc.user_id = ? ORDER BY uc.obtained_at DESC
  `).all(req.user.id);
  ok(res, rows.map((r) => ({
    userCardId: r.user_card_id,
    obtainedAt: r.obtained_at,
    giftedFrom: r.gifted_from,
    card: serializeKarmaCard(r),
  })));
});

router.post('/api/cards/:userCardId/gift', requireAuth, async (req, res) => {
  const userCard = db.prepare('SELECT * FROM user_cards WHERE id = ?').get(req.params.userCardId);
  if (!userCard) throw new HttpError(404, 'Card not found in your collection');
  if (userCard.user_id !== req.user.id) throw new HttpError(403, "This isn't your card to gift");

  const body = await readJsonBody(req);
  const recipientPhone = String(body.recipientPhone || '').trim();
  if (!recipientPhone) throw new HttpError(400, 'recipientPhone is required');

  const recipient = db.prepare('SELECT * FROM users WHERE phone = ?').get(recipientPhone);
  if (!recipient) throw new HttpError(404, "We couldn't find an account with that phone number.");
  if (recipient.id === req.user.id) throw new HttpError(400, "You can't gift a card to yourself");

  const newId = randomUUID();
  db.prepare(`
    INSERT INTO user_cards (id, user_id, card_id, gifted_from) VALUES (?, ?, ?, ?)
  `).run(newId, recipient.id, userCard.card_id, req.user.id);
  db.prepare('DELETE FROM user_cards WHERE id = ?').run(userCard.id);

  const card = db.prepare('SELECT * FROM karma_cards WHERE id = ?').get(userCard.card_id);
  created(res, { gifted: serializeKarmaCard(card), to: { id: recipient.id, name: recipient.name, avatar: recipient.avatar } });
});

export default router;
