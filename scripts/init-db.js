require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const EXPORTS_DIR = path.join(__dirname, '..', 'exports');
['douglas', 'nakai'].forEach(u => {
  const d = path.join(EXPORTS_DIR, u);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── Hub DB ────────────────────────────────────────────────────────────────────
const hub = new Database(path.join(DATA_DIR, 'hub.db'));
hub.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    title TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    is_cv_context INTEGER DEFAULT 0,
    context_depth INTEGER DEFAULT 20,
    created_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(user, slug)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    project_id TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    user TEXT NOT NULL,
    model TEXT,
    endpoint TEXT,
    search_used INTEGER DEFAULT 0,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost_usd REAL,
    ts INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY(conversation_id) REFERENCES conversations(id),
    FOREIGN KEY(project_id) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS model_config (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    model_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    search TEXT NOT NULL DEFAULT 'rag',
    enabled INTEGER DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id);
  CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user);
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    project_id TEXT,
    filename TEXT NOT NULL,
    mimetype TEXT,
    size_bytes INTEGER,
    markdown TEXT NOT NULL,
    uploaded_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY(project_id) REFERENCES projects(id)
  );

  CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);
  CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user);
`);

// Seed known projects for Douglas
const seedProjects = [
  { slug: 'tino', name: 'Tino' },
  { slug: 'block-audit', name: 'Block Audit' },
  { slug: 'beacon', name: 'Beacon' },
  { slug: 'western-union', name: 'Western Union' },
  { slug: 'second-brain', name: 'Second Brain' },
  { slug: 'cv', name: 'CV', is_cv_context: 1 },
];

const insertProject = hub.prepare(`
  INSERT OR IGNORE INTO projects (id, user, name, slug, is_cv_context)
  VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?)
`);

for (const p of seedProjects) {
  insertProject.run('douglas', p.name, p.slug, p.is_cv_context || 0);
}

hub.close();

// ── Per-user portfolio DBs ────────────────────────────────────────────────────
function initPortfolioDb(name) {
  const db = new Database(path.join(DATA_DIR, `${name}.db`));
  db.exec(`
    CREATE TABLE IF NOT EXISTS cv_context (
      id TEXT PRIMARY KEY,
      section TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS experiences (
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      description TEXT,
      is_cv_context INTEGER DEFAULT 1,
      display_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      level TEXT NOT NULL CHECK(level IN ('strong','moderate','gap')),
      category TEXT,
      display_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS portfolio_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_portfolio_session ON portfolio_messages(session_id);
  `);
  db.close();
}

initPortfolioDb('douglas');
initPortfolioDb('nakai');

console.log('✓ Databases initialised');
console.log('  /data/hub.db');
console.log('  /data/douglas.db');
console.log('  /data/nakai.db');
