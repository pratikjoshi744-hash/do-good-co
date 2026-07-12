import { Router } from '../lib/http.js';
import { ok } from '../lib/http.js';
import { db } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.js';

const router = new Router();

// Real map of nearby good deeds — pulls recent proofs that have GPS attached
// (every proof does, real or simulated-fallback) and returns them as map
// pins with quest/category context. Scoped to the requesting user's own city
// by default so the map centers on somewhere relevant to them; pass
// city=any to see everything.
router.get('/api/map/nearby', requireAuth, (req, res) => {
  const city = req.query.city || req.user.city;
  const limit = Math.min(Number(req.query.limit) || 60, 100);

  let sql = `
    SELECT p.id, p.gps_lat, p.gps_lng, p.status, p.submitted_at, p.photo_placeholder,
           u.name as user_name, u.avatar as user_avatar, u.mohalla as user_mohalla, u.city as user_city,
           q.title as quest_title, c.slug as category_slug, c.name as category_name, c.icon as category_icon, c.color as category_color
    FROM proofs p
    JOIN users u ON u.id = p.user_id
    JOIN quests q ON q.id = p.quest_id
    JOIN categories c ON c.id = q.category_id
    WHERE p.status != 'flagged' AND p.gps_lat IS NOT NULL
  `;
  const params = [];
  if (city && city !== 'any') {
    sql += ' AND u.city = ?';
    params.push(city);
  }
  sql += ' ORDER BY p.submitted_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  const pins = rows.map((r) => ({
    id: r.id,
    lat: r.gps_lat,
    lng: r.gps_lng,
    status: r.status,
    submittedAt: r.submitted_at,
    icon: r.photo_placeholder,
    questTitle: r.quest_title,
    category: { slug: r.category_slug, name: r.category_name, icon: r.category_icon, color: r.category_color },
    user: { name: r.user_name, avatar: r.user_avatar, mohalla: r.user_mohalla, city: r.user_city },
  }));

  ok(res, { city: city || null, pins });
});

export default router;
