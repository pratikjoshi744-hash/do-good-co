import { randomUUID, createHmac } from 'node:crypto';
import { Router } from '../lib/http.js';
import { ok, created, readJsonBody, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';
import { serializeNgo } from '../lib/serialize.js';

const router = new Router();

// --- Razorpay integration -------------------------------------------------
// Test-mode key pair, set as real env vars once a Razorpay test account
// exists (see README for setup). Until then every order/verify call below
// runs a clearly-labeled simulated flow so the rest of the payments UI —
// coin top-ups, NGO cash donations, CSR quest sponsorship — can be built,
// demoed, and tested end to end today, and goes live the moment real test
// keys are exported before `node src/index.js` starts.
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || null;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || null;
const LIVE = !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);

const COIN_PACKAGES = [
  { id: 'coins-100', coins: 100, amountPaise: 4900, label: '100 Karma Coins' },
  { id: 'coins-250', coins: 250, amountPaise: 9900, label: '250 Karma Coins' },
  { id: 'coins-600', coins: 600, amountPaise: 19900, label: '600 Karma Coins · Best value' },
  { id: 'coins-1500', coins: 1500, amountPaise: 44900, label: '1500 Karma Coins' },
];

router.get('/api/payments/config', requireAuth, (req, res) => {
  ok(res, { keyId: RAZORPAY_KEY_ID, demoMode: !LIVE, coinPackages: COIN_PACKAGES });
});

async function createRazorpayOrder(amountPaise, receipt) {
  if (!LIVE) {
    return { id: `order_demo_${randomUUID().slice(0, 12)}`, simulated: true };
  }
  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new HttpError(502, `Razorpay order creation failed: ${detail || res.status}`);
  }
  const data = await res.json();
  return { id: data.id, simulated: false };
}

// Single order-creation endpoint parameterized by `type` so the three money
// flows (buy coins, donate cash to an NGO, sponsor a quest as a CSR client)
// share one real Razorpay wiring path instead of three copies of it.
router.post('/api/payments/create-order', requireAuth, async (req, res) => {
  const body = await readJsonBody(req);
  const type = body.type;

  let amountPaise, coins = null, questId = null, ngoId = null;

  if (type === 'coin_topup') {
    const pkg = COIN_PACKAGES.find((p) => p.id === body.packageId);
    if (!pkg) throw new HttpError(400, 'Unknown coin package');
    amountPaise = pkg.amountPaise;
    coins = pkg.coins;
  } else if (type === 'ngo_donation') {
    const ngo = db.prepare('SELECT * FROM ngos WHERE id = ?').get(body.ngoId);
    if (!ngo) throw new HttpError(404, 'NGO not found');
    amountPaise = Math.round(Number(body.amountRupees) * 100);
    if (!amountPaise || amountPaise < 1000) throw new HttpError(400, 'Minimum donation is ₹10');
    ngoId = ngo.id;
  } else if (type === 'quest_sponsorship') {
    if (!req.user.is_csr_admin || !req.user.company_id) throw new HttpError(403, 'CSR admin access required.');
    const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(body.questId);
    if (!quest) throw new HttpError(404, 'Quest not found');
    amountPaise = Math.round(Number(body.amountRupees) * 100);
    if (!amountPaise || amountPaise < 10000) throw new HttpError(400, 'Minimum sponsorship is ₹100');
    questId = quest.id;
  } else {
    throw new HttpError(400, 'Unknown payment type');
  }

  const orderId = randomUUID();
  const razorpayOrder = await createRazorpayOrder(amountPaise, orderId);

  db.prepare(`
    INSERT INTO payment_orders (id, user_id, type, amount_paise, coins, quest_id, ngo_id, razorpay_order_id, status, simulated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created', ?)
  `).run(orderId, req.user.id, type, amountPaise, coins, questId, ngoId, razorpayOrder.id, razorpayOrder.simulated ? 1 : 0);

  created(res, {
    dbOrderId: orderId,
    razorpayOrderId: razorpayOrder.id,
    amountPaise,
    keyId: RAZORPAY_KEY_ID,
    demoMode: razorpayOrder.simulated,
  });
});

function verifySignature(orderId, paymentId, signature) {
  const expected = createHmac('sha256', RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  return expected === signature;
}

router.post('/api/payments/verify', requireAuth, async (req, res) => {
  const body = await readJsonBody(req);
  const order = db.prepare('SELECT * FROM payment_orders WHERE id = ? AND user_id = ?').get(body.dbOrderId, req.user.id);
  if (!order) throw new HttpError(404, 'Order not found');
  if (order.status === 'paid') throw new HttpError(400, 'This order was already completed');

  if (!order.simulated) {
    if (!body.razorpayPaymentId || !body.razorpaySignature) {
      throw new HttpError(400, 'Missing Razorpay payment confirmation');
    }
    const valid = verifySignature(order.razorpay_order_id, body.razorpayPaymentId, body.razorpaySignature);
    if (!valid) {
      db.prepare(`UPDATE payment_orders SET status = 'failed' WHERE id = ?`).run(order.id);
      throw new HttpError(400, 'Payment signature verification failed');
    }
  }

  db.prepare(`
    UPDATE payment_orders SET status = 'paid', razorpay_payment_id = ?, completed_at = datetime('now') WHERE id = ?
  `).run(body.razorpayPaymentId || `demo_pay_${randomUUID().slice(0, 10)}`, order.id);

  let userSnapshot = null;
  if (order.type === 'coin_topup') {
    db.prepare('UPDATE users SET karma_coins = karma_coins + ? WHERE id = ?').run(order.coins, req.user.id);
    db.prepare(`
      INSERT INTO wallet_transactions (id, user_id, direction, amount, description, status)
      VALUES (?, ?, 'earn', ?, ?, 'completed')
    `).run(randomUUID(), req.user.id, order.coins, `Bought ${order.coins} Karma Coins (₹${(order.amount_paise / 100).toFixed(0)})`);
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    userSnapshot = { xp: updated.xp, karmaCoins: updated.karma_coins };
  }

  ok(res, {
    order: {
      id: order.id,
      type: order.type,
      amountPaise: order.amount_paise,
      coins: order.coins,
      status: 'paid',
    },
    userSnapshot,
  });
});

// Real-money donations this NGO has received, for its own dashboard —
// separate from the coin-to-NGO redemption catalog in wallet.js, this is
// citizens paying actual INR straight to the cause via Razorpay.
router.get('/api/payments/ngo/:ngoId/donations', requireAuth, (req, res) => {
  const ngo = db.prepare('SELECT * FROM ngos WHERE id = ?').get(req.params.ngoId);
  if (!ngo) throw new HttpError(404, 'NGO not found');
  const rows = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(amount_paise), 0) as total_paise
    FROM payment_orders WHERE ngo_id = ? AND status = 'paid'
  `).get(ngo.id);
  ok(res, { ngo: serializeNgo(ngo), donationCount: rows.count, totalRupees: Math.round(rows.total_paise / 100) });
});

export default router;
