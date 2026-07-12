const express = require('express');
const db = require('../database');

const router = express.Router();

router.get('/', (req, res) => {
  const { limit = 50, offset = 0, event_type, status, account_id } = req.query;
  const safeLimit  = Math.min(Math.max(Number(limit)  || 50, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  let where = 'WHERE 1=1';
  const params = [];

  if (event_type)  { where += ' AND l.event_type = ?';  params.push(event_type); }
  if (status)      { where += ' AND l.status = ?';       params.push(status); }
  if (account_id)  { where += ' AND l.account_id = ?';   params.push(account_id); }

  const logs = db.prepare(`
    SELECT l.*, r.keywords as rule_keywords, a.username as account_username
    FROM logs l
    LEFT JOIN rules r    ON l.rule_id    = r.id
    LEFT JOIN accounts a ON l.account_id = a.id
    ${where}
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, safeLimit, safeOffset);

  const total = db.prepare(`SELECT COUNT(*) as count FROM logs l ${where}`).get(...params).count;

  res.json({ logs, total });
});

// CSV export
router.get('/export', (req, res) => {
  const { event_type, account_id } = req.query;
  let where = 'WHERE 1=1';
  const params = [];

  if (event_type) { where += ' AND l.event_type = ?'; params.push(event_type); }
  if (account_id) { where += ' AND l.account_id = ?'; params.push(account_id); }

  const logs = db.prepare(`
    SELECT l.*, a.username as account_username
    FROM logs l
    LEFT JOIN accounts a ON l.account_id = a.id
    ${where}
    ORDER BY l.created_at DESC
    LIMIT 10000
  `).all(...params);

  const headers = ['id', 'created_at', 'event_type', 'account_username', 'username', 'keyword_matched', 'status', 'error_message', 'comment_id', 'post_id'];
  const csvRow  = row => headers.map(h => {
    const v = h === 'created_at' ? new Date((row[h] || 0) * 1000).toISOString() : (row[h] ?? '');
    return `"${String(v).replace(/"/g, '""')}"`;
  }).join(',');

  const csv = [headers.join(','), ...logs.map(csvRow)].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="instabot-logs-${Date.now()}.csv"`);
  res.send('﻿' + csv); // BOM for Excel
});

router.delete('/', (req, res) => {
  db.exec('DELETE FROM logs');
  db.exec('DELETE FROM processed_comments');
  db.exec('DELETE FROM user_rule_sent');
  db.exec('DELETE FROM pending_follow_sends');
  res.json({ ok: true });
});

router.get('/stats', (req, res) => {
  const { account_id } = req.query;
  const where = account_id ? 'AND account_id = ?' : '';
  const p = account_id ? [account_id] : [];

  const q = (evt) => db.prepare(`SELECT COUNT(*) as c FROM logs WHERE event_type = ? ${where}`).get(evt, ...p).c;
  const qStatus = (s) => db.prepare(`SELECT COUNT(*) as c FROM logs WHERE status = ? ${where}`).get(s, ...p).c;

  res.json({
    total_comments:   q('comment_received'),
    total_replies:    q('comment_reply_sent'),
    total_dms:        q('dm_sent'),
    total_errors:     qStatus('error'),
    total_skipped:    qStatus('skipped'),
    follow_gate_sent: q('follow_gate_sent'),
    follow_gate_pending: db.prepare('SELECT COUNT(*) as c FROM pending_follow_sends WHERE expires_at > unixepoch()').get().c,
    retry_pending:    db.prepare("SELECT COUNT(*) as c FROM retry_queue WHERE status = 'pending'").get().c,
    retry_failed:     db.prepare("SELECT COUNT(*) as c FROM retry_queue WHERE status = 'failed'").get().c
  });
});

module.exports = router;
