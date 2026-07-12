require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors    = require('cors');
const path    = require('path');

const authRoutes     = require('./routes/auth');
const accountsRoutes = require('./routes/accounts');
const rulesRoutes    = require('./routes/rules');
const webhookRoutes  = require('./routes/webhook');
const logsRoutes     = require('./routes/logs');
const convRoutes     = require('./routes/conversations');
const flowsRoutes    = require('./routes/flows');
const contactsRoutes = require('./routes/contacts');
const mediaRoutes    = require('./routes/media');
const { processRetryQueue } = require('./routes/webhook');
const { processFlowRuns } = require('./lib/flow-engine');

const app  = express();
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD;

app.set('trust proxy', 1); // for secure cookies behind ngrok/Railway/etc.
app.use(cors());

// Capture raw body (needed for webhook signature verification)
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'instabot-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: 'auto', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ── App password gate ──
function requireAppAuth(req, res, next) {
  if (!APP_PASSWORD) return next();                         // no password configured → open (local dev)
  if (req.session?.appAuth) return next();                  // logged in
  if (req.path.startsWith('/webhook')) return next();       // Meta calls this — protected by signature instead
  if (req.path === '/api/app/login' || req.path === '/api/app/status') return next();
  if (['/', '/index.html', '/style.css', '/app.js', '/favicon.ico'].includes(req.path)) return next(); // login shell
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado' });
  if (req.path.startsWith('/auth/')) return res.redirect('/');
  return next(); // any other path → SPA shell (shows login overlay)
}
app.use(requireAppAuth);

// ── App auth endpoints ──
app.get('/api/app/status', (req, res) => {
  res.json({ protected: !!APP_PASSWORD, authed: !APP_PASSWORD || !!req.session?.appAuth });
});
app.post('/api/app/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true });
  if (req.body?.password === APP_PASSWORD) { req.session.appAuth = true; return res.json({ ok: true }); }
  return res.status(401).json({ error: 'Senha incorreta' });
});
app.post('/api/app/logout', (req, res) => { if (req.session) req.session.appAuth = false; res.json({ ok: true }); });

app.use(express.static(path.join(__dirname, 'public')));

app.use('/auth',              authRoutes);
app.use('/api/accounts',      accountsRoutes);
app.use('/api/rules',         rulesRoutes);
app.use('/webhook',           webhookRoutes);
app.use('/api/logs',          logsRoutes);
app.use('/api/conversations', convRoutes);
app.use('/api/flows',         flowsRoutes);
app.use('/api/contacts',      contactsRoutes);
app.use('/api/media',         mediaRoutes);

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Retry queue processor — every 60s
setInterval(() => {
  processRetryQueue().catch(err => console.error('[RETRY] Processor error:', err.message));
}, 60000);

// Flow delay processor — every 30s (resumes waiting flow runs)
setInterval(() => {
  processFlowRuns().catch(err => console.error('[FLOW] Processor error:', err.message));
}, 30000);

app.listen(PORT, () => {
  console.log(`\n🚀 InstaBot running at http://localhost:${PORT}`);
  console.log(`   Webhook: ${process.env.BASE_URL || 'http://localhost:' + PORT}/webhook`);
  if (!APP_PASSWORD)                console.warn('   ⚠  APP_PASSWORD não definido — painel SEM senha (ok para teste local, NÃO para hospedar)');
  if (!process.env.INSTAGRAM_APP_SECRET) console.warn('   ⚠  INSTAGRAM_APP_SECRET não definido — assinatura do webhook NÃO será verificada');
  console.log('');
});
