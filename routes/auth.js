const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const db = require('../database');

const router = express.Router();
const api = axios.create({ timeout: 15000 });

// ── Instagram API with Instagram Login (newer, simpler flow) ──
const IG_AUTH  = 'https://www.instagram.com/oauth/authorize';
const IG_TOKEN = 'https://api.instagram.com/oauth/access_token';
const IG_GRAPH = 'https://graph.instagram.com';

const SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments'
].join(',');

router.get('/login', (req, res) => {
  const { INSTAGRAM_APP_ID, BASE_URL } = process.env;
  const redirectUri = `${BASE_URL}/auth/callback`;
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const url = `${IG_AUTH}?client_id=${INSTAGRAM_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code&scope=${encodeURIComponent(SCOPES)}&state=${state}`;
  res.redirect(url);
});

router.get('/callback', async (req, res) => {
  const { code, error, error_description, state } = req.query;

  if (error) return res.redirect(`/?error=${encodeURIComponent(error_description || error)}`);
  if (!state || state !== req.session.oauthState) {
    return res.redirect('/?error=Invalid+OAuth+state.+Tente+novamente.');
  }
  delete req.session.oauthState;

  const { INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, BASE_URL } = process.env;
  const redirectUri = `${BASE_URL}/auth/callback`;

  try {
    // 1. code → short-lived token (form-encoded POST)
    const form = new URLSearchParams({
      client_id: INSTAGRAM_APP_ID,
      client_secret: INSTAGRAM_APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code
    });
    const tokenRes = await api.post(IG_TOKEN, form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const shortToken = tokenRes.data.access_token;

    // 2. short → long-lived token (~60 days)
    const longRes = await api.get(`${IG_GRAPH}/access_token`, {
      params: { grant_type: 'ig_exchange_token', client_secret: INSTAGRAM_APP_SECRET, access_token: shortToken }
    });
    const longToken = longRes.data.access_token || shortToken;
    const expiresIn = longRes.data.expires_in || 5184000;

    // 3. IMPORTANT: fetch /me to get the CORRECT id.
    // The user_id returned by /oauth/access_token loses precision (JS bigint) and
    // does NOT match the id needed for /subscribed_apps and /messages endpoints.
    // The /me endpoint returns the actual usable id.
    let igUserId, username;
    try {
      const me = await api.get(`${IG_GRAPH}/me`, {
        params: { fields: 'id,user_id,username,account_type', access_token: longToken }
      });
      igUserId = String(me.data.id);           // é este ID que as APIs aceitam
      username = me.data.username || igUserId;
    } catch (e) {
      // Fallback (shouldn't happen with a valid token)
      igUserId = String(tokenRes.data.user_id);
      username = igUserId;
    }

    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

    db.prepare(`
      INSERT INTO accounts (access_token, instagram_user_id, username, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(instagram_user_id) DO UPDATE SET
        access_token = excluded.access_token,
        username     = excluded.username,
        expires_at   = excluded.expires_at
    `).run(longToken, igUserId, username, expiresAt);

    req.session.authenticated = true;
    res.redirect('/?success=connected&username=' + encodeURIComponent(username));
  } catch (err) {
    console.error('[AUTH ERROR]', err.response?.data || err.message);
    res.redirect('/?error=' + encodeURIComponent('Erro na autenticação. Confira App ID/Secret do Instagram e a URI de redirecionamento.'));
  }
});

router.get('/status', (req, res) => {
  const accounts = db.prepare('SELECT id, instagram_user_id, username, label, expires_at FROM accounts ORDER BY created_at').all();
  if (!accounts.length) return res.json({ connected: false, accounts: [] });

  const now = Math.floor(Date.now() / 1000);
  const enriched = accounts.map(a => ({
    ...a,
    connected: !a.expires_at || a.expires_at > now,
    days_until_expiry: a.expires_at ? Math.max(0, Math.floor((a.expires_at - now) / 86400)) : null
  }));
  res.json({ connected: enriched.some(a => a.connected), accounts: enriched });
});

module.exports = router;
