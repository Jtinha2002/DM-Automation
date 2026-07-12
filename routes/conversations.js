const express = require('express');
const db = require('../database');
const msg = require('../lib/messaging');

const router = express.Router();

// List conversations (optionally filtered by account)
router.get('/', (req, res) => {
  const { account_id } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (account_id) { where += ' AND c.account_id = ?'; params.push(account_id); }

  const convs = db.prepare(`
    SELECT c.*, a.username AS account_username
    FROM conversations c
    LEFT JOIN accounts a ON c.account_id = a.id
    ${where}
    ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
    LIMIT 200
  `).all(...params);

  const totalUnread = db.prepare('SELECT COALESCE(SUM(unread),0) AS u FROM conversations').get().u;
  res.json({ conversations: convs, total_unread: totalUnread });
});

// Get message thread
router.get('/:id/messages', (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

  const messages = db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC LIMIT 500
  `).all(req.params.id).map(m => ({ ...m, payload: m.payload ? safeParse(m.payload) : null }));

  // Mark as read
  db.prepare('UPDATE conversations SET unread = 0 WHERE id = ?').run(req.params.id);

  // Instagram 24h standard messaging window: you can only DM within 24h of the
  // user's last inbound message.
  const lastInbound = db.prepare("SELECT created_at FROM messages WHERE conversation_id = ? AND direction = 'in' ORDER BY created_at DESC LIMIT 1").get(req.params.id);
  const now = Math.floor(Date.now() / 1000);
  const windowOpen = lastInbound ? (now - lastInbound.created_at) < 86400 : false;
  const hoursLeft  = windowOpen ? Math.floor((86400 - (now - lastInbound.created_at)) / 3600) : 0;

  res.json({ conversation: conv, messages, window_open: windowOpen, window_hours_left: hoursLeft });
});

// Mark read
router.post('/:id/read', (req, res) => {
  db.prepare('UPDATE conversations SET unread = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Manual reply (text or rich blocks)
router.post('/:id/reply', async (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(conv.account_id);
  if (!account) return res.status(400).json({ error: 'Conta desconectada' });

  const { text, blocks } = req.body;
  const toSend = Array.isArray(blocks) && blocks.length ? blocks : (text?.trim() ? [{ type: 'text', text: text.trim() }] : null);
  if (!toSend) return res.status(400).json({ error: 'Mensagem vazia' });

  try {
    await msg.sendBlocks(account, conv.user_id, conv.username, toSend, {}, { source: 'manual' });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM conversations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

module.exports = router;
