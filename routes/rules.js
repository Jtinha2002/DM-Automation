const express = require('express');
const db = require('../database');

const router = express.Router();

const KEYWORD_MAX  = 60;
const MESSAGE_MAX  = 2200;

function parseKeywords(raw) {
  return (raw || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
}

function serializeBlocks(blocks) {
  if (!Array.isArray(blocks)) return undefined;
  const clean = blocks
    .filter(b => b && b.type)
    .map(b => {
      if (b.type === 'text')    return { type: 'text', text: (b.text || '').slice(0, MESSAGE_MAX) };
      if (b.type === 'image')   return { type: 'image', url: (b.url || '').trim() };
      if (b.type === 'buttons') return { type: 'buttons', text: (b.text || '').slice(0, 640), buttons: (b.buttons || []).filter(x => x.title && x.url).slice(0, 3) };
      if (b.type === 'card')    return { type: 'card', title: b.title || '', subtitle: b.subtitle || '', image_url: (b.image_url || '').trim(), buttons: (b.buttons || []).filter(x => x.title && x.url).slice(0, 3) };
      return null;
    })
    .filter(Boolean)
    .filter(b => {
      if (b.type === 'text')    return b.text.trim().length > 0;
      if (b.type === 'image')   return b.url.length > 0;
      if (b.type === 'buttons') return b.buttons.length > 0;
      if (b.type === 'card')    return b.title.trim() || b.image_url || b.buttons.length;
      return false;
    });
  return clean.length ? JSON.stringify(clean) : null;
}

function blocksHaveContent(raw) {
  if (!raw) return false;
  try { const a = JSON.parse(raw); return Array.isArray(a) && a.length > 0; } catch { return false; }
}

function validateRule(body, existing = null) {
  const { keywords, comment_reply, dm_message, post_id, cooldown_hours } = body;
  const matchType = body.match_type ?? existing?.match_type ?? 'specific';

  const kws = parseKeywords(keywords ?? existing?.keywords);
  if (matchType !== 'any') {
    if (!kws.length) return 'Adicione pelo menos uma palavra-chave (ou escolha "qualquer palavra")';
    if (kws.some(k => k.length > KEYWORD_MAX)) return `Cada palavra-chave deve ter no máximo ${KEYWORD_MAX} caracteres`;
  }

  const reply = comment_reply !== undefined ? comment_reply?.trim() : existing?.comment_reply;
  const dm    = dm_message    !== undefined ? dm_message?.trim()    : existing?.dm_message;

  const blocksRaw = body.dm_blocks !== undefined ? serializeBlocks(body.dm_blocks) : existing?.dm_blocks;
  const hasBlocks = blocksHaveContent(blocksRaw);

  if (!reply && !dm && !hasBlocks) return 'Adicione ao menos uma ação: resposta no comentário ou DM';
  if (reply && reply.length > MESSAGE_MAX) return `Resposta deve ter no máximo ${MESSAGE_MAX} caracteres`;
  if (dm    && dm.length    > MESSAGE_MAX) return `DM deve ter no máximo ${MESSAGE_MAX} caracteres`;

  if (cooldown_hours !== undefined && (isNaN(Number(cooldown_hours)) || Number(cooldown_hours) < 0)) {
    return 'Cooldown deve ser um número positivo (0 = sem limite)';
  }

  return null;
}

router.get('/', (req, res) => {
  const { account_id } = req.query;
  let rows;
  if (account_id) {
    rows = db.prepare('SELECT r.*, a.username as account_username FROM rules r LEFT JOIN accounts a ON r.account_id = a.id WHERE r.account_id = ? ORDER BY r.priority, r.created_at DESC').all(account_id);
  } else {
    rows = db.prepare('SELECT r.*, a.username as account_username FROM rules r LEFT JOIN accounts a ON r.account_id = a.id ORDER BY r.priority, r.created_at DESC').all();
  }
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const rule = db.prepare('SELECT r.*, a.username as account_username FROM rules r LEFT JOIN accounts a ON r.account_id = a.id WHERE r.id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Regra não encontrada' });
  res.json(rule);
});

router.post('/', (req, res) => {
  const err = validateRule(req.body);
  if (err) return res.status(400).json({ error: err });

  const { keywords, comment_reply, dm_message, require_follow, post_id, cooldown_hours, active, account_id } = req.body;

  const result = db.prepare(`
    INSERT INTO rules (account_id, keywords, match_type, comment_reply, dm_message, dm_blocks, bonus_blocks, follow_prompt_message, require_follow, allow_skip, trigger_dm, post_id, cooldown_hours, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    account_id || null,
    parseKeywords(keywords).join(','),
    req.body.match_type === 'any' ? 'any' : 'specific',
    comment_reply?.trim() || null,
    dm_message?.trim()    || null,
    serializeBlocks(req.body.dm_blocks) ?? null,
    serializeBlocks(req.body.bonus_blocks) ?? null,
    req.body.follow_prompt_message?.trim() || null,
    require_follow ? 1 : 0,
    req.body.allow_skip === false ? 0 : 1,
    req.body.trigger_dm ? 1 : 0,
    post_id?.trim() || null,
    Number(cooldown_hours ?? 24),
    active !== false ? 1 : 0
  );

  const rule = db.prepare('SELECT * FROM rules WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(rule);
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM rules WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Regra não encontrada' });

  const err = validateRule(req.body, existing);
  if (err) return res.status(400).json({ error: err });

  const { keywords, comment_reply, dm_message, require_follow, post_id, cooldown_hours, active, account_id } = req.body;

  const { follow_prompt_message } = req.body;
  db.prepare(`
    UPDATE rules SET
      account_id            = ?,
      keywords              = ?,
      comment_reply         = ?,
      dm_message            = ?,
      dm_blocks             = ?,
      bonus_blocks          = ?,
      follow_prompt_message = ?,
      require_follow        = ?,
      allow_skip            = ?,
      trigger_dm            = ?,
      post_id               = ?,
      cooldown_hours        = ?,
      active                = ?,
      updated_at            = unixepoch()
    WHERE id = ?
  `).run(
    account_id !== undefined ? (account_id || null) : existing.account_id,
    keywords   !== undefined ? parseKeywords(keywords).join(',') : existing.keywords,
    comment_reply !== undefined ? (comment_reply?.trim() || null) : existing.comment_reply,
    dm_message    !== undefined ? (dm_message?.trim()    || null) : existing.dm_message,
    req.body.dm_blocks    !== undefined ? (serializeBlocks(req.body.dm_blocks)    ?? null) : existing.dm_blocks,
    req.body.bonus_blocks !== undefined ? (serializeBlocks(req.body.bonus_blocks) ?? null) : existing.bonus_blocks,
    follow_prompt_message !== undefined ? (follow_prompt_message?.trim() || null) : existing.follow_prompt_message,
    require_follow !== undefined ? (require_follow ? 1 : 0) : existing.require_follow,
    req.body.allow_skip !== undefined ? (req.body.allow_skip === false ? 0 : 1) : existing.allow_skip,
    req.body.trigger_dm !== undefined ? (req.body.trigger_dm ? 1 : 0) : existing.trigger_dm,
    post_id    !== undefined ? (post_id?.trim() || null) : existing.post_id,
    cooldown_hours !== undefined ? Number(cooldown_hours) : existing.cooldown_hours,
    active     !== undefined ? (active ? 1 : 0) : existing.active,
    req.params.id
  );

  res.json(db.prepare('SELECT * FROM rules WHERE id = ?').get(req.params.id));
});

router.patch('/:id/toggle', (req, res) => {
  const rule = db.prepare('SELECT * FROM rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Regra não encontrada' });
  db.prepare('UPDATE rules SET active = ?, updated_at = unixepoch() WHERE id = ?').run(rule.active ? 0 : 1, req.params.id);
  res.json({ id: Number(req.params.id), active: !rule.active });
});

// Reorder: body = [{ id, priority }, ...]
router.patch('/reorder', (req, res) => {
  const items = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Expected array' });

  const stmt = db.prepare('UPDATE rules SET priority = ?, updated_at = unixepoch() WHERE id = ?');
  items.forEach(({ id, priority }) => stmt.run(Number(priority), id));
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM rules WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Regra não encontrada' });
  }
  db.prepare('DELETE FROM rules WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
