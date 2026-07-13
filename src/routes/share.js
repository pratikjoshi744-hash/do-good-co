import { Router } from '../lib/http.js';
import { db } from '../db/connection.js';

const router = new Router();

// The client is a build-free SPA that routes on the URL hash
// (…#/passport/:id), and hash fragments never reach the server — so a raw
// app link always unfurls in WhatsApp/iMessage/Telegram as the same generic
// "Do Good Co." preview, whatever data is behind it. These routes are a
// tiny server-rendered detour that exists only to be *read*, not visited:
// give the link-preview crawler real Open Graph tags built from the actual
// record, then bounce an actual human straight into the live app. This is
// the practical, no-account-needed substitute for a WhatsApp Business API
// bot — it rides the user's own WhatsApp instead of Do Good Co. operating one.
const CLIENT_URL = (process.env.CLIENT_URL || 'https://do-good-co.netlify.app').replace(/\/$/, '');

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function unfurlPage({ title, description, redirectTo }) {
  const t = escapeHtml(title);
  const d = escapeHtml(description);
  const url = escapeHtml(redirectTo);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="Do Good Co.">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta http-equiv="refresh" content="0; url=${url}">
<script>window.location.replace(${JSON.stringify(redirectTo)});</script>
</head>
<body style="font-family: system-ui, sans-serif; padding: 40px; text-align: center; color: #333;">
<p>${t}</p>
<p><a href="${url}">Open in Do Good Co. →</a></p>
</body>
</html>`;
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
}

router.get('/share/passport/:userId', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!user) return sendHtml(res, 404, unfurlPage({ title: 'Passport not found', description: 'This Impact Passport does not exist.', redirectTo: CLIENT_URL }));

  const totals = db.prepare(`
    SELECT COUNT(*) as deeds, COALESCE(SUM(q.xp_reward), 0) as xp
    FROM proofs p JOIN quests q ON q.id = p.quest_id
    WHERE p.user_id = ? AND p.status = 'approved'
  `).get(user.id);

  const title = `${user.name}'s Impact Passport — Do Good Co.`;
  const description = totals.deeds > 0
    ? `${totals.deeds} verified good deed${totals.deeds === 1 ? '' : 's'}, ${totals.xp} XP earned, ${user.trust_score}/100 trust score. Real, checked good deeds — not self-reported.`
    : `${user.name} is building a verified record of real good deeds on Do Good Co.`;

  sendHtml(res, 200, unfurlPage({ title, description, redirectTo: `${CLIENT_URL}/#/passport/${user.id}` }));
});

router.get('/share/quest/:id', (req, res) => {
  const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(req.params.id);
  if (!quest) return sendHtml(res, 404, unfurlPage({ title: 'Quest not found', description: 'This quest does not exist.', redirectTo: CLIENT_URL }));

  const title = `${quest.title} — Do Good Co.`;
  const description = `${quest.description || 'A real good deed you can do nearby.'} Earn ${quest.xp_reward} XP and ${quest.coin_reward} Karma Coins for doing it — verified, not just posted about.`;

  sendHtml(res, 200, unfurlPage({ title, description, redirectTo: `${CLIENT_URL}/#/quests/${quest.id}` }));
});

router.get('/share/institution/:id', (req, res) => {
  const inst = db.prepare('SELECT * FROM institutions WHERE id = ?').get(req.params.id);
  if (!inst) return sendHtml(res, 404, unfurlPage({ title: 'Group not found', description: 'This group does not exist.', redirectTo: CLIENT_URL }));

  const title = `Join ${inst.name} on Do Good Co.`;
  const description = `${inst.name} is tracking verified good deeds together on Do Good Co. Use join code ${inst.join_code} to add your deeds to the group leaderboard.`;

  sendHtml(res, 200, unfurlPage({ title, description, redirectTo: `${CLIENT_URL}/#/institution` }));
});

export default router;
