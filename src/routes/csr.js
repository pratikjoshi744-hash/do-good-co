import { randomUUID } from 'node:crypto';
import { Router } from '../lib/http.js';
import { ok, created, readJsonBody, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { serializeCompany, serializeQuest, serializeUser } from '../lib/serialize.js';
import { requireAuth } from '../middleware/auth.js';

const router = new Router();

function requireCsrAdmin(req, res, next) {
  if (!req.user?.is_csr_admin || !req.user?.company_id) {
    throw new HttpError(403, 'CSR admin access required.');
  }
  next();
}

function getCompanyOr404(companyId) {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
  if (!company) throw new HttpError(404, 'Company not found');
  return company;
}

router.get('/api/csr/company', requireAuth, requireCsrAdmin, (req, res) => {
  ok(res, serializeCompany(getCompanyOr404(req.user.company_id)));
});

// Dashboard summary: sponsored quest count, employees engaged, deeds completed,
// XP/coins contributed, and a rough "CSR value delivered" estimate.
router.get('/api/csr/dashboard', requireAuth, requireCsrAdmin, (req, res) => {
  const companyId = req.user.company_id;
  const company = getCompanyOr404(companyId);

  const questStats = db.prepare(`
    SELECT COUNT(*) as active_quests FROM quests WHERE company_id = ? AND status = 'active'
  `).get(companyId);

  const completionStats = db.prepare(`
    SELECT
      COUNT(*) as deeds_completed,
      COUNT(DISTINCT p.user_id) as unique_participants,
      COALESCE(SUM(q.xp_reward), 0) as total_xp,
      COALESCE(SUM(q.coin_reward), 0) as total_coins
    FROM proofs p
    JOIN quests q ON q.id = p.quest_id
    WHERE q.company_id = ? AND p.status = 'approved'
  `).get(companyId);

  const employeeStats = db.prepare(`
    SELECT COUNT(*) as total_employees FROM users WHERE company_id = ?
  `).get(companyId);

  ok(res, {
    company: serializeCompany(company),
    activeSponsoredQuests: questStats.active_quests,
    totalEmployees: employeeStats.total_employees,
    employeesEngaged: completionStats.unique_participants,
    deedsCompleted: completionStats.deeds_completed,
    xpContributed: completionStats.total_xp,
    coinsContributed: completionStats.total_coins,
    monthlyBudgetCoins: company.monthly_budget_coins,
    budgetUtilizedPct: company.monthly_budget_coins
      ? Math.min(100, Math.round((completionStats.total_coins / company.monthly_budget_coins) * 100))
      : 0,
  });
});

router.get('/api/csr/quests', requireAuth, requireCsrAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT q.*, c.slug as category_slug FROM quests q JOIN categories c ON c.id = q.category_id
    WHERE q.company_id = ? ORDER BY q.created_at DESC
  `).all(req.user.company_id);

  const withStats = rows.map((q) => {
    const stats = db.prepare(`
      SELECT COUNT(*) as completions, COUNT(DISTINCT user_id) as unique_participants
      FROM proofs WHERE quest_id = ? AND status = 'approved'
    `).get(q.id);
    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(q.category_id);
    return {
      ...serializeQuest(q, category),
      completions: stats.completions,
      uniqueParticipants: stats.unique_participants,
    };
  });

  ok(res, withStats);
});

router.post('/api/csr/quests', requireAuth, requireCsrAdmin, async (req, res) => {
  const body = await readJsonBody(req);
  const { title, description, categorySlug, xpReward, coinReward, type } = body;
  if (!title || !description || !categorySlug) {
    throw new HttpError(400, 'title, description and categorySlug are required');
  }

  const category = db.prepare('SELECT * FROM categories WHERE slug = ?').get(categorySlug);
  if (!category) throw new HttpError(404, `Unknown category '${categorySlug}'`);

  const company = getCompanyOr404(req.user.company_id);
  const id = randomUUID();
  db.prepare(`
    INSERT INTO quests (id, category_id, title, description, xp_reward, coin_reward, type, difficulty, requires_gps, requires_photo, location_hint, is_sponsored, sponsor_name, company_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'medium', 1, 1, NULL, 1, ?, ?, 'active')
  `).run(
    id,
    category.id,
    title,
    description,
    Number(xpReward) > 0 ? Number(xpReward) : 40,
    Number(coinReward) > 0 ? Number(coinReward) : 80,
    ['daily', 'weekly', 'festival'].includes(type) ? type : 'weekly',
    company.name,
    company.id
  );

  const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(id);
  created(res, serializeQuest(quest, category));
});

router.get('/api/csr/employees', requireAuth, requireCsrAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM proofs p JOIN quests q ON q.id = p.quest_id WHERE p.user_id = u.id AND q.company_id = u.company_id AND p.status = 'approved') as company_deeds
    FROM users u WHERE u.company_id = ? ORDER BY u.xp DESC
  `).all(req.user.company_id);

  ok(res, rows.map((u) => ({ ...serializeUser(u), companyDeeds: u.company_deeds })));
});

export default router;
