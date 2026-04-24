const Database = require('better-sqlite3');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

let _hub, _douglas, _nakai;

function hub() {
  if (!_hub) {
    _hub = new Database(path.join(DATA_DIR, 'hub.db'));
    // Idempotent migration: ensure documents table exists on existing DBs
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        project_id TEXT,
        filename TEXT NOT NULL,
        mimetype TEXT,
        size_bytes INTEGER,
        markdown TEXT NOT NULL,
        uploaded_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);
      CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user);
    `);
    // model_config: add per-user columns + custom endpoint support
    const addCol = (sql) => { try { _hub.exec(sql); } catch (_) {} };
    addCol('ALTER TABLE model_config ADD COLUMN user TEXT');
    addCol('ALTER TABLE model_config ADD COLUMN base_url TEXT');
    addCol('ALTER TABLE model_config ADD COLUMN api_key_env TEXT');
    addCol('ALTER TABLE model_config ADD COLUMN display_order INTEGER DEFAULT 0');
    addCol('ALTER TABLE model_config ADD COLUMN api_key TEXT');
    // Rename legacy 'rag' search value → 'web-plugin' (OpenRouter web search)
    try { _hub.exec("UPDATE model_config SET search = 'web-plugin' WHERE search = 'rag'"); } catch (_) {}
    // Migrate tier names to new structure
    try { _hub.exec("UPDATE model_config SET tier = 'news-research' WHERE tier = 'research'"); } catch (_) {}
    try { _hub.exec("UPDATE model_config SET tier = 'deep-research' WHERE key = 'claude-sonnet' AND tier = 'superior'"); } catch (_) {}
    try { _hub.exec("UPDATE model_config SET tier = 'deep-research' WHERE key = 'claude-sonnet'"); } catch (_) {}
    // Ensure the free model exists and sorts first
    if (!_hub.prepare("SELECT 1 FROM model_config WHERE key = 'free'").get()) {
      _hub.prepare(`INSERT INTO model_config (key, label, endpoint, model_id, tier, search, enabled, display_order)
                    VALUES ('free', 'Free (OpenRouter)', 'openrouter', 'openrouter/auto', 'everyday', 'web-plugin', 1, -1)`)
          .run();
    } else {
      // Fix any wrong model IDs from earlier migrations
      _hub.prepare(`UPDATE model_config SET model_id = 'openrouter/free' WHERE key = 'free' AND model_id != 'openrouter/free'`)
          .run();
    }
    // Request log message ID columns (added after initial release)
    const addLogCol = (sql) => { try { _hub.exec(sql); } catch (_) {} };
    addLogCol('ALTER TABLE request_logs ADD COLUMN user_msg_id TEXT');
    addLogCol('ALTER TABLE request_logs ADD COLUMN asst_msg_id TEXT');
    addLogCol('ALTER TABLE request_logs ADD COLUMN rating INTEGER');

    // Long-term memory recall index
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS recall_entries (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        user TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        ts INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_recall_user_ts ON recall_entries(user, ts DESC);
    `);

    // Request logs for debugging
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS request_logs (
        id TEXT PRIMARY KEY,
        ts INTEGER DEFAULT (unixepoch()),
        user TEXT,
        conv_id TEXT,
        project_slug TEXT,
        model_key TEXT,
        model_id TEXT,
        endpoint TEXT,
        search_provider TEXT,
        search_used INTEGER DEFAULT 0,
        msg_chars INTEGER DEFAULT 0,
        context_count INTEGER DEFAULT 0,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        duration_ms INTEGER,
        status TEXT DEFAULT 'ok',
        error_msg TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rlogs_ts ON request_logs(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_rlogs_user ON request_logs(user);
    `);
  }
  return _hub;
}

function migratePortfolio(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      full_name TEXT, email TEXT, current_title TEXT, location TEXT,
      target_titles TEXT, target_company_stages TEXT,
      elevator_pitch TEXT, career_narrative TEXT,
      looking_for TEXT, not_looking_for TEXT,
      management_style TEXT, work_style TEXT,
      salary_min INTEGER, salary_max INTEGER, salary_currency TEXT DEFAULT 'EUR',
      availability_status TEXT, available_from TEXT, remote_preference TEXT,
      must_haves TEXT, dealbreakers TEXT,
      mgmt_prefs TEXT, team_size_prefs TEXT,
      conflict_handling TEXT, ambiguity_handling TEXT, failure_handling TEXT,
      honesty_level INTEGER DEFAULT 7,
      updated_at INTEGER DEFAULT (unixepoch())
    );
    INSERT OR IGNORE INTO profile (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS gaps (
      id TEXT PRIMARY KEY,
      gap_type TEXT NOT NULL,
      description TEXT,
      why TEXT,
      interested_in_learning INTEGER DEFAULT 0,
      display_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS faqs (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT,
      is_common INTEGER DEFAULT 0,
      display_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ai_instructions (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      display_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS jd_submissions (
      id TEXT PRIMARY KEY,
      job_description TEXT NOT NULL,
      ai_response TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS skill_candidates (
      id TEXT PRIMARY KEY,
      user TEXT NOT NULL,
      term TEXT NOT NULL,
      normalized_term TEXT NOT NULL,
      occurrences INTEGER DEFAULT 0,
      evidence TEXT,
      last_seen_at INTEGER,
      status TEXT DEFAULT 'pending',
      promoted_skill_id TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(user, normalized_term)
    );
  `);
  // Extend skills with new columns (idempotent via try/catch)
  const addCol = (sql) => { try { db.exec(sql); } catch (_) {} };
  addCol('ALTER TABLE profile ADD COLUMN phone_public TEXT');
  addCol('ALTER TABLE jd_submissions ADD COLUMN ai_response TEXT');
  addCol('ALTER TABLE skill_candidates ADD COLUMN promoted_skill_id TEXT');
  addCol('ALTER TABLE skills ADD COLUMN self_rating INTEGER');
  addCol('ALTER TABLE skills ADD COLUMN evidence TEXT');
  addCol('ALTER TABLE skills ADD COLUMN honest_notes TEXT');
  addCol('ALTER TABLE skills ADD COLUMN years_experience INTEGER');
  addCol('ALTER TABLE skills ADD COLUMN last_used TEXT');
}

function portfolio(user) {
  if (user === 'douglas') {
    if (!_douglas) { _douglas = new Database(path.join(DATA_DIR, 'douglas.db')); migratePortfolio(_douglas); }
    return _douglas;
  }
  if (user === 'nakai') {
    if (!_nakai) { _nakai = new Database(path.join(DATA_DIR, 'nakai.db')); migratePortfolio(_nakai); }
    return _nakai;
  }
  throw new Error(`Unknown portfolio user: ${user}`);
}

module.exports = { hub, portfolio };
