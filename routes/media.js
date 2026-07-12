const express = require('express');
const axios = require('axios');
const db = require('../database');

const router = express.Router();
const api = axios.create({ timeout: 12000 });
const GRAPH = 'https://graph.instagram.com/v21.0';

// Lista os posts/reels mais recentes da conta (para o seletor de post)
router.get('/', async (req, res) => {
  const { account_id } = req.query;
  const account = account_id
    ? db.prepare('SELECT * FROM accounts WHERE id = ?').get(account_id)
    : db.prepare('SELECT * FROM accounts ORDER BY created_at LIMIT 1').get();

  if (!account) return res.status(400).json({ error: 'Nenhuma conta conectada. Conecte seu Instagram primeiro.' });

  try {
    const r = await api.get(`${GRAPH}/${account.instagram_user_id}/media`, {
      params: {
        fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp',
        limit: 24,
        access_token: account.access_token
      }
    });
    const posts = (r.data?.data || []).map(m => ({
      id: m.id,
      caption: (m.caption || '').replace(/\s+/g, ' ').slice(0, 60),
      type: m.media_type,                                   // IMAGE | VIDEO | CAROUSEL_ALBUM
      thumb: m.media_type === 'VIDEO' ? (m.thumbnail_url || m.media_url) : m.media_url,
      permalink: m.permalink,
      timestamp: m.timestamp
    }));
    res.json({ posts, account: '@' + (account.username || account.instagram_user_id) });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    res.status(502).json({ error: msg });
  }
});

module.exports = router;
