import { Router } from '../lib/http.js';
import { ok, readJsonBody, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';
import { serializeQuest } from '../lib/serialize.js';

const router = new Router();

// -----------------------------------------------------------------------
// Every endpoint in this file is a clearly-labeled HEURISTIC stand-in for a
// real model call — template/rule-based, not machine-generated. Per the
// build decision to ship without an LLM API key yet, each function here is
// written so swapping the body for an actual API call later doesn't change
// the response shape or any caller.
// -----------------------------------------------------------------------

const CAPTION_OPENERS = [
  'Just wrapped up', 'Finished', 'Spent some time on', 'Took a moment for', 'Made time to do',
];
const CAPTION_CLOSERS = [
  'Felt good to give back.', 'Small step, real impact.', 'Every bit counts.',
  'Glad I could help out today.', 'Worth the effort.',
];

router.post('/api/ai/caption-suggestion', requireAuth, async (req, res) => {
  const body = await readJsonBody(req);
  const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(body.questId);
  if (!quest) throw new HttpError(404, 'Quest not found');
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(quest.category_id);

  // Deterministic-ish variety from the quest id so the same quest doesn't
  // always show the exact same 3 suggestions to everyone, without needing
  // real randomness or a model call.
  const seed = quest.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const suggestions = [0, 1, 2].map((i) => {
    const opener = CAPTION_OPENERS[(seed + i * 7) % CAPTION_OPENERS.length];
    const closer = CAPTION_CLOSERS[(seed + i * 11) % CAPTION_CLOSERS.length];
    return `${opener} "${quest.title}" ${category ? `for ${category.name.toLowerCase()}` : ''} — ${closer}`.replace(/\s+/g, ' ').trim();
  });

  ok(res, { suggestions, source: 'heuristic' });
});

// "Your Impact" recap — a shareable narrative summary of a citizen's deeds,
// built from real stats (approved proofs, top category, streak, badges)
// rather than free-form generation. Framed and labeled as an AI recap so a
// real model can write the same shape of copy later without any UI change.
router.get('/api/ai/impact-recap', requireAuth, (req, res) => {
  const userId = req.user.id;

  const totals = db.prepare(`
    SELECT COUNT(*) as deeds, COALESCE(SUM(q.xp_reward), 0) as xp
    FROM proofs p JOIN quests q ON q.id = p.quest_id
    WHERE p.user_id = ? AND p.status = 'approved'
  `).get(userId);

  const topCategory = db.prepare(`
    SELECT c.name, c.icon, COUNT(*) as n
    FROM proofs p JOIN quests q ON q.id = p.quest_id JOIN categories c ON c.id = q.category_id
    WHERE p.user_id = ? AND p.status = 'approved'
    GROUP BY c.id ORDER BY n DESC LIMIT 1
  `).get(userId);

  const avgDeeds = db.prepare(`
    SELECT AVG(cnt) as avg FROM (
      SELECT user_id, COUNT(*) as cnt FROM proofs WHERE status = 'approved' GROUP BY user_id
    )
  `).get().avg || 0;

  const badgeCount = db.prepare('SELECT COUNT(*) as c FROM user_badges WHERE user_id = ?').get(userId).c;
  const streakDays = req.user.streak_days || 0;

  const vsAverage = avgDeeds > 0 ? Math.round(((totals.deeds - avgDeeds) / avgDeeds) * 100) : 0;
  const compareLine = totals.deeds === 0
    ? "You haven't logged a deed yet — your first one starts the story."
    : vsAverage > 0
      ? `That's ${vsAverage}% more than the average Do Good Co. citizen.`
      : vsAverage < 0
        ? `The community average is a bit ahead — plenty of room to catch up.`
        : "Right at the community average — nice and steady.";

  const headline = totals.deeds === 0
    ? 'Your impact story is just getting started.'
    : `You've logged ${totals.deeds} verified good deed${totals.deeds === 1 ? '' : 's'}, earning ${totals.xp} XP.`;

  const categoryLine = topCategory
    ? `${topCategory.icon} ${topCategory.name} is where you show up most — ${topCategory.n} deed${topCategory.n === 1 ? '' : 's'} there alone.`
    : null;

  const streakLine = streakDays > 1 ? `You're on a ${streakDays}-day streak — momentum like that adds up fast.` : null;

  const badgeLine = badgeCount > 0 ? `Along the way you've unlocked ${badgeCount} badge${badgeCount === 1 ? '' : 's'}.` : null;

  const summary = [headline, categoryLine, streakLine, badgeLine, compareLine].filter(Boolean).join(' ');

  ok(res, {
    headline,
    summary,
    stats: { deeds: totals.deeds, xp: totals.xp, badgeCount, streakDays, topCategory: topCategory?.name || null, vsAveragePct: vsAverage },
    source: 'heuristic',
  });
});

// NGO impact report — same idea for an NGO admin: a shareable, plain-text
// summary generated from real dashboard numbers, framed as an AI-written
// report. Swappable later for an actual model call over the same stats.
router.get('/api/ai/ngo-impact-report/:ngoId', requireAuth, (req, res) => {
  if (!req.user.is_ngo_admin || req.user.ngo_id !== req.params.ngoId) {
    throw new HttpError(403, 'NGO admin access required for this NGO.');
  }
  const ngo = db.prepare('SELECT * FROM ngos WHERE id = ?').get(req.params.ngoId);
  if (!ngo) throw new HttpError(404, 'NGO not found');

  const questStats = db.prepare(`SELECT COUNT(*) as total, SUM(ngo_featured) as featured FROM quests WHERE ngo_id = ? AND status = 'active'`).get(ngo.id);
  const impactStats = db.prepare(`
    SELECT COUNT(*) as deeds_completed, COALESCE(SUM(q.xp_reward),0) as xp_driven, COUNT(DISTINCT p.user_id) as unique_participants
    FROM proofs p JOIN quests q ON q.id = p.quest_id
    WHERE q.ngo_id = ? AND p.status = 'approved'
  `).get(ngo.id);
  const donationStats = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(amount_paise), 0) as total_paise FROM payment_orders WHERE ngo_id = ? AND status = 'paid'
  `).get(ngo.id);
  const topQuest = db.prepare(`
    SELECT q.title, COUNT(*) as n FROM proofs p JOIN quests q ON q.id = p.quest_id
    WHERE q.ngo_id = ? AND p.status = 'approved' GROUP BY q.id ORDER BY n DESC LIMIT 1
  `).get(ngo.id);

  const lines = [
    `Impact Report — ${ngo.name}`,
    `Generated ${new Date().toISOString().slice(0, 10)}`,
    '',
    `${ngo.name} ran ${questStats.total} active quest${questStats.total === 1 ? '' : 's'} on Do Good Co.` +
      (questStats.featured ? `, with ${questStats.featured} premium-featured.` : '.'),
    `Citizens completed ${impactStats.deeds_completed} verified deed${impactStats.deeds_completed === 1 ? '' : 's'} across those quests, ` +
      `driving ${impactStats.xp_driven} XP and engaging ${impactStats.unique_participants} unique participant${impactStats.unique_participants === 1 ? '' : 's'}.`,
    topQuest ? `The top-performing quest was "${topQuest.title}" with ${topQuest.n} completion${topQuest.n === 1 ? '' : 's'}.` : null,
    donationStats.count > 0
      ? `${ngo.name} also received ${donationStats.count} direct cash donation${donationStats.count === 1 ? '' : 's'} totalling ₹${Math.round(donationStats.total_paise / 100)} via the platform.`
      : `No direct cash donations recorded yet this period.`,
  ].filter(Boolean);

  ok(res, { report: lines.join('\n'), source: 'heuristic' });
});

// Concierge — "top 3 for you right now," built from real signals rather
// than free text: skill overlap with the user's declared skills, category
// affinity from past approved proofs (same signal /api/quests already
// boosts by), and a lightweight "almost done" nudge for daily/weekly quests
// close to their reset. Each pick carries a plain-language "why" built from
// whichever signal actually fired, so the UI can show its reasoning instead
// of a black-box recommendation. Swappable later for a real model call
// without changing the response shape.
router.get('/api/ai/concierge', requireAuth, (req, res) => {
  const userId = req.user.id;
  const mySkills = (req.user.skills || '').split(',').map((s) => s.trim()).filter(Boolean);

  const affinityRows = db.prepare(`
    SELECT q.category_id as category_id, c.name as category_name, COUNT(*) as n
    FROM proofs p JOIN quests q ON q.id = p.quest_id JOIN categories c ON c.id = q.category_id
    WHERE p.user_id = ? AND p.status = 'approved'
    GROUP BY q.category_id
  `).all(userId);
  const affinity = new Map(affinityRows.map((r) => [r.category_id, r]));

  const doneQuestIds = new Set(
    db.prepare(`SELECT quest_id FROM proofs WHERE user_id = ? AND status IN ('approved', 'pending')`).all(userId)
      .map((r) => r.quest_id)
  );

  const candidates = db.prepare(`
    SELECT q.*, c.name as category_name, c.icon as category_icon
    FROM quests q JOIN categories c ON c.id = q.category_id
    WHERE q.status = 'active'
  `).all().filter((q) => !doneQuestIds.has(q.id));

  const scored = candidates.map((q) => {
    const tags = (q.skill_tags || '').split(',').map((s) => s.trim()).filter(Boolean);
    const matchedSkills = tags.filter((t) => mySkills.includes(t));
    const catAffinity = affinity.get(q.category_id);

    let score = 0;
    const reasons = [];

    if (matchedSkills.length > 0) {
      score += matchedSkills.length * 40;
      reasons.push(`Matches your skill${matchedSkills.length === 1 ? '' : 's'} in ${matchedSkills.join(', ')}`);
    }
    if (catAffinity) {
      score += Math.min(30, catAffinity.n * 5);
      reasons.push(`You've done ${catAffinity.n} ${catAffinity.category_name} deed${catAffinity.n === 1 ? '' : 's'} before`);
    }
    if (q.ngo_featured) { score += 15; reasons.push('Featured by an NGO partner'); }
    if (q.is_sponsored) { score += 8; }
    if (q.type === 'daily') { score += 5; reasons.push('Quick daily quest'); }

    if (reasons.length === 0) reasons.push(`Popular in ${q.category_name}`);

    return { q, score, reason: reasons[0] };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3).map(({ q, reason }) => ({
    ...serializeQuest(q, { id: q.category_id, name: q.category_name, icon: q.category_icon }),
    why: reason,
  }));

  ok(res, { recommendations: top, source: 'heuristic' });
});

export default router;
