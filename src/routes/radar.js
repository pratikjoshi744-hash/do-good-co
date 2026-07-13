import { Router } from '../lib/http.js';
import { ok } from '../lib/http.js';
import { db } from '../db/connection.js';

// The "Good Deed Radar" — a public, no-login, TV/projector-friendly feed of
// what's happening right now across the city. Deliberately unauthenticated
// (unlike every other GET in this app) so it can run on a lobby screen or a
// municipal office display without anyone signing in. Only ever exposes
// already-approved, already-public proof data — same fields the regular
// feed shows, no private info.

const router = new Router();

router.get('/api/radar/live', (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.caption, p.media_type, p.media_data, p.submitted_at, p.gps_lat, p.gps_lng,
           u.name as user_name, u.avatar as user_avatar, u.mohalla, u.city,
           q.title as quest_title, c.name as category_name, c.icon as category_icon, c.color as category_color
    FROM proofs p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN quests q ON q.id = p.quest_id
    LEFT JOIN categories c ON c.id = q.category_id
    WHERE p.status = 'approved'
    ORDER BY p.submitted_at DESC LIMIT 40
  `).all();

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const totals = db.prepare(`
    SELECT COUNT(*) as deeds, COUNT(DISTINCT user_id) as citizens
    FROM proofs WHERE status = 'approved' AND submitted_at >= ?
  `).get(since);

  const byCategory = db.prepare(`
    SELECT c.name, c.icon, c.color, COUNT(*) as n
    FROM proofs p
    JOIN quests q ON q.id = p.quest_id
    JOIN categories c ON c.id = q.category_id
    WHERE p.status = 'approved' AND p.submitted_at >= ?
    GROUP BY c.id ORDER BY n DESC LIMIT 6
  `).all(since);

  const activeCities = db.prepare(`
    SELECT u.city, COUNT(*) as n
    FROM proofs p JOIN users u ON u.id = p.user_id
    WHERE p.status = 'approved' AND p.submitted_at >= ? AND u.city != ''
    GROUP BY u.city ORDER BY n DESC LIMIT 8
  `).all(since);

  ok(res, {
    generatedAt: new Date().toISOString(),
    last24h: { deeds: totals.deeds, citizens: totals.citizens },
    byCategory: byCategory.map((c) => ({ name: c.name, icon: c.icon, color: c.color, count: c.n })),
    activeCities: activeCities.map((c) => ({ city: c.city, count: c.n })),
    feed: rows.map((p) => ({
      id: p.id,
      caption: p.caption,
      mediaType: p.media_type,
      mediaData: p.media_data,
      submittedAt: p.submitted_at,
      location: p.gps_lat != null ? { lat: p.gps_lat, lng: p.gps_lng } : null,
      user: { name: p.user_name, avatar: p.user_avatar, mohalla: p.mohalla, city: p.city },
      questTitle: p.quest_title,
      category: p.category_name ? { name: p.category_name, icon: p.category_icon, color: p.category_color } : null,
    })),
  });
});

export default router;
