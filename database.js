const { DatabaseSync } = require('node:sqlite');
const path = require('path');

// DB_PATH permite apontar pra um volume persistente (ex: Railway) em produção.
const _db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'data.db'));

_db.exec('PRAGMA journal_mode = WAL');
_db.exec('PRAGMA foreign_keys = ON');

// ── Accounts (replaces auth, supports multiple) ──
_db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    access_token TEXT NOT NULL,
    instagram_user_id TEXT NOT NULL UNIQUE,
    username TEXT,
    label TEXT,
    token_type TEXT DEFAULT 'long_lived',
    expires_at INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
  )
`);

// ── Rules ──
_db.exec(`
  CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    keywords TEXT NOT NULL,
    comment_reply TEXT,
    dm_message TEXT,
    require_follow INTEGER DEFAULT 0,
    post_id TEXT,
    priority INTEGER DEFAULT 0,
    cooldown_hours INTEGER DEFAULT 24,
    active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  )
`);

// ── Logs ──
_db.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    account_id INTEGER,
    rule_id INTEGER,
    comment_id TEXT,
    post_id TEXT,
    user_id TEXT,
    username TEXT,
    keyword_matched TEXT,
    status TEXT DEFAULT 'ok',
    error_message TEXT,
    payload TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  )
`);

// ── Processed comments (deduplication) ──
_db.exec(`
  CREATE TABLE IF NOT EXISTS processed_comments (
    comment_id TEXT PRIMARY KEY,
    processed_at INTEGER DEFAULT (unixepoch())
  )
`);

// ── Rate limiting per user per rule ──
_db.exec(`
  CREATE TABLE IF NOT EXISTS user_rule_sent (
    user_id TEXT NOT NULL,
    rule_id INTEGER NOT NULL,
    sent_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, rule_id)
  )
`);

// ── Conversations (inbox) ──
_db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT,
    last_message TEXT,
    last_message_at INTEGER,
    last_direction TEXT,
    unread INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(account_id, user_id)
  )
`);

_db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    direction TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    text TEXT,
    payload TEXT,
    source TEXT DEFAULT 'auto',
    ig_message_id TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  )
`);
_db.exec('CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at)');

// ── Flows (visual flow builder) ──
_db.exec(`
  CREATE TABLE IF NOT EXISTS flows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    name TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    definition TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  )
`);

// ── Flow runs (per-user execution state, supports delays) ──
_db.exec(`
  CREATE TABLE IF NOT EXISTS flow_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flow_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT,
    comment_id TEXT,
    current_node_id TEXT,
    status TEXT DEFAULT 'running',
    resume_at INTEGER DEFAULT 0,
    context TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  )
`);
_db.exec('CREATE INDEX IF NOT EXISTS idx_flow_runs_resume ON flow_runs(status, resume_at)');

// ── Contacts (audience) ──
_db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT,
    tags TEXT,
    source TEXT,
    first_seen INTEGER DEFAULT (unixepoch()),
    last_seen INTEGER DEFAULT (unixepoch()),
    last_inbound_at INTEGER,
    UNIQUE(account_id, user_id)
  )
`);

// ── Pending follow-gate sends ──
_db.exec(`
  CREATE TABLE IF NOT EXISTS pending_follow_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    username TEXT,
    rule_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    comment_id TEXT,
    expires_at INTEGER DEFAULT (unixepoch() + 86400),
    created_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(user_id, rule_id)
  )
`);

// ── Retry queue ──
_db.exec(`
  CREATE TABLE IF NOT EXISTS retry_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_type TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    comment_id TEXT,
    rule_id INTEGER,
    recipient_id TEXT,
    post_id TEXT,
    username TEXT,
    message TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    next_retry_at INTEGER DEFAULT (unixepoch()),
    status TEXT DEFAULT 'pending',
    last_error TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  )
`);

// ── Migrate old auth table if exists ──
const hasOldAuth = _db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth'").get();
if (hasOldAuth) {
  console.log('[DB] Migrating auth → accounts...');
  _db.exec(`
    INSERT OR IGNORE INTO accounts (access_token, instagram_user_id, username, expires_at)
    SELECT access_token, instagram_user_id, username, expires_at FROM auth
  `);
  _db.exec('DROP TABLE auth');
}

// ── Migrate old rules (keyword → keywords) ──
const rulesInfo = _db.prepare("PRAGMA table_info(rules)").all();
const hasKeywordCol  = rulesInfo.some(c => c.name === 'keyword');
const hasKeywordsCol = rulesInfo.some(c => c.name === 'keywords');
if (hasKeywordCol && !hasKeywordsCol) {
  console.log('[DB] Migrating rules.keyword → rules.keywords...');
  _db.exec('ALTER TABLE rules ADD COLUMN keywords TEXT');
  _db.exec('UPDATE rules SET keywords = keyword WHERE keywords IS NULL');
  _db.exec(`CREATE TABLE rules_new AS SELECT
    id, NULL as account_id, keywords, comment_reply, dm_message,
    require_follow, NULL as post_id, 0 as priority, 24 as cooldown_hours,
    active, created_at, updated_at FROM rules`);
  _db.exec('DROP TABLE rules');
  _db.exec('ALTER TABLE rules_new RENAME TO rules');
} else if (!hasKeywordCol && !hasKeywordsCol) {
  // Fresh table already created above — nothing to do
}

// ── Migrate logs (add account_id if missing) ──
const logsInfo = _db.prepare("PRAGMA table_info(logs)").all();
if (!logsInfo.some(c => c.name === 'account_id')) {
  _db.exec('ALTER TABLE logs ADD COLUMN account_id INTEGER');
}

// ── Migrate rules (add follow_prompt_message if missing) ──
const rulesInfoNow = _db.prepare("PRAGMA table_info(rules)").all();
if (!rulesInfoNow.some(c => c.name === 'follow_prompt_message')) {
  _db.exec('ALTER TABLE rules ADD COLUMN follow_prompt_message TEXT');
}
// ── Migrate rules (add dm_blocks JSON for rich messages) ──
if (!rulesInfoNow.some(c => c.name === 'dm_blocks')) {
  _db.exec('ALTER TABLE rules ADD COLUMN dm_blocks TEXT');
}
// ── Migrate rules (add trigger_dm: also fire on DM/story keyword) ──
if (!rulesInfoNow.some(c => c.name === 'trigger_dm')) {
  _db.exec('ALTER TABLE rules ADD COLUMN trigger_dm INTEGER DEFAULT 0');
}
// ── Migrate rules (add match_type: 'specific' | 'any') ──
if (!rulesInfoNow.some(c => c.name === 'match_type')) {
  _db.exec("ALTER TABLE rules ADD COLUMN match_type TEXT DEFAULT 'specific'");
}
// ── Migrate rules (add bonus_blocks: extra message sent for "Seguir + bônus") ──
if (!rulesInfoNow.some(c => c.name === 'bonus_blocks')) {
  _db.exec("ALTER TABLE rules ADD COLUMN bonus_blocks TEXT");
}
// ── Migrate rules (add allow_skip: quando require_follow=1, se 1 mostra o botão
//    "Não seguir, só o link" (deixa escolher); se 0 é estrito (só seguindo).
//    Default 1 preserva o comportamento atual das regras já criadas. ──
if (!rulesInfoNow.some(c => c.name === 'allow_skip')) {
  _db.exec("ALTER TABLE rules ADD COLUMN allow_skip INTEGER DEFAULT 1");
}
// ── Migrate pending_follow_sends (add wants_bonus flag) ──
const pendInfo = _db.prepare("PRAGMA table_info(pending_follow_sends)").all();
if (!pendInfo.some(c => c.name === 'wants_bonus')) {
  _db.exec("ALTER TABLE pending_follow_sends ADD COLUMN wants_bonus INTEGER DEFAULT 0");
}

// ── Wrapper: normalise node:sqlite null-prototype rows + spread params ──
function toPlain(row) { return row ? Object.assign({}, row) : row; }

const db = {
  prepare(sql) {
    const stmt = _db.prepare(sql);
    return {
      run(...args)  { const r = stmt.run(...args); return { lastInsertRowid: r.lastInsertRowid, changes: r.changes }; },
      get(...args)  { return toPlain(stmt.get(...args)); },
      all(...args)  { return (stmt.all(...args) || []).map(toPlain); }
    };
  },
  exec(sql) { return _db.exec(sql); }
};

module.exports = db;
