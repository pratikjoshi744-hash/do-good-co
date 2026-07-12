import { Router } from '../lib/http.js';
import { ok } from '../lib/http.js';
import { db } from '../db/connection.js';
import { xpProgress } from '../lib/levels.js';
import { requireAuth } from '../middleware/auth.js';

const router = new Router();

function lightUser(u) {
  const progress = xpProgress(u.xp);
  return {
    id: u.id,
    name: u.name,
    avatar: u.avatar,
    mohalla: u.mohalla,
    city: u.city,
    level: progress.level,
    tier: progress.tier,
    tierColor: progress.tierColor,
    trustScore: u.trust_score,
  };
}

function lightNgo(n) {
  return { id: n.id, name: n.name, logo: n.logo, mission: n.mission, isPremium: !!n.is_premium, verified: !!n.verified };
}

function lightCompany(c) {
  return { id: c.id, name: c.name, logo: c.logo, industry: c.industry };
}

// One box, three result buckets - people to rival/message, NGOs to see what
// they're running, companies to see who's sponsoring quests. With no query
// this returns a "discover" default (top people by XP + every NGO/company)
// so the Search tab never opens to an empty state.
router.get('/api/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  const type = String(req.query.type || 'all');
  const like = `%${q.replace(/[%_]/g, '')}%`;

  const result = {};

  if (type === 'all' || type === 'people') {
    const rows = q
      ? db.prepare(`
          SELECT * FROM users
          WHERE id != ? AND is_csr_admin = 0 AND is_ngo_admin = 0
            AND (name LIKE ? COLLATE NOCASE OR mohalla LIKE ? COLLATE NOCASE OR city LIKE ? COLLATE NOCASE)
          ORDER BY xp DESC LIMIT 25
        `).all(req.user.id, like, like, like)
      : db.prepare(`
          SELECT * FROM users WHERE id != ? AND is_csr_admin = 0 AND is_ngo_admin = 0
          ORDER BY xp DESC LIMIT 12
        `).all(req.user.id);
    result.people = rows.map(lightUser);
  }

  if (type === 'all' || type === 'ngos') {
    const rows = q
      ? db.prepare(`SELECT * FROM ngos WHERE name LIKE ? COLLATE NOCASE OR mission LIKE ? COLLATE NOCASE ORDER BY name LIMIT 25`).all(like, like)
      : db.prepare(`SELECT * FROM ngos ORDER BY name LIMIT 25`).all();
    result.ngos = rows.map(lightNgo);
  }

  if (type === 'all' || type === 'companies') {
    const rows = q
      ? db.prepare(`SELECT * FROM companies WHERE name LIKE ? COLLATE NOCASE OR industry LIKE ? COLLATE NOCASE ORDER BY name LIMIT 25`).all(like, like)
      : db.prepare(`SELECT * FROM companies ORDER BY name LIMIT 25`).all();
    result.companies = rows.map(lightCompany);
  }

  ok(res, result);
});

export default router;
