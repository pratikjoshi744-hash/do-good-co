import { randomUUID } from 'node:crypto';
import { Router } from '../lib/http.js';
import { ok, created, readJsonBody, HttpError } from '../lib/http.js';
import { db } from '../db/connection.js';
import { serializeMessage } from '../lib/serialize.js';
import { requireAuth } from '../middleware/auth.js';

const router = new Router();

function conversationKey(userA, userB) {
  // Store deterministically so (A,B) and (B,A) always hit the same row.
  return userA < userB ? [userA, userB] : [userB, userA];
}

function getOrCreateConversation(userAId, userBId) {
  const [a, b] = conversationKey(userAId, userBId);
  let convo = db.prepare('SELECT * FROM conversations WHERE user_a_id = ? AND user_b_id = ?').get(a, b);
  if (!convo) {
    const id = randomUUID();
    db.prepare('INSERT INTO conversations (id, user_a_id, user_b_id) VALUES (?, ?, ?)').run(id, a, b);
    convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  }
  return convo;
}

function otherUserId(convo, myId) {
  return convo.user_a_id === myId ? convo.user_b_id : convo.user_a_id;
}

// List all conversations for the current user, newest activity first, with a
// preview of the last message and an unread count.
router.get('/api/messages/conversations', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM conversations WHERE user_a_id = ? OR user_b_id = ? ORDER BY last_message_at DESC
  `).all(req.user.id, req.user.id);

  const data = rows.map((c) => {
    const otherId = otherUserId(c, req.user.id);
    const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
    const lastMessage = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1').get(c.id);
    const unreadCount = db.prepare(`
      SELECT COUNT(*) as c FROM messages WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL
    `).get(c.id, req.user.id).c;
    return {
      id: c.id,
      otherUser: other ? { id: other.id, name: other.name, avatar: other.avatar, mohalla: other.mohalla } : null,
      lastMessage: lastMessage ? serializeMessage(lastMessage) : null,
      unreadCount,
      updatedAt: c.last_message_at,
    };
  });

  ok(res, data);
});

// Start (or fetch existing) conversation with another user
router.post('/api/messages/conversations', requireAuth, async (req, res) => {
  const body = await readJsonBody(req);
  const otherId = body.userId;
  if (!otherId) throw new HttpError(400, 'userId is required');
  if (otherId === req.user.id) throw new HttpError(400, 'Cannot message yourself');

  const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
  if (!other) throw new HttpError(404, 'User not found');

  const convo = getOrCreateConversation(req.user.id, otherId);
  created(res, {
    id: convo.id,
    otherUser: { id: other.id, name: other.name, avatar: other.avatar, mohalla: other.mohalla },
  });
});

router.get('/api/messages/conversations/:id', requireAuth, (req, res) => {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!convo) throw new HttpError(404, 'Conversation not found');
  if (convo.user_a_id !== req.user.id && convo.user_b_id !== req.user.id) {
    throw new HttpError(403, 'Not your conversation');
  }

  // Mark incoming messages as read
  db.prepare(`
    UPDATE messages SET read_at = datetime('now') WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL
  `).run(convo.id, req.user.id);

  const { since } = req.query;
  let sql = 'SELECT * FROM messages WHERE conversation_id = ?';
  const params = [convo.id];
  if (since) { sql += ' AND created_at > ?'; params.push(since); }
  sql += ' ORDER BY created_at ASC';

  const messages = db.prepare(sql).all(...params);
  const otherId = otherUserId(convo, req.user.id);
  const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);

  ok(res, {
    id: convo.id,
    otherUser: other ? { id: other.id, name: other.name, avatar: other.avatar, mohalla: other.mohalla } : null,
    messages: messages.map(serializeMessage),
  });
});

router.post('/api/messages/conversations/:id/messages', requireAuth, async (req, res) => {
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!convo) throw new HttpError(404, 'Conversation not found');
  if (convo.user_a_id !== req.user.id && convo.user_b_id !== req.user.id) {
    throw new HttpError(403, 'Not your conversation');
  }
  const body = await readJsonBody(req);
  const text = String(body.text || '').trim();
  if (!text) throw new HttpError(400, 'Message text is required');
  if (text.length > 2000) throw new HttpError(400, 'Message is too long (max 2000 characters)');

  const id = randomUUID();
  db.prepare('INSERT INTO messages (id, conversation_id, sender_id, text) VALUES (?, ?, ?, ?)').run(id, convo.id, req.user.id, text);
  db.prepare(`UPDATE conversations SET last_message_at = datetime('now') WHERE id = ?`).run(convo.id);

  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  created(res, serializeMessage(message));
});

router.get('/api/messages/unread-count', requireAuth, (req, res) => {
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM messages m
    JOIN conversations co ON co.id = m.conversation_id
    WHERE (co.user_a_id = ? OR co.user_b_id = ?) AND m.sender_id != ? AND m.read_at IS NULL
  `).get(req.user.id, req.user.id, req.user.id);
  ok(res, { unreadCount: row.c });
});

export default router;
