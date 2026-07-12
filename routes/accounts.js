const express = require('express');
const db = require('../database');

const router = express.Router();

router.get('/', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const accounts = db.prepare('SELECT id, instagram_user_id, username, label, expires_at, created_at FROM accounts ORDER BY created_at').all();
  const enriched = accounts.map(a => ({
    ...a,
    connected: !a.expires_at || a.expires_at > now,
    days_until_expiry: a.expires_at ? Math.max(0, Math.floor((a.expires_at - now) / 86400)) : null
  }));
  res.json(enriched);
});

router.patch('/:id/label', (req, res) => {
  const { label } = req.body;
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Conta não encontrada' });

  db.prepare('UPDATE accounts SET label = ? WHERE id = ?').run(label?.trim() || null, req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Conta não encontrada' });

  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
