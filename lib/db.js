const Database = require('better-sqlite3');
const path = require('path');
const { getAiAssistedBuildsText } = require('./aiBuilds');
const { syncDouglasVerifiedEmployment } = require('./verifiedEmployment');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HUB_DB_PATH = process.env.HUB_DB_PATH
  ? path.resolve(process.env.HUB_DB_PATH)
  : path.join(DATA_DIR, 'hub.db');

let _hub, _douglas, _nakai;

// Version Old's hub.db carried ~200 tables. The retool (24 Oct 2026) keeps only
// what the flight tracker, sign-in, and the public sites read.
function hub() {
  if (!_hub) {
    _hub = new Database(HUB_DB_PATH);
    _hub.pragma('journal_mode = WAL');
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS flights (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        flight_number TEXT NOT NULL DEFAULT '',
        airline TEXT NOT NULL DEFAULT '',
        direction TEXT NOT NULL,
        flight_date TEXT NOT NULL,
        scheduled_dep TEXT NOT NULL DEFAULT '',
        actual_dep TEXT NOT NULL DEFAULT '',
        scheduled_arr TEXT NOT NULL DEFAULT '',
        actual_arr TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'completed',
        notes TEXT NOT NULL DEFAULT '',
        tracker_url TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_flights_user_date ON flights(user, flight_date DESC);

      CREATE TABLE IF NOT EXISTS system_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        run_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        ran_at INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        source TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_system_jobs_pending ON system_jobs(status, run_at);
      CREATE INDEX IF NOT EXISTS idx_system_jobs_type ON system_jobs(type, status);

      CREATE TABLE IF NOT EXISTS crm_context (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(user, key)
      );
      CREATE INDEX IF NOT EXISTS idx_crm_context_user ON crm_context(user);

      CREATE TABLE IF NOT EXISTS model_config (
        key TEXT PRIMARY KEY, label TEXT NOT NULL, endpoint TEXT NOT NULL, model_id TEXT NOT NULL,
        tier TEXT NOT NULL, search TEXT NOT NULL DEFAULT 'rag', enabled INTEGER DEFAULT 1, user TEXT,
        base_url TEXT, api_key_env TEXT, display_order INTEGER DEFAULT 0, api_key TEXT, category TEXT,
        cost_input REAL, cost_output REAL, context_length INTEGER, brave_tested INTEGER DEFAULT 0,
        brave_tested_at TEXT, brave_preview TEXT
      );

      CREATE TABLE IF NOT EXISTS linkedin_posts (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        topic TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT '',
        research TEXT NOT NULL DEFAULT '',
        draft TEXT NOT NULL DEFAULT '',
        refined_draft TEXT NOT NULL DEFAULT '',
        score_json TEXT NOT NULL DEFAULT '{}',
        carousel_url TEXT NOT NULL DEFAULT '',
        image_url TEXT NOT NULL DEFAULT '',
        sheet_url TEXT NOT NULL DEFAULT '',
        scheduled_date TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        spiciness TEXT NOT NULL DEFAULT 'professional',
        published_at INTEGER,
        post_url TEXT NOT NULL DEFAULT '',
        display_title TEXT NOT NULL DEFAULT '',
        quality_override INTEGER,
        quality_override_reason TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS subscription_agent_jobs (
        id TEXT PRIMARY KEY,
        feature TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        claim_token TEXT,
        claimed_at INTEGER,
        claimed_by TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        result_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_subscription_agent_jobs_status
        ON subscription_agent_jobs(status, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_agent_jobs_open
        ON subscription_agent_jobs(feature, dedupe_key)
        WHERE status IN ('pending', 'claimed');
    `);
  }
  return _hub;
}

function migratePortfolio(db, user) {
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
  addCol('ALTER TABLE projects ADD COLUMN google_task_list_id TEXT');

  if (user === 'douglas') {
    syncDouglasVerifiedEmployment(db);
    const exists = db.prepare(
      'SELECT 1 FROM cv_context WHERE section = ? LIMIT 1'
    ).get('ai_assisted_app_builds');
    if (!exists) {
      db.prepare(
        'INSERT INTO cv_context (id, section, content) VALUES (?, ?, ?)'
      ).run(
        Buffer.from(require('crypto').randomBytes(8)).toString('hex'),
        'ai_assisted_app_builds',
        getAiAssistedBuildsText()
      );
    }
  }
}

function portfolio(user) {
  if (user === 'douglas') {
    if (!_douglas) { _douglas = new Database(path.join(DATA_DIR, 'douglas.db')); migratePortfolio(_douglas, user); }
    return _douglas;
  }
  if (user === 'nakai') {
    if (!_nakai) { _nakai = new Database(path.join(DATA_DIR, 'nakai.db')); migratePortfolio(_nakai, user); }
    return _nakai;
  }
  throw new Error(`Unknown portfolio user: ${user}`);
}

module.exports = { hub, portfolio };
