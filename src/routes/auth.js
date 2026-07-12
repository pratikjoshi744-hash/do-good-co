import { randomUUID } from 'node:crypto';
import { Router } from '../lib/http.js';
import { ok, created, fail, readJsonBody, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { serializeUser } from '../lib/serialize.js';
import { requireAuth } from '../middleware/auth.js';
import { genReferralCode, pick, AVATARS } from '../db/seed.js';

const router = new Router();

const SIGNUP_BONUS_COINS = 20;
const REFERRAL_BONUS_COINS = 25;

// Demo directory of accounts a client can log into instantly - stands in for
// real OTP/phone auth. Any of these phone numbers logs in with no password,
// which is exactly what a client demo needs; swap for real OTP verification
// against the same /api/auth/login contract later.
router.get('/api/auth/demo-accounts', (req, res) => {
  // Always surface the "hero" personas (You, the moderator, and every CSR admin)
  // regardless of XP, so a pitch demo never has to hunt for them, then fill
  // remaining slots with the highest-XP regular citizens for variety.
  const rows = db.prepare(`
    SELECT * FROM users
    ORDER BY
      is_admin DESC,
      is_csr_admin DESC,
      is_ngo_admin DESC,
      CASE WHEN id = 'demo-user-you' THEN 1 ELSE 0 END DESC,
      xp DESC
    LIMIT 11
  `).all();
  ok(res, rows.map((u) => ({
    phone: u.phone,
    name: u.name,
    avatar: u.avatar,
    isAdmin: !!u.is_admin,
    isCsrAdmin: !!u.is_csr_admin,
    isNgoAdmin: !!u.is_ngo_admin,
  })));
});

router.post('/api/auth/login', async (req, res) => {
  const body = await readJsonBody(req);
  const phone = String(body.phone || '').trim();
  if (!phone) throw new HttpError(400, 'phone is required');

  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user) throw new HttpError(404, "We couldn't find an account with that phone number.");

  const token = randomUUID();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
  created(res, { token, user: serializeUser(user, { includeContact: true }) });
});

// Real account creation - used by the Login screen's "no account found, want
// to create one?" fallback, and by the Invite flow (a referral code just
// pre-fills who gets credit). There's still no real SMS/OTP provider wired
// up (see the login route above), so phone verification stays client-side
// simulated for now; this endpoint is the actual persistence layer for it.
router.post('/api/auth/signup', async (req, res) => {
  const body = await readJsonBody(req);
  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').trim();
  const mohalla = String(body.mohalla || '').trim();
  const city = String(body.city || '').trim();
  const referralCode = String(body.referralCode || '').trim().toUpperCase();

  if (!name) throw new HttpError(400, 'Name is required');
  if (!phone) throw new HttpError(400, 'Phone number is required');
  if (!mohalla) throw new HttpError(400, 'Neighbourhood is required');
  if (!city) throw new HttpError(400, 'City is required');

  const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (existing) throw new HttpError(409, 'An account with that phone number already exists — try logging in instead.');

  let inviter = null;
  if (referralCode) {
    inviter = db.prepare('SELECT * FROM users WHERE referral_code = ?').get(referralCode);
    if (!inviter) throw new HttpError(400, "That invite code doesn't look right — double check it, or sign up without one.");
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO users (id, name, phone, avatar, mohalla, city, xp, karma_coins, trust_score, streak_days, is_admin, is_csr_admin, is_ngo_admin, company_id, ngo_id, referral_code, invited_by)
    VALUES (@id, @name, @phone, @avatar, @mohalla, @city, 0, @karma_coins, 70, 0, 0, 0, 0, NULL, NULL, @referral_code, @invited_by)
  `).run({
    id,
    name,
    phone,
    avatar: pick(AVATARS),
    mohalla,
    city,
    karma_coins: SIGNUP_BONUS_COINS,
    referral_code: genReferralCode(),
    invited_by: inviter?.id ?? null,
  });

  db.prepare(`
    INSERT INTO wallet_transactions (id, user_id, direction, amount, description, status)
    VALUES (?, ?, 'earn', ?, 'Welcome bonus', 'completed')
  `).run(randomUUID(), id, SIGNUP_BONUS_COINS);

  if (inviter) {
    db.prepare(`UPDATE users SET karma_coins = karma_coins + ? WHERE id = ?`).run(REFERRAL_BONUS_COINS, inviter.id);
    db.prepare(`
      INSERT INTO wallet_transactions (id, user_id, direction, amount, description, status)
      VALUES (?, ?, 'earn', ?, ?, 'completed')
    `).run(randomUUID(), inviter.id, REFERRAL_BONUS_COINS, `${name} joined using your invite!`);
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const token = randomUUID();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, id);
  created(res, { token, user: serializeUser(user, { includeContact: true }), invitedBy: inviter ? { id: inviter.id, name: inviter.name } : null });
});

router.post('/api/auth/logout', requireAuth, async (req, res) => {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  ok(res, { loggedOut: true });
});

router.get('/api/auth/me', requireAuth, async (req, res) => {
  ok(res, serializeUser(req.user, { includeContact: true }));
});

export default router;
