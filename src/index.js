import http from 'node:http';
import { URL } from 'node:url';
import { seedIfEmpty, backfillMissingMedia, backfillReferralCodes, regenerateMediaIfStale, backfillSkillTags, backfillKarmaCards } from './db/seed.js';
import { Router, ok, fail } from './lib/http.js';

import authRoutes from './routes/auth.js';
import categoryRoutes from './routes/categories.js';
import questRoutes from './routes/quests.js';
import leaderboardRoutes from './routes/leaderboard.js';
import walletRoutes from './routes/wallet.js';
import profileRoutes from './routes/profile.js';
import moderationRoutes from './routes/moderation.js';
import csrRoutes from './routes/csr.js';
import ngoRoutes from './routes/ngo.js';
import messageRoutes from './routes/messages.js';
import townRoutes from './routes/town.js';
import mapRoutes from './routes/map.js';
import rivalRoutes from './routes/rivals.js';
import bossQuestRoutes from './routes/bossQuest.js';
import searchRoutes from './routes/search.js';
import inviteRoutes from './routes/invite.js';
import karmaMatchRoutes from './routes/karmaMatch.js';
import arcadeRoutes from './routes/arcade.js';
import socialRoutes from './routes/social.js';
import campaignRoutes from './routes/campaigns.js';
import paymentRoutes from './routes/payments.js';
import aiRoutes from './routes/ai.js';
import institutionRoutes from './routes/institutions.js';
import passportRoutes from './routes/passport.js';
import shareRoutes from './routes/share.js';
import relayRoutes from './routes/relays.js';
import cardRoutes from './routes/cards.js';
import radarRoutes from './routes/radar.js';
import civicRoutes from './routes/civic.js';

const PORT = process.env.PORT || 4000;

let seedResult;
try {
  seedResult = seedIfEmpty();
} catch (err) {
  console.error('');
  console.error('Do Good Co. failed to start while preparing its database.');
  console.error('This usually means server/data/karmaquest.sqlite was created by an older');
  console.error('version of the app and is missing newer columns/tables.');
  console.error('Fix: quit this window, delete server/data/karmaquest.sqlite (and the');
  console.error('matching -journal file if present), then relaunch — it will reseed fresh.');
  console.error('');
  console.error('Underlying error:', err.message);
  process.exit(1);
}
if (seedResult.seeded) {
  console.log(`Seeded demo data: ${seedResult.users} users, ${seedResult.quests} quests, ${seedResult.companies} CSR companies, ${seedResult.ngos} NGO partners.`);
} else {
  console.log('Database already seeded — reusing existing data (delete server/data/karmaquest.sqlite to reset).');
}

// Catch up any pre-existing database that was seeded before dummy photos/
// videos existed in the feed — without this, an install from before that
// change would show an empty/emoji-only feed forever.
const mediaBackfill = backfillMissingMedia();
if (mediaBackfill.backfilled > 0) {
  console.log(`Backfilled dummy photos/videos onto ${mediaBackfill.backfilled} existing proof(s).`);
}

const mediaRegen = regenerateMediaIfStale();
if (mediaRegen.regenerated > 0) {
  console.log(`Refreshed the dummy media pool: replaced photos/videos on ${mediaRegen.regenerated} proof(s) with the new set.`);
}

const referralBackfill = backfillReferralCodes();
if (referralBackfill.backfilled > 0) {
  console.log(`Backfilled referral codes onto ${referralBackfill.backfilled} existing user(s).`);
}

const skillTagBackfill = backfillSkillTags();
if (skillTagBackfill.backfilled > 0) {
  console.log(`Backfilled skill tags onto ${skillTagBackfill.backfilled} existing quest(s).`);
}

const cardBackfill = backfillKarmaCards();
if (cardBackfill.backfilled > 0) {
  console.log(`Seeded ${cardBackfill.backfilled} Karma Card(s) into the collectible catalog.`);
}

const router = new Router();
[authRoutes, categoryRoutes, questRoutes, leaderboardRoutes, walletRoutes, profileRoutes, moderationRoutes, csrRoutes, ngoRoutes, messageRoutes, townRoutes, mapRoutes, rivalRoutes, bossQuestRoutes, searchRoutes, inviteRoutes, karmaMatchRoutes, arcadeRoutes, socialRoutes, campaignRoutes, paymentRoutes, aiRoutes, institutionRoutes, passportRoutes, shareRoutes, relayRoutes, cardRoutes, radarRoutes, civicRoutes].forEach((r) => {
  router.routes.push(...r.routes);
});

router.get('/api/health', (req, res) => ok(res, { status: 'ok', service: 'do-good-co-api', time: new Date().toISOString() }));

const server = http.createServer(async (req, res) => {
  // CORS - wide open for local MVP demo purposes.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const query = Object.fromEntries(url.searchParams.entries());

  try {
    const handled = await router.handle(req, res, url.pathname, query);
    if (!handled) fail(res, 404, `No route for ${req.method} ${url.pathname}`);
  } catch (err) {
    console.error('Unhandled error:', err);
    if (!res.writableEnded) fail(res, 500, 'Internal server error');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`Port ${PORT} is already in use — another Do Good Co. server (or something`);
    console.error('else) is already listening there.');
    console.error(`Fix: quit any other Do Good Co. window, or run this to free the port:`);
    console.error(`  lsof -ti:${PORT} | xargs kill -9`);
    console.error('then relaunch.');
    console.error('');
  } else {
    console.error('Do Good Co. API failed to start:', err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Do Good Co. API listening on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
