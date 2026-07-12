const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const db = require('../database');
const msg = require('../lib/messaging');
const flowEngine = require('../lib/flow-engine');

const router = express.Router();
const api = axios.create({ timeout: 10000 });

const FOLLOW_PAYLOAD = 'INSTABOT_FOLLOW_CHECK'; // "Já te segui" (re-checagem)
const FOLLOW_GET     = 'INSTABOT_FOLLOW_GET';   // "Seguir e receber"
const FOLLOW_BONUS   = 'INSTABOT_FOLLOW_BONUS'; // "Seguir + bônus"
const JUST_SEND      = 'INSTABOT_JUST_SEND';    // "Não seguir e receber"
const GATE_PAYLOADS  = [FOLLOW_PAYLOAD, FOLLOW_GET, FOLLOW_BONUS, JUST_SEND];

// Validate Meta's X-Hub-Signature-256 against the raw body
function verifySignature(req) {
  const secret = process.env.INSTAGRAM_APP_SECRET;
  if (!secret) return true; // dev: no secret configured → skip
  const sig = req.get('x-hub-signature-256');
  if (!sig || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}

// ── Webhook verification ──
router.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN) {
    console.log('[WEBHOOK] Verified');
    return res.send(challenge);
  }
  res.sendStatus(403);
});

// ── Receive events ──
// Real Meta events must carry a valid signature. The in-app simulator is allowed
// when the request comes from a logged-in session.
router.post('/', async (req, res) => {
  // Trusted = panel has no password (local/dev) OR a logged-in session (in-app simulator).
  // Otherwise (real external calls) a valid Meta signature is required.
  const trusted = !process.env.APP_PASSWORD || req.session?.appAuth;
  if (!trusted && !verifySignature(req)) {
    console.warn('[WEBHOOK] Rejected: invalid signature');
    return res.sendStatus(403);
  }
  res.sendStatus(200);
  const body = req.body;
  if (!body || body.object !== 'instagram') return;

  for (const entry of body.entry || []) {
    const account = db.prepare('SELECT * FROM accounts WHERE instagram_user_id = ?').get(entry.id) ||
                    db.prepare('SELECT * FROM accounts ORDER BY created_at LIMIT 1').get();

    for (const change of entry.changes || []) {
      if (change.field === 'comments' && change.value) {
        await handleComment(change.value, account).catch(err =>
          console.error('[WEBHOOK] Comment error:', err.message)
        );
      }
    }

    for (const m of entry.messaging || []) {
      await handleMessage(m, account).catch(err =>
        console.error('[WEBHOOK] Message error:', err.message)
      );
    }
  }
});

// ────────────────────────────────────────────────
// Comment handler
// ────────────────────────────────────────────────
async function handleComment(value, account) {
  const commentId   = value.id;
  if (!commentId) return;

  const commentText = (value.text || '').toLowerCase();
  const postId      = value.media?.id || null;
  const fromId      = value.from?.id  || null;
  const fromUsername = value.from?.username || 'unknown';

  if (db.prepare('INSERT OR IGNORE INTO processed_comments (comment_id) VALUES (?)').run(commentId).changes === 0) return;

  const accountId = account?.id || null;
  db.prepare(`
    INSERT INTO logs (event_type, account_id, comment_id, post_id, user_id, username, payload)
    VALUES ('comment_received', ?, ?, ?, ?, ?, ?)
  `).run(accountId, commentId, postId, fromId, fromUsername, JSON.stringify(value));

  if (!account) { console.warn('[WEBHOOK] No account found'); return; }

  if (fromId) msg.upsertContact(account.id, fromId, fromUsername, { source: 'comment' });

  // Flows take precedence over simple rules: if a flow's trigger matches, run it
  // and skip the rules engine (avoids duplicate sends for the same keyword).
  const flowMatches = flowEngine.matchFlows(accountId, commentText, postId);
  if (flowMatches.length) {
    for (const { flow, keyword } of flowMatches) {
      await flowEngine.startFlow(flow, account, {
        user_id: fromId, username: fromUsername, keyword,
        comment_id: commentId, comment_text: value.text || '', post_id: postId
      }).catch(err => console.error('[FLOW] start error:', err.message));
    }
    return;
  }

  const rules = db.prepare(`
    SELECT * FROM rules
    WHERE active = 1 AND (account_id = ? OR account_id IS NULL)
    ORDER BY priority, created_at
  `).all(accountId);

  for (const rule of rules) {
    const keywords = rule.keywords.split(',').map(k => k.trim()).filter(Boolean);
    const matched  = keywords.find(k => commentText.includes(k));
    if (!matched) continue;
    if (rule.post_id && postId !== rule.post_id) continue;

    console.log(`[WEBHOOK] Rule #${rule.id} matched "${matched}"`);

    if (fromId && rule.cooldown_hours > 0) {
      const last = db.prepare('SELECT sent_at FROM user_rule_sent WHERE user_id = ? AND rule_id = ?').get(fromId, rule.id);
      if (last && (Math.floor(Date.now() / 1000) - last.sent_at) < rule.cooldown_hours * 3600) {
        db.prepare(`INSERT INTO logs (event_type, account_id, rule_id, comment_id, post_id, user_id, username, keyword_matched, status, error_message)
          VALUES ('cooldown_skipped', ?, ?, ?, ?, ?, ?, ?, 'skipped', 'Cooldown ativo')
        `).run(accountId, rule.id, commentId, postId, fromId, fromUsername, matched);
        continue;
      }
    }

    const vars = { username: fromUsername, keyword: matched };

    // Follow-gate: follow status can't be verified at comment time (no messaging
    // context yet), so we always send the gate DM. The real check happens when the
    // user taps "Já te segui! ✅" — see handleMessage().
    if (rule.require_follow) {
      if (rule.comment_reply) {
        await replyToComment(commentId, msg.applyVars(rule.comment_reply, vars), account, rule, postId, fromId, fromUsername, matched);
      }
      try {
        await sendChoiceDM(fromId, fromUsername, rule, account, vars, commentId);
        db.prepare(`
          INSERT OR REPLACE INTO pending_follow_sends (user_id, username, rule_id, account_id, comment_id, expires_at)
          VALUES (?, ?, ?, ?, ?, unixepoch() + 86400)
        `).run(fromId, fromUsername, rule.id, account.id, commentId);
        db.prepare(`INSERT INTO logs (event_type, account_id, rule_id, comment_id, post_id, user_id, username, keyword_matched, status, error_message)
          VALUES ('follow_gate_sent', ?, ?, ?, ?, ?, ?, ?, 'pending', 'Aguardando follow')
        `).run(accountId, rule.id, commentId, postId, fromId, fromUsername, matched);
      } catch (err) {
        const m = err.response?.data?.error?.message || err.message;
        console.error('[WEBHOOK] Choice DM failed:', m);
        db.prepare(`INSERT INTO logs (event_type, account_id, rule_id, comment_id, post_id, user_id, username, keyword_matched, status, error_message)
          VALUES ('dm_failed', ?, ?, ?, ?, ?, ?, ?, 'error', ?)
        `).run(accountId, rule.id, commentId, postId, fromId, fromUsername, matched, m);
      }
      break;
    }

    if (rule.comment_reply) {
      await replyToComment(commentId, msg.applyVars(rule.comment_reply, vars), account, rule, postId, fromId, fromUsername, matched);
    }

    const blocks = msg.resolveRuleBlocks(rule);
    if (blocks.length && fromId) {
      await sendRuleDM(fromId, fromUsername, blocks, vars, account, rule, commentId, postId, matched);
    }

    if (fromId) {
      db.prepare(`
        INSERT INTO user_rule_sent (user_id, rule_id, sent_at)
        VALUES (?, ?, unixepoch())
        ON CONFLICT(user_id, rule_id) DO UPDATE SET sent_at = unixepoch()
      `).run(fromId, rule.id);
    }
    break;
  }
}

// ────────────────────────────────────────────────
// Direct message handler
// ────────────────────────────────────────────────
async function handleMessage(messaging, account) {
  const senderId  = messaging.sender?.id;
  const accountId = account?.id || null;

  if (!senderId || !account) return;
  // Echo of our own outbound message
  if (senderId === account.instagram_user_id || messaging.message?.is_echo) return;

  const username = messaging.sender?.username || null;

  // Record inbound message into the conversation
  const incomingText = messaging.message?.text || null;
  const attachments  = messaging.message?.attachments || null;
  const quickReply   = messaging.message?.quick_reply;

  const isStoryReply = !!messaging.message?.reply_to?.story;

  if (incomingText || attachments || quickReply) {
    msg.recordInbound(account, senderId, username, {
      text: incomingText || (quickReply ? quickReply.title || incomingText : null),
      type: attachments ? 'image' : 'text',
      payload: attachments ? { attachments } : null,
      igMessageId: messaging.message?.mid || null
    });
  }

  const qp = quickReply?.payload;

  // DM / story-reply keyword trigger (rules with trigger_dm = 1) — só quando NÃO é um botão do gate
  if (incomingText && !GATE_PAYLOADS.includes(qp)) {
    await handleDmTrigger(senderId, username || 'unknown', incomingText, account, isStoryReply, messaging.message?.mid);
  }

  // Só os botões do follow-gate seguem daqui pra baixo
  if (!GATE_PAYLOADS.includes(qp)) return;
  console.log(`[WEBHOOK] Botão do gate (${qp}) de ${senderId}`);

  const pending = db.prepare(`
    SELECT pfs.*, r.dm_message, r.dm_blocks, r.bonus_blocks, r.keywords, r.follow_prompt_message
    FROM pending_follow_sends pfs
    JOIN rules r ON pfs.rule_id = r.id
    WHERE pfs.user_id = ? AND pfs.account_id = ? AND pfs.expires_at > unixepoch()
    ORDER BY pfs.created_at DESC LIMIT 1
  `).get(senderId, accountId);

  const uname = pending?.username || username || 'amigo';
  if (!pending) {
    await msg.sendText(account, senderId, uname, '⏰ Sua solicitação expirou. Comente novamente para receber o conteúdo!').catch(() => {});
    return;
  }
  const vars = { username: uname, keyword: pending.keywords?.split(',')[0]?.trim() || '' };

  // "Só o link" → entrega direto, sem bônus, sem checar follow
  if (qp === JUST_SEND) {
    await deliverPending(account, senderId, uname, pending, vars, accountId, false);
    return;
  }

  // "Seguir + bônus" → marca no pending, cai no fluxo de checagem de follow
  if (qp === FOLLOW_BONUS) {
    db.prepare('UPDATE pending_follow_sends SET wants_bonus = 1 WHERE user_id = ? AND rule_id = ?')
      .run(senderId, pending.rule_id);
    pending.wants_bonus = 1;
  }

  // "Seguir e receber" ou "Já te segui" → confere o follow
  const follows = await checkFollows(senderId, account.instagram_user_id, account.access_token);
  if (follows === false) {
    await sendFollowPrompt(account, senderId, uname, pending.follow_prompt_message, vars);
    db.prepare(`INSERT INTO logs (event_type, account_id, rule_id, user_id, username, status, error_message)
      VALUES ('follow_check_failed', ?, ?, ?, ?, 'pending', 'Ainda não segue — pedi pra seguir')
    `).run(accountId, pending.rule_id, senderId, uname);
    return;
  }
  // segue (ou indeterminado) → entrega com bônus se marcado
  await deliverPending(account, senderId, uname, pending, vars, accountId, !!pending.wants_bonus);
}

// Entrega o conteúdo pendente + (opcional) bônus, registra e limpa
async function deliverPending(account, userId, uname, pending, vars, accountId, includeBonus = false) {
  const blocks = msg.resolveRuleBlocks(pending);
  try {
    if (blocks.length) await msg.sendBlocks(account, userId, uname, blocks, vars, { source: 'auto' });
    db.prepare(`INSERT INTO logs (event_type, account_id, rule_id, user_id, username, status)
      VALUES ('dm_sent', ?, ?, ?, ?, 'ok')`).run(accountId, pending.rule_id, userId, uname);
    console.log(`[WEBHOOK] Conteúdo entregue para @${uname}`);

    // Bônus: entrega uma mensagem extra se a regra tiver bonus_blocks e a pessoa pediu
    if (includeBonus && pending.bonus_blocks) {
      try {
        const bonus = JSON.parse(pending.bonus_blocks);
        if (Array.isArray(bonus) && bonus.length) {
          // pequeno delay pra parecer natural
          await new Promise(r => setTimeout(r, 800));
          await msg.sendBlocks(account, userId, uname, bonus, vars, { source: 'auto' });
          db.prepare(`INSERT INTO logs (event_type, account_id, rule_id, user_id, username, status, error_message)
            VALUES ('dm_sent', ?, ?, ?, ?, 'ok', 'bônus por seguir')`).run(accountId, pending.rule_id, userId, uname);
          console.log(`[WEBHOOK] Bônus entregue para @${uname}`);
        }
      } catch (e) { console.warn('[WEBHOOK] Falha ao enviar bônus:', e.message); }
    }
  } catch (err) {
    db.prepare(`INSERT INTO logs (event_type, account_id, rule_id, user_id, username, status, error_message)
      VALUES ('dm_failed', ?, ?, ?, ?, 'error', ?)`).run(accountId, pending.rule_id, userId, uname, err.message);
  }
  db.prepare(`INSERT INTO user_rule_sent (user_id, rule_id, sent_at) VALUES (?, ?, unixepoch())
    ON CONFLICT(user_id, rule_id) DO UPDATE SET sent_at = unixepoch()`).run(userId, pending.rule_id);
  db.prepare('DELETE FROM pending_follow_sends WHERE user_id = ? AND rule_id = ?').run(userId, pending.rule_id);
}

// ────────────────────────────────────────────────
// DM / story-reply keyword trigger
// ────────────────────────────────────────────────
async function handleDmTrigger(userId, username, text, account, isStoryReply, mid) {
  // Dedup per message id
  if (mid) {
    const key = 'dm_' + mid;
    if (db.prepare('INSERT OR IGNORE INTO processed_comments (comment_id) VALUES (?)').run(key).changes === 0) return;
  }

  const lower = text.toLowerCase();
  const rules = db.prepare(`
    SELECT * FROM rules
    WHERE active = 1 AND trigger_dm = 1 AND (account_id = ? OR account_id IS NULL)
    ORDER BY priority, created_at
  `).all(account.id);

  for (const rule of rules) {
    const keywords = rule.keywords.split(',').map(k => k.trim()).filter(Boolean);
    const matched  = keywords.find(k => lower.includes(k));
    if (!matched) continue;

    // Cooldown
    if (rule.cooldown_hours > 0) {
      const last = db.prepare('SELECT sent_at FROM user_rule_sent WHERE user_id = ? AND rule_id = ?').get(userId, rule.id);
      if (last && (Math.floor(Date.now() / 1000) - last.sent_at) < rule.cooldown_hours * 3600) return;
    }

    const vars = { username, keyword: matched };
    const blocks = msg.resolveRuleBlocks(rule);
    if (blocks.length) {
      try {
        await msg.sendBlocks(account, userId, username, blocks, vars, { source: 'auto' });
        db.prepare(`INSERT INTO logs (event_type, account_id, rule_id, user_id, username, keyword_matched, status, error_message)
          VALUES ('dm_sent', ?, ?, ?, ?, ?, 'ok', ?)
        `).run(account.id, rule.id, userId, username, matched, isStoryReply ? 'via story reply' : 'via DM');
      } catch (err) {
        db.prepare(`INSERT INTO logs (event_type, account_id, rule_id, user_id, username, keyword_matched, status, error_message)
          VALUES ('dm_failed', ?, ?, ?, ?, ?, 'error', ?)
        `).run(account.id, rule.id, userId, username, matched, err.message);
      }
    }
    db.prepare(`INSERT INTO user_rule_sent (user_id, rule_id, sent_at) VALUES (?, ?, unixepoch())
      ON CONFLICT(user_id, rule_id) DO UPDATE SET sent_at = unixepoch()`).run(userId, rule.id);
    return; // first matching rule only
  }
}

// ────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────
// DM inicial com 2 opções: só link / seguir e receber
// commentId: 1ª mensagem depois de um comentário precisa ir como "resposta
// privada" (recipient.comment_id) — ver lib/messaging.js buildRecipient().
async function sendChoiceDM(userId, username, rule, account, vars, commentId) {
  const defaultPrompt = `Oi @{{username}}! 👋\n\nComo você prefere receber?`;
  const text = msg.applyVars(rule.follow_prompt_message || defaultPrompt, vars);
  const buttons = [];
  // No modo "escolha" (allow_skip=1) a pessoa pode receber sem seguir.
  // No modo estrito (allow_skip=0) só segue mesmo — sem o atalho "Só o link".
  if (rule.allow_skip) buttons.push({ content_type: 'text', title: '⏭️ Não seguir, só o link', payload: JUST_SEND });
  buttons.push({ content_type: 'text', title: '🧡 Seguir e receber', payload: FOLLOW_GET });
  await msg.sendQuickReply(account, userId, username, text, buttons, { commentId });
  console.log(`[WEBHOOK] Choice DM sent to ${userId} (${buttons.length} botões)`);
}

// Escolheu "Seguir" mas ainda não segue → link direto do perfil + botão "Já te segui"
async function sendFollowPrompt(account, userId, uname, customPrompt, vars) {
  const igUser = account.username || 'este_perfil';
  const defaultPrompt =
    `Quase lá @{{username}}! 😊\n\n1️⃣ Toca aqui pra abrir meu perfil: instagram.com/${igUser}\n2️⃣ Toca em "Seguir"\n3️⃣ Volta aqui e clica no botão abaixo 👇`;
  const text = msg.applyVars(defaultPrompt, vars);
  try {
    await msg.sendQuickReply(account, userId, uname, text, [{ content_type: 'text', title: '✅ Já te segui', payload: FOLLOW_PAYLOAD }]);
  } catch (err) {
    console.error('[WEBHOOK] Follow prompt failed:', err.response?.data?.error?.message || err.message);
  }
}

async function sendRuleDM(userId, username, blocks, vars, account, rule, commentId, postId, matched) {
  try {
    await msg.sendBlocks(account, userId, username, blocks, vars, { source: 'auto', commentId });
    db.prepare(`INSERT INTO logs (event_type, account_id, rule_id, comment_id, post_id, user_id, username, keyword_matched, status)
      VALUES ('dm_sent', ?, ?, ?, ?, ?, ?, ?, 'ok')
    `).run(account.id, rule.id, commentId, postId, userId, username, matched);
  } catch (err) {
    db.prepare(`INSERT INTO logs (event_type, account_id, rule_id, comment_id, post_id, user_id, username, keyword_matched, status, error_message)
      VALUES ('dm_failed', ?, ?, ?, ?, ?, ?, ?, 'error', ?)
    `).run(account.id, rule.id, commentId, postId, userId, username, matched, err.message);
    // Retry only the first text block for simplicity
    const firstText = blocks.find(b => b.type === 'text');
    if (firstText) queueRetry('dm', account.id, commentId, rule.id, userId, postId, username, msg.applyVars(firstText.text, vars));
  }
}

// Returns: true (follows), false (does not follow), or null (could not determine).
// Uses the Instagram messaging User Profile API field `is_user_follow_business`,
// which is the only officially-supported way to know if a specific user follows you.
// It only works for IGSIDs that have messaged the account (i.e. the follow-gate flow,
// where we already have a messaging context). Requires the `instagram_manage_messages`
// permission with Advanced Access.
async function checkFollows(userId, igAccountId, token) {
  if (!userId) return null;
  try {
    const res = await api.get(`https://graph.instagram.com/v21.0/${userId}`, {
      params: { fields: 'is_user_follow_business,is_business_follow_user', access_token: token }
    });
    if (typeof res.data?.is_user_follow_business === 'boolean') {
      return res.data.is_user_follow_business;
    }
    return null; // field not returned → unknown
  } catch (err) {
    console.warn('[FOLLOW CHECK]', err.response?.data?.error?.message || err.message);
    return null; // unknown
  }
}

async function replyToComment(commentId, message, account, rule, postId, fromId, fromUsername, matched) {
  try {
    await api.post(`https://graph.instagram.com/v21.0/${commentId}/replies`, { message, access_token: account.access_token });
    db.prepare(`INSERT INTO logs (event_type, account_id, rule_id, comment_id, post_id, user_id, username, keyword_matched, status)
      VALUES ('comment_reply_sent', ?, ?, ?, ?, ?, ?, ?, 'ok')
    `).run(account.id, rule.id, commentId, postId, fromId, fromUsername, matched);
  } catch (err) {
    const m = err.response?.data?.error?.message || err.message;
    db.prepare(`INSERT INTO logs (event_type, account_id, rule_id, comment_id, post_id, user_id, username, keyword_matched, status, error_message)
      VALUES ('comment_reply_failed', ?, ?, ?, ?, ?, ?, ?, 'error', ?)
    `).run(account.id, rule.id, commentId, postId, fromId, fromUsername, matched, m);
    queueRetry('comment_reply', account.id, commentId, rule.id, fromId, postId, fromUsername, message);
  }
}

function queueRetry(actionType, accountId, commentId, ruleId, recipientId, postId, username, message) {
  db.prepare(`INSERT INTO retry_queue (action_type, account_id, comment_id, rule_id, recipient_id, post_id, username, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(actionType, accountId, commentId, ruleId, recipientId, postId, username, message);
}

// ── Retry processor ──
async function processRetryQueue() {
  const now   = Math.floor(Date.now() / 1000);
  const items = db.prepare(`
    SELECT * FROM retry_queue
    WHERE status = 'pending' AND next_retry_at <= ? AND attempts < max_attempts
    LIMIT 10
  `).all(now);

  for (const item of items) {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(item.account_id);
    if (!account) { db.prepare("UPDATE retry_queue SET status='failed', last_error='Account not found' WHERE id = ?").run(item.id); continue; }
    const attempts = item.attempts + 1;
    const backoff  = [300, 900, 1800][attempts - 1] || 1800;
    try {
      if (item.action_type === 'comment_reply') {
        await api.post(`https://graph.instagram.com/v21.0/${item.comment_id}/replies`, { message: item.message, access_token: account.access_token });
      } else {
        await msg.sendText(account, item.recipient_id, item.username, item.message, { source: 'auto' });
      }
      db.prepare("UPDATE retry_queue SET status='done', attempts=? WHERE id = ?").run(attempts, item.id);
      console.log(`[RETRY] Success attempt ${attempts} for #${item.id}`);
    } catch (err) {
      const m = err.response?.data?.error?.message || err.message;
      const status = attempts >= item.max_attempts ? 'failed' : 'pending';
      db.prepare("UPDATE retry_queue SET attempts=?, status=?, last_error=?, next_retry_at=? WHERE id = ?")
        .run(attempts, status, m, now + backoff, item.id);
    }
  }

  db.prepare("DELETE FROM pending_follow_sends WHERE expires_at < unixepoch()").run();
}

module.exports = router;
module.exports.processRetryQueue = processRetryQueue;
