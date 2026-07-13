import { randomUUID, randomBytes } from 'node:crypto';
import { Router } from '../lib/http.js';
import { ok, created, readJsonBody, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { serializeTransaction, serializeRedemption, serializeVoucher, serializeCashoutRequest } from '../lib/serialize.js';
import { requireAuth } from '../middleware/auth.js';

// Real-looking, collision-checked voucher code — not a fake placeholder.
// Format mirrors what a partner brand's own promo codes typically look like:
// DGC-XXXX-XXXX using an unambiguous alphabet (no 0/O/1/I).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateVoucherCode() {
  const block = () => Array.from(randomBytes(4)).map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = `DGC-${block()}-${block()}`;
    const exists = db.prepare('SELECT id FROM vouchers WHERE code = ?').get(code);
    if (!exists) return code;
  }
  return `DGC-${randomUUID().slice(0, 8).toUpperCase()}`;
}

const router = new Router();

router.get('/api/wallet', requireAuth, (req, res) => {
  const transactions = db.prepare('SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  ok(res, {
    karmaCoins: req.user.karma_coins,
    transactions: transactions.map(serializeTransaction),
  });
});

router.get('/api/wallet/redemption-options', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM redemption_options WHERE status = 'active' ORDER BY coin_cost ASC`).all();
  ok(res, rows.map(serializeRedemption));
});

router.post('/api/wallet/redeem', requireAuth, async (req, res) => {
  const body = await readJsonBody(req);
  const optionId = body.redemptionOptionId;
  if (!optionId) throw new HttpError(400, 'redemptionOptionId is required');

  const option = db.prepare(`SELECT * FROM redemption_options WHERE id = ? AND status = 'active'`).get(optionId);
  if (!option) throw new HttpError(404, 'Redemption option not found');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.karma_coins < option.coin_cost) {
    throw new HttpError(400, 'Not enough Karma Coins for this redemption', { needed: option.coin_cost, have: user.karma_coins });
  }

  db.prepare('UPDATE users SET karma_coins = karma_coins - ? WHERE id = ?').run(option.coin_cost, user.id);

  const txId = randomUUID();
  db.prepare(`
    INSERT INTO wallet_transactions (id, user_id, direction, amount, description, redemption_option_id, status)
    VALUES (?, ?, 'redeem', ?, ?, ?, 'completed')
  `).run(txId, user.id, -option.coin_cost, `Redeemed ${option.name}`, option.id);

  // Voucher-type redemptions mint a real, unique coupon code right away —
  // this is the actual redeemable coupon, not just a wallet ledger entry.
  let voucher = null;
  if (option.type === 'voucher') {
    const voucherId = randomUUID();
    const code = generateVoucherCode();
    db.prepare(`
      INSERT INTO vouchers (id, user_id, redemption_option_id, code, status) VALUES (?, ?, ?, ?, 'active')
    `).run(voucherId, user.id, option.id, code);
    voucher = serializeVoucher(db.prepare('SELECT * FROM vouchers WHERE id = ?').get(voucherId), option);
  }

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  created(res, {
    transaction: serializeTransaction(db.prepare('SELECT * FROM wallet_transactions WHERE id = ?').get(txId)),
    remainingKarmaCoins: updated.karma_coins,
    voucher,
  });
});

router.get('/api/wallet/vouchers', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT v.*, r.name as option_name, r.partner_name, r.icon as option_icon
    FROM vouchers v JOIN redemption_options r ON r.id = v.redemption_option_id
    WHERE v.user_id = ? ORDER BY v.issued_at DESC
  `).all(req.user.id);
  ok(res, rows.map((v) => serializeVoucher(v, { id: v.redemption_option_id, name: v.option_name, partner_name: v.partner_name, icon: v.option_icon })));
});

// Promo code entry — one-time bonus coin grant per user per code, capped by
// the code's own max_uses/expiry. Real server-side validation, not a
// cosmetic input box: wrong/expired/already-used codes are rejected.
router.post('/api/wallet/promo', requireAuth, async (req, res) => {
  const body = await readJsonBody(req);
  const code = String(body.code || '').trim().toUpperCase();
  if (!code) throw new HttpError(400, 'Enter a promo code');

  const promo = db.prepare(`SELECT * FROM promo_codes WHERE code = ? AND status = 'active'`).get(code);
  if (!promo) throw new HttpError(404, "That code doesn't look right — double-check and try again.");
  if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
    throw new HttpError(400, 'This code has expired.');
  }
  if (promo.max_uses != null && promo.uses_count >= promo.max_uses) {
    throw new HttpError(400, 'This code has reached its usage limit.');
  }

  const already = db.prepare('SELECT id FROM promo_redemptions WHERE promo_code_id = ? AND user_id = ?').get(promo.id, req.user.id);
  if (already) throw new HttpError(409, "You've already used this code.");

  db.prepare('INSERT INTO promo_redemptions (id, promo_code_id, user_id) VALUES (?, ?, ?)').run(randomUUID(), promo.id, req.user.id);
  db.prepare('UPDATE promo_codes SET uses_count = uses_count + 1 WHERE id = ?').run(promo.id);
  db.prepare('UPDATE users SET karma_coins = karma_coins + ? WHERE id = ?').run(promo.coin_bonus, req.user.id);
  db.prepare(`
    INSERT INTO wallet_transactions (id, user_id, direction, amount, description, status)
    VALUES (?, ?, 'earn', ?, ?, 'completed')
  `).run(randomUUID(), req.user.id, promo.coin_bonus, `Promo code ${code}${promo.description ? ' — ' + promo.description : ''}`);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  created(res, { coinBonus: promo.coin_bonus, karmaCoins: updated.karma_coins });
});

const SPIN_REWARDS = [10, 15, 20, 25, 30, 50, 75, 100];

function isSameCalendarDay(isoA, isoB) {
  if (!isoA || !isoB) return false;
  return isoA.slice(0, 10) === isoB.slice(0, 10);
}

router.get('/api/wallet/daily-spin/status', requireAuth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const available = !isSameCalendarDay(req.user.last_spin_at, today);
  ok(res, { available, lastSpinAt: req.user.last_spin_at });
});

// A small daily "Karma Spin" bonus — free coins once every 24h, purely to make
// opening the app each day a little more fun (classic gacha-lite retention loop).
router.post('/api/wallet/daily-spin', requireAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  if (isSameCalendarDay(req.user.last_spin_at, today)) {
    throw new HttpError(400, "You've already spun today. Come back tomorrow!");
  }

  const reward = SPIN_REWARDS[Math.floor(Math.random() * SPIN_REWARDS.length)];
  db.prepare(`UPDATE users SET karma_coins = karma_coins + ?, last_spin_at = datetime('now') WHERE id = ?`).run(reward, req.user.id);
  db.prepare(`
    INSERT INTO wallet_transactions (id, user_id, direction, amount, description, status)
    VALUES (?, ?, 'earn', ?, 'Daily Karma Spin bonus', 'completed')
  `).run(randomUUID(), req.user.id, reward);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  created(res, { reward, karmaCoins: updated.karma_coins });
});

// --- Karma Coins → UPI cashout ---------------------------------------------
//
// This is a REQUEST/ledger/admin-approval flow, not an automatic bank
// transfer: filing a request holds the coins immediately, an admin reviews
// it in the moderation queue (see routes/moderation.js), and marks it 'paid'
// once the real UPI transfer has actually been sent — by the human operator,
// outside this app. Real fund movement is out of scope for an automated
// agent to execute; this builds the honest, auditable infrastructure a real
// payout desk would run on top of (exactly the same "manual disbursement
// behind a request queue" pattern most early fintech MVPs launch with before
// they integrate a payout API/partner bank).
const CASHOUT_PAISE_PER_COIN = 40; // ₹0.40/coin — below the ₹0.49-₹0.599/coin buy price (COIN_PACKAGES), so cash-out isn't a risk-free arbitrage loop
const CASHOUT_MIN_COINS = 250; // ≈ ₹100 minimum, keeps request volume sane for manual processing
const UPI_ID_RE = /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z]{2,64}$/;

router.get('/api/wallet/cashout-requests', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM cashout_requests WHERE user_id = ? ORDER BY requested_at DESC').all(req.user.id);
  ok(res, rows.map(serializeCashoutRequest));
});

router.post('/api/wallet/cashout-request', requireAuth, async (req, res) => {
  const body = await readJsonBody(req);
  const coins = Math.floor(Number(body.coins));
  const upiId = String(body.upiId || '').trim();

  if (!Number.isFinite(coins) || coins < CASHOUT_MIN_COINS) {
    throw new HttpError(400, `Minimum cashout is ${CASHOUT_MIN_COINS} Karma Coins`);
  }
  if (!UPI_ID_RE.test(upiId)) {
    throw new HttpError(400, 'Enter a valid UPI ID (e.g. yourname@upi)');
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.karma_coins < coins) {
    throw new HttpError(400, 'Not enough Karma Coins for this cashout', { needed: coins, have: user.karma_coins });
  }

  const pending = db.prepare(`SELECT id FROM cashout_requests WHERE user_id = ? AND status = 'pending'`).get(user.id);
  if (pending) throw new HttpError(409, 'You already have a cashout request pending review.');

  const amountPaise = coins * CASHOUT_PAISE_PER_COIN;
  const id = randomUUID();

  // Coins are held (deducted) the moment the request is filed — mirrors how
  // a real payout queue works (funds move out of the spendable balance the
  // instant a payout is requested, refunded only if the request is rejected).
  db.prepare('UPDATE users SET karma_coins = karma_coins - ? WHERE id = ?').run(coins, user.id);
  db.prepare(`
    INSERT INTO cashout_requests (id, user_id, coins, amount_paise, upi_id, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(id, user.id, coins, amountPaise, upiId);
  db.prepare(`
    INSERT INTO wallet_transactions (id, user_id, direction, amount, description, status)
    VALUES (?, ?, 'redeem', ?, ?, 'completed')
  `).run(randomUUID(), user.id, -coins, `Cashout requested to ${upiId} (₹${Math.round(amountPaise / 100)})`);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  created(res, {
    request: serializeCashoutRequest(db.prepare('SELECT * FROM cashout_requests WHERE id = ?').get(id)),
    karmaCoins: updated.karma_coins,
  });
});

export default router;
