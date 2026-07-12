const axios = require('axios');
const db = require('../database');

const api = axios.create({ timeout: 10000 });
const GRAPH = 'https://graph.instagram.com/v21.0';

// ── Variable substitution ──
function applyVars(text, vars = {}) {
  if (!text) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

// ── Contact (audience) upsert ──
function upsertContact(accountId, userId, username, { inbound = false, source = null } = {}) {
  if (!accountId || !userId) return;
  const existing = db.prepare('SELECT id FROM contacts WHERE account_id = ? AND user_id = ?').get(accountId, userId);
  if (existing) {
    if (inbound) {
      db.prepare('UPDATE contacts SET username = COALESCE(?, username), last_seen = unixepoch(), last_inbound_at = unixepoch() WHERE id = ?')
        .run(username || null, existing.id);
    } else {
      db.prepare('UPDATE contacts SET username = COALESCE(?, username), last_seen = unixepoch() WHERE id = ?')
        .run(username || null, existing.id);
    }
  } else {
    db.prepare('INSERT INTO contacts (account_id, user_id, username, source, last_inbound_at) VALUES (?, ?, ?, ?, ?)')
      .run(accountId, userId, username || null, source, inbound ? Math.floor(Date.now() / 1000) : null);
  }
}

// ── Conversation helpers ──
function getOrCreateConversation(accountId, userId, username) {
  let conv = db.prepare('SELECT * FROM conversations WHERE account_id = ? AND user_id = ?').get(accountId, userId);
  if (!conv) {
    const r = db.prepare(`
      INSERT INTO conversations (account_id, user_id, username)
      VALUES (?, ?, ?)
    `).run(accountId, userId, username || null);
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(r.lastInsertRowid);
  } else if (username && username !== conv.username) {
    db.prepare('UPDATE conversations SET username = ? WHERE id = ?').run(username, conv.id);
  }
  return conv;
}

function recordMessage(conv, { direction, type = 'text', text = null, payload = null, source = 'auto', igMessageId = null }) {
  db.prepare(`
    INSERT INTO messages (conversation_id, direction, type, text, payload, source, ig_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(conv.id, direction, type, text, payload ? JSON.stringify(payload) : null, source, igMessageId);

  const preview = text || (type === 'image' ? '📷 Imagem' : type === 'buttons' ? '🔘 Botões' : type === 'card' ? '🗂 Card' : type === 'quick_reply' ? '⚡ Resposta rápida' : '');
  db.prepare(`
    UPDATE conversations
    SET last_message = ?, last_message_at = unixepoch(), last_direction = ?,
        unread = unread ${direction === 'in' ? '+ 1' : ''}${direction === 'out' ? ' * 0' : ''}
    WHERE id = ?
  `).run(preview.slice(0, 120), direction, conv.id);
}

// ── Block → Instagram API message object ──
function blockToApiMessage(block, vars = {}) {
  switch (block.type) {
    case 'text':
      return { text: applyVars(block.text, vars) };

    case 'image':
      return { attachment: { type: 'image', payload: { url: block.url, is_reusable: true } } };

    case 'buttons':
      return {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: applyVars(block.text || ' ', vars),
            buttons: (block.buttons || []).slice(0, 3).map(b => ({ type: 'web_url', url: b.url, title: applyVars(b.title, vars) }))
          }
        }
      };

    case 'card':
      return {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'generic',
            elements: [{
              title: applyVars(block.title || ' ', vars),
              subtitle: applyVars(block.subtitle || '', vars) || undefined,
              image_url: block.image_url || undefined,
              buttons: (block.buttons || []).slice(0, 3).map(b => ({ type: 'web_url', url: b.url, title: applyVars(b.title, vars) }))
            }]
          }
        }
      };

    default:
      return null;
  }
}

// ── Send a list of blocks; records each into the conversation ──
async function sendBlocks(account, userId, username, blocks, vars = {}, { source = 'auto' } = {}) {
  const conv = getOrCreateConversation(account.id, userId, username);
  const results = [];

  for (const block of blocks) {
    const msgObj = blockToApiMessage(block, vars);
    if (!msgObj) continue;

    try {
      const res = await api.post(`${GRAPH}/${account.instagram_user_id}/messages`, {
        recipient: { id: userId },
        message: msgObj,
        access_token: account.access_token
      });
      const igMessageId = res.data?.message_id || null;
      recordMessage(conv, {
        direction: 'out',
        type: block.type,
        text: block.type === 'text' ? applyVars(block.text, vars) : (block.text ? applyVars(block.text, vars) : null),
        payload: block.type !== 'text' ? block : null,
        source,
        igMessageId
      });
      results.push({ ok: true });
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      results.push({ ok: false, error: msg });
      throw new Error(msg); // bubble up so caller can log/retry
    }
  }
  return results;
}

// ── Send plain text (records it) ──
async function sendText(account, userId, username, text, { source = 'auto' } = {}) {
  return sendBlocks(account, userId, username, [{ type: 'text', text }], {}, { source });
}

// ── Send text with quick replies (follow-gate) — records as quick_reply ──
async function sendQuickReply(account, userId, username, text, replies, { source = 'auto' } = {}) {
  const conv = getOrCreateConversation(account.id, userId, username);
  const res = await api.post(`${GRAPH}/${account.instagram_user_id}/messages`, {
    recipient: { id: userId },
    message: { text, quick_replies: replies },
    access_token: account.access_token
  });
  recordMessage(conv, { direction: 'out', type: 'quick_reply', text, payload: { quick_replies: replies }, source, igMessageId: res.data?.message_id || null });
  return res.data;
}

// ── Record an inbound message (from webhook) ──
function recordInbound(account, userId, username, { text, type = 'text', payload = null, igMessageId = null }) {
  const conv = getOrCreateConversation(account.id, userId, username);
  recordMessage(conv, { direction: 'in', type, text, payload, source: 'user', igMessageId });
  upsertContact(account.id, userId, username, { inbound: true, source: 'dm' });
  return conv;
}

// ── Normalise blocks from a rule (dm_blocks JSON or legacy dm_message) ──
function resolveRuleBlocks(rule) {
  if (rule.dm_blocks) {
    try {
      const blocks = JSON.parse(rule.dm_blocks);
      if (Array.isArray(blocks) && blocks.length) return blocks;
    } catch {}
  }
  if (rule.dm_message) return [{ type: 'text', text: rule.dm_message }];
  return [];
}

module.exports = {
  applyVars,
  upsertContact,
  getOrCreateConversation,
  recordMessage,
  recordInbound,
  sendBlocks,
  sendText,
  sendQuickReply,
  resolveRuleBlocks,
  blockToApiMessage
};
