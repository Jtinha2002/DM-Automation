const express = require('express');
const db = require('../database');
const msg = require('../lib/messaging');

const router = express.Router();
const WINDOW = 86400; // 24h

function parseTags(raw) { try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function windowOpen(lastInbound) { return !!lastInbound && (Math.floor(Date.now() / 1000) - lastInbound) < WINDOW; }

// List contacts
router.get('/', (req, res) => {
  const { account_id, tag, q } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (account_id) { where += ' AND c.account_id = ?'; params.push(account_id); }
  if (q) { where += ' AND c.username LIKE ?'; params.push('%' + q + '%'); }

  let rows = db.prepare(`
    SELECT c.*, a.username AS account_username
    FROM contacts c LEFT JOIN accounts a ON c.account_id = a.id
    ${where}
    ORDER BY c.last_seen DESC
    LIMIT 1000
  `).all(...params).map(c => ({
    ...c, tags: parseTags(c.tags), window_open: windowOpen(c.last_inbound_at)
  }));

  if (tag) rows = rows.filter(c => c.tags.includes(tag));

  res.json({ contacts: rows, total: rows.length });
});

// Distinct tags
router.get('/tags', (req, res) => {
  const all = db.prepare('SELECT tags FROM contacts WHERE tags IS NOT NULL').all();
  const set = new Set();
  all.forEach(r => parseTags(r.tags).forEach(t => set.add(t)));
  res.json([...set].sort());
});

// Update a contact's tags
router.patch('/:id/tags', (req, res) => {
  const c = db.prepare('SELECT id FROM contacts WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Contato não encontrado' });
  const tags = Array.isArray(req.body.tags) ? req.body.tags.map(t => String(t).trim()).filter(Boolean) : [];
  db.prepare('UPDATE contacts SET tags = ? WHERE id = ?').run(JSON.stringify([...new Set(tags)]), req.params.id);
  res.json({ ok: true, tags });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Broadcast preview: how many reachable (within 24h window)
router.get('/broadcast/preview', (req, res) => {
  const { account_id, tag } = req.query;
  if (!account_id) return res.json({ total: 0, reachable: 0 });
  let rows = db.prepare('SELECT tags, last_inbound_at FROM contacts WHERE account_id = ?').all(account_id)
    .map(c => ({ tags: parseTags(c.tags), open: windowOpen(c.last_inbound_at) }));
  if (tag) rows = rows.filter(c => c.tags.includes(tag));
  res.json({ total: rows.length, reachable: rows.filter(c => c.open).length });
});

// Send a broadcast (text + optional image) to a segment, within 24h window
router.post('/broadcast', async (req, res) => {
  const { account_id, tag, text, image_url } = req.body;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account_id);
  if (!account) return res.status(400).json({ error: 'Conta inválida' });

  const blocks = [];
  if (text?.trim()) blocks.push({ type: 'text', text: text.trim() });
  if (image_url?.trim()) blocks.push({ type: 'image', url: image_url.trim() });
  if (!blocks.length) return res.status(400).json({ error: 'Mensagem vazia' });

  let targets = db.prepare('SELECT * FROM contacts WHERE account_id = ?').all(account_id)
    .map(c => ({ ...c, tags: parseTags(c.tags) }));
  if (tag) targets = targets.filter(c => c.tags.includes(tag));
  targets = targets.filter(c => windowOpen(c.last_inbound_at)).slice(0, 500);

  let sent = 0, failed = 0;
  for (const c of targets) {
    try {
      await msg.sendBlocks(account, c.user_id, c.username, blocks, { username: c.username || '' }, { source: 'broadcast' });
      sent++;
    } catch { failed++; }
    await new Promise(r => setTimeout(r, 350)); // throttle to avoid rate limits
  }

  db.prepare(`INSERT INTO logs (event_type, account_id, status, error_message)
    VALUES ('broadcast_sent', ?, 'ok', ?)`).run(account_id, `${sent} enviados, ${failed} falhas`);

  res.json({ sent, failed, skipped: 0, targeted: targets.length });
});

module.exports = router;
