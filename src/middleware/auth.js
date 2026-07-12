import { db } from '../db/connection.js';
import { HttpError } from '../lib/http.js';

export function getSessionUser(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
}

export function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) throw new HttpError(401, 'Not authenticated. Log in and send Authorization: Bearer <token>.');
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) throw new HttpError(403, 'Admin access required.');
  next();
}
