const axios = require('axios');
const db = require('../database');
const msg = require('./messaging');

const api = axios.create({ timeout: 10000 });
const GRAPH = 'https://graph.instagram.com/v21.0';
const MAX_STEPS = 50; // safety against loops

// ── Graph helpers ──
function parseDef(flow) {
  try { const d = JSON.parse(flow.definition); return { nodes: d.nodes || [], edges: d.edges || [] }; }
  catch { return { nodes: [], edges: [] }; }
}
function findNode(def, id) { return def.nodes.find(n => n.id === id); }
function nextNodeId(def, fromId, port = 'out') {
  const e = def.edges.find(x => x.from === fromId && (x.fromPort || 'out') === port);
  return e ? e.to : null;
}
function triggerNode(def) { return def.nodes.find(n => n.type === 'trigger'); }

// ── Logging ──
function log(eventType, run, status, msgText) {
  db.prepare(`INSERT INTO logs (event_type, account_id, user_id, username, status, error_message)
    VALUES (?, ?, ?, ?, ?, ?)`).run(eventType, run.account_id, run.user_id, run.username, status, msgText || null);
}

async function checkFollows(userId, account) {
  if (!userId) return null;
  try {
    const res = await api.get(`${GRAPH}/${userId}`, { params: { fields: 'is_user_follow_business', access_token: account.access_token } });
    return typeof res.data?.is_user_follow_business === 'boolean' ? res.data.is_user_follow_business : null;
  } catch { return null; }
}

// ── Start a flow for a user (called from the webhook on trigger match) ──
async function startFlow(flow, account, ctx) {
  const def = parseDef(flow);
  const trig = triggerNode(def);
  if (!trig) return;
  const firstId = nextNodeId(def, trig.id, 'out');
  if (!firstId) return;

  const context = JSON.stringify({
    username: ctx.username || '',
    keyword: ctx.keyword || '',
    comment_id: ctx.comment_id || null,
    comment_text: ctx.comment_text || '',
    post_id: ctx.post_id || null
  });

  const r = db.prepare(`
    INSERT INTO flow_runs (flow_id, account_id, user_id, username, comment_id, current_node_id, status, context)
    VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
  `).run(flow.id, account.id, ctx.user_id, ctx.username || null, ctx.comment_id || null, firstId, context);

  const run = db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(r.lastInsertRowid);
  log('flow_started', run, 'ok', `Flow "${flow.name}" iniciado`);
  await advanceRun(run, account, def);
}

// ── Advance a run until it ends or hits a delay ──
async function advanceRun(run, account, def) {
  let currentId = run.current_node_id;
  let ctx = JSON.parse(run.context || '{}');
  let steps = 0;

  while (currentId && steps < MAX_STEPS) {
    steps++;
    const node = findNode(def, currentId);
    if (!node) { currentId = null; break; }

    const vars = { username: ctx.username, keyword: ctx.keyword };

    if (node.type === 'message') {
      const blocks = (node.data?.blocks || []).filter(Boolean);
      if (blocks.length && ctx.user_id !== undefined) {
        try {
          await msg.sendBlocks(account, run.user_id, ctx.username, blocks, vars, { source: 'flow' });
          db.prepare(`INSERT INTO logs (event_type, account_id, user_id, username, status) VALUES ('dm_sent', ?, ?, ?, 'ok')`)
            .run(account.id, run.user_id, ctx.username);
        } catch (err) {
          db.prepare(`INSERT INTO logs (event_type, account_id, user_id, username, status, error_message) VALUES ('dm_failed', ?, ?, ?, 'error', ?)`)
            .run(account.id, run.user_id, ctx.username, err.message);
        }
      }
      currentId = nextNodeId(def, node.id, 'out');

    } else if (node.type === 'comment_reply') {
      if (ctx.comment_id && node.data?.text) {
        try {
          await api.post(`${GRAPH}/${ctx.comment_id}/replies`, { message: msg.applyVars(node.data.text, vars), access_token: account.access_token });
          db.prepare(`INSERT INTO logs (event_type, account_id, user_id, username, comment_id, status) VALUES ('comment_reply_sent', ?, ?, ?, ?, 'ok')`)
            .run(account.id, run.user_id, ctx.username, ctx.comment_id);
        } catch (err) {
          db.prepare(`INSERT INTO logs (event_type, account_id, user_id, username, comment_id, status, error_message) VALUES ('comment_reply_failed', ?, ?, ?, ?, 'error', ?)`)
            .run(account.id, run.user_id, ctx.username, ctx.comment_id, err.message);
        }
      }
      currentId = nextNodeId(def, node.id, 'out');

    } else if (node.type === 'delay') {
      const minutes = Math.max(1, Number(node.data?.minutes) || 1);
      const resumeAt = Math.floor(Date.now() / 1000) + minutes * 60;
      const afterDelay = nextNodeId(def, node.id, 'out');
      if (!afterDelay) { currentId = null; break; }
      db.prepare(`UPDATE flow_runs SET current_node_id = ?, status = 'waiting', resume_at = ?, context = ?, updated_at = unixepoch() WHERE id = ?`)
        .run(afterDelay, resumeAt, JSON.stringify(ctx), run.id);
      return; // processor will resume

    } else if (node.type === 'condition') {
      let port = 'no';
      if (node.data?.kind === 'contains') {
        const needle = (node.data?.value || '').toLowerCase();
        port = needle && (ctx.comment_text || '').toLowerCase().includes(needle) ? 'yes' : 'no';
      } else { // 'follows'
        const f = await checkFollows(run.user_id, account);
        port = f === true ? 'yes' : 'no'; // null/false → no
      }
      currentId = nextNodeId(def, node.id, port);

    } else {
      currentId = nextNodeId(def, node.id, 'out');
    }

    // Persist progress
    db.prepare(`UPDATE flow_runs SET current_node_id = ?, context = ?, updated_at = unixepoch() WHERE id = ?`)
      .run(currentId, JSON.stringify(ctx), run.id);
  }

  db.prepare(`UPDATE flow_runs SET status = 'done', updated_at = unixepoch() WHERE id = ?`).run(run.id);
  log('flow_done', run, 'ok', 'Flow concluído');
}

// ── Resume waiting runs (called on interval by server) ──
async function processFlowRuns() {
  const now = Math.floor(Date.now() / 1000);
  const runs = db.prepare(`SELECT * FROM flow_runs WHERE status = 'waiting' AND resume_at <= ? LIMIT 20`).all(now);
  for (const run of runs) {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(run.account_id);
    const flow = db.prepare('SELECT * FROM flows WHERE id = ?').get(run.flow_id);
    if (!account || !flow) { db.prepare(`UPDATE flow_runs SET status='failed' WHERE id = ?`).run(run.id); continue; }
    db.prepare(`UPDATE flow_runs SET status='running' WHERE id = ?`).run(run.id);
    await advanceRun(run, account, parseDef(flow)).catch(err => {
      console.error('[FLOW] resume error:', err.message);
      db.prepare(`UPDATE flow_runs SET status='failed' WHERE id = ?`).run(run.id);
    });
  }
}

// ── Find active flows whose trigger matches a comment ──
function matchFlows(accountId, commentText, postId) {
  const flows = db.prepare(`SELECT * FROM flows WHERE active = 1 AND (account_id = ? OR account_id IS NULL)`).all(accountId);
  const text = (commentText || '').toLowerCase();
  const matched = [];
  for (const flow of flows) {
    const def = parseDef(flow);
    const trig = triggerNode(def);
    if (!trig) continue;
    const keywords = (trig.data?.keywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    const hit = keywords.find(k => text.includes(k));
    if (!hit) continue;
    if (trig.data?.post_id && postId !== trig.data.post_id) continue;
    matched.push({ flow, keyword: hit });
  }
  return matched;
}

module.exports = { startFlow, processFlowRuns, matchFlows, parseDef };
