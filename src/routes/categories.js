import { Router } from '../lib/http.js';
import { ok } from '../lib/http.js';
import { db } from '../db/connection.js';
import { serializeCategory } from '../lib/serialize.js';

const router = new Router();

router.get('/api/categories', (req, res) => {
  const rows = db.prepare('SELECT * FROM categories ORDER BY name').all();
  ok(res, rows.map(serializeCategory));
});

export default router;
