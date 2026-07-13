import { randomUUID } from 'node:crypto';
import { Router } from '../lib/http.js';
import { ok, created, readJsonBody, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { serializeInstitution, serializeUser } from '../lib/serialize.js';
import { requireAuth } from '../middleware/auth.js';

const router = new Router();

const TYPES = ['school', 'college', 'corporate', 'society'];
const TYPE_ICON = { school: '🏫', college: '🎓', corporate: '🏢', society: '🏘️' };

function generateJoinCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function memberCount(institutionId) {
  return db.prepare('SELECT COUNT(*) as c FROM users WHERE institution_id = ?').get(institutionId).c;
}

// Creating an institution makes the creator its admin — a teacher standing
// up a School Chapter, an HR lead standing up a Corporate volunteering
// group, or a housing society secretary formalizing their RWA. Everyone
// else joins with the generated code, same shape as the existing invite
// system so it feels familiar.
router.post('/api/institutions', requireAuth, async (req, res) => {
  const body = await readJsonBody(req);
  const name = String(body.name || '').trim();
  const type = TYPES.includes(body.type) ? body.type : 'school';
  if (!name) throw new HttpError(400, 'name is required');

  const id = randomUUID();
  let joinCode = generateJoinCode();
  while (db.prepare('SELECT id FROM institutions WHERE join_code = ?').get(joinCode)) joinCode = generateJoinCode();

  db.prepare(`
    INSERT INTO institutions (id, name, type, join_code, icon, admin_user_id) VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, type, joinCode, TYPE_ICON[type], req.user.id);
  db.prepare('UPDATE users SET institution_id = ? WHERE id = ?').run(id, req.user.id);

  const row = db.prepare('SELECT * FROM institutions WHERE id = ?').get(id);
  created(res, serializeInstitution(row, { memberCount: memberCount(id), isAdmin: true }));
});

router.post('/api/institutions/join', requireAuth, async (req, res) => {
  const body = await readJsonBody(req);
  const code = String(body.joinCode || '').trim().toUpperCase();
  const institution = db.prepare('SELECT * FROM institutions WHERE join_code = ?').get(code);
  if (!institution) throw new HttpError(404, "No institution found for that code — double check it and try again.");

  db.prepare('UPDATE users SET institution_id = ? WHERE id = ?').run(institution.id, req.user.id);
  ok(res, serializeInstitution(institution, { memberCount: memberCount(institution.id), isAdmin: institution.admin_user_id === req.user.id }));
});

router.post('/api/institutions/leave', requireAuth, async (req, res) => {
  db.prepare('UPDATE users SET institution_id = NULL WHERE id = ?').run(req.user.id);
  ok(res, { left: true });
});

router.get('/api/institutions/me', requireAuth, (req, res) => {
  if (!req.user.institution_id) return ok(res, null);
  const institution = db.prepare('SELECT * FROM institutions WHERE id = ?').get(req.user.institution_id);
  if (!institution) return ok(res, null);
  ok(res, serializeInstitution(institution, { memberCount: memberCount(institution.id), isAdmin: institution.admin_user_id === req.user.id }));
});

// Member leaderboard, same shape as the mohalla leaderboard so the client
// can reuse a familiar ranked-list UI.
router.get('/api/institutions/:id/leaderboard', requireAuth, (req, res) => {
  const institution = db.prepare('SELECT * FROM institutions WHERE id = ?').get(req.params.id);
  if (!institution) throw new HttpError(404, 'Institution not found');

  const rows = db.prepare(`
    SELECT u.*, COUNT(p.id) as deeds_completed
    FROM users u
    LEFT JOIN proofs p ON p.user_id = u.id AND p.status = 'approved'
    WHERE u.institution_id = ?
    GROUP BY u.id
    ORDER BY u.xp DESC LIMIT 100
  `).all(institution.id);

  ok(res, {
    institution: serializeInstitution(institution, { memberCount: rows.length, isAdmin: institution.admin_user_id === req.user.id }),
    leaderboard: rows.map((u, i) => ({ rank: i + 1, deedsCompleted: u.deeds_completed, ...serializeUser(u) })),
  });
});

// The NSS-credit-style export: total approved-deed hours per member, the
// actual artifact a teacher or CSR lead needs to hand to an administrator
// for admissions/scholarship or compliance credit. estimated_minutes on
// each quest is what turns deed *counts* into defensible *hours*.
router.get('/api/institutions/:id/report', requireAuth, (req, res) => {
  const institution = db.prepare('SELECT * FROM institutions WHERE id = ?').get(req.params.id);
  if (!institution) throw new HttpError(404, 'Institution not found');
  if (institution.admin_user_id !== req.user.id) throw new HttpError(403, 'Only this institution\'s admin can pull its report.');

  const rows = db.prepare(`
    SELECT u.id, u.name, u.avatar, COUNT(p.id) as deeds_completed,
           COALESCE(SUM(q.estimated_minutes), 0) as total_minutes,
           COALESCE(SUM(q.xp_reward), 0) as total_xp
    FROM users u
    LEFT JOIN proofs p ON p.user_id = u.id AND p.status = 'approved'
    LEFT JOIN quests q ON q.id = p.quest_id
    WHERE u.institution_id = ?
    GROUP BY u.id ORDER BY total_minutes DESC
  `).all(institution.id);

  ok(res, {
    institution: serializeInstitution(institution, { memberCount: rows.length, isAdmin: true }),
    generatedAt: new Date().toISOString(),
    members: rows.map((r) => ({
      id: r.id, name: r.name, avatar: r.avatar,
      deedsCompleted: r.deeds_completed,
      totalHours: Math.round((r.total_minutes / 60) * 10) / 10,
      totalXp: r.total_xp,
    })),
  });
});

export default router;
