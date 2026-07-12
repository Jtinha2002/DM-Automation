const express = require('express');
const db = require('../database');

const router = express.Router();

function nodeCount(def) {
  try { return (JSON.parse(def).nodes || []).length; } catch { return 0; }
}

function serializeDef(definition) {
  const d = definition || {};
  const nodes = Array.isArray(d.nodes) ? d.nodes : [];
  const edges = Array.isArray(d.edges) ? d.edges : [];
  return JSON.stringify({ nodes, edges });
}

router.get('/', (req, res) => {
  const flows = db.prepare(`
    SELECT f.id, f.name, f.active, f.account_id, f.definition, f.updated_at, a.username AS account_username
    FROM flows f LEFT JOIN accounts a ON f.account_id = a.id
    ORDER BY f.updated_at DESC
  `).all().map(f => ({
    id: f.id, name: f.name, active: f.active, account_id: f.account_id,
    account_username: f.account_username, updated_at: f.updated_at, nodes: nodeCount(f.definition)
  }));
  res.json(flows);
});

router.get('/:id', (req, res) => {
  const flow = db.prepare('SELECT * FROM flows WHERE id = ?').get(req.params.id);
  if (!flow) return res.status(404).json({ error: 'Flow não encontrado' });
  let definition;
  try { definition = JSON.parse(flow.definition); } catch { definition = { nodes: [], edges: [] }; }
  res.json({ ...flow, definition });
});

router.post('/', (req, res) => {
  const { name, definition, account_id, active } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Dê um nome ao fluxo' });
  const r = db.prepare(`INSERT INTO flows (account_id, name, active, definition) VALUES (?, ?, ?, ?)`)
    .run(account_id || null, name.trim(), active === false ? 0 : 1, serializeDef(definition));
  res.status(201).json(db.prepare('SELECT * FROM flows WHERE id = ?').get(r.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM flows WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Flow não encontrado' });
  const { name, definition, account_id, active } = req.body;
  db.prepare(`UPDATE flows SET name = ?, account_id = ?, active = ?, definition = ?, updated_at = unixepoch() WHERE id = ?`)
    .run(
      name?.trim() || existing.name,
      account_id !== undefined ? (account_id || null) : existing.account_id,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      definition !== undefined ? serializeDef(definition) : existing.definition,
      req.params.id
    );
  res.json(db.prepare('SELECT * FROM flows WHERE id = ?').get(req.params.id));
});

router.patch('/:id/toggle', (req, res) => {
  const flow = db.prepare('SELECT * FROM flows WHERE id = ?').get(req.params.id);
  if (!flow) return res.status(404).json({ error: 'Flow não encontrado' });
  db.prepare('UPDATE flows SET active = ?, updated_at = unixepoch() WHERE id = ?').run(flow.active ? 0 : 1, req.params.id);
  res.json({ id: Number(req.params.id), active: !flow.active });
});

router.delete('/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM flows WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Flow não encontrado' });
  db.prepare('DELETE FROM flows WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM flow_runs WHERE flow_id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
