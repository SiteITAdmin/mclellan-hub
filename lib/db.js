const Database = require('better-sqlite3');
const path = require('path');
const { getAiAssistedBuildsText } = require('./aiBuilds');

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
    addCol('ALTER TABLE model_config ADD COLUMN category TEXT');
    addCol('ALTER TABLE model_config ADD COLUMN cost_input REAL');
    addCol('ALTER TABLE model_config ADD COLUMN cost_output REAL');
    addCol('ALTER TABLE model_config ADD COLUMN context_length INTEGER');
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
    // Memory compaction flag on messages
    addLogCol('ALTER TABLE messages ADD COLUMN compacted INTEGER DEFAULT 0');
    // Wiki tag subscriptions on projects and contacts
    addCol('ALTER TABLE projects ADD COLUMN wiki_tags TEXT DEFAULT \'[]\'');
    addCol('ALTER TABLE contacts ADD COLUMN wiki_tags TEXT DEFAULT \'[]\'');
    // Model tiers (user-manageable groupings for the model picker)
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS model_tiers (
        key TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        search_default TEXT DEFAULT 'web-plugin',
        display_order INTEGER DEFAULT 0
      );
    `);
    // Seed built-in tiers if the table is empty
    if (!_hub.prepare('SELECT 1 FROM model_tiers LIMIT 1').get()) {
      const seedTiers = [
        ['everyday',      'Everyday',      'web-plugin', 0],
        ['news-research', 'Live News',      'native',     1],
        ['deep-research', 'Deep Research',  'web-plugin', 2],
        ['coding',        'Coding',         'none',       3],
        ['project',       'Project',        'web-plugin', 4],
        ['image',         'Image',          'none',       5],
      ];
      const ins = _hub.prepare('INSERT OR IGNORE INTO model_tiers (key, label, search_default, display_order) VALUES (?, ?, ?, ?)');
      for (const row of seedTiers) ins.run(...row);
    }
    // Chat shortcuts (welcome screen quick-start cards)
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS chat_shortcuts (
        id TEXT PRIMARY KEY,
        user TEXT,
        kicker TEXT NOT NULL,
        icon TEXT DEFAULT '◎',
        label TEXT NOT NULL,
        desc TEXT,
        model_key TEXT NOT NULL,
        search TEXT,
        display_order INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_shortcuts_user ON chat_shortcuts(user);
    `);

    // Model test arena logs (capped at 5 per user via app-level pruning)
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS test_runs (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        question TEXT NOT NULL,
        run_at INTEGER NOT NULL DEFAULT (unixepoch()),
        results TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_test_runs_user ON test_runs(user, run_at DESC);
    `);

    // CRM: contacts, facts, world context
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        name TEXT NOT NULL,
        aliases TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user);

      CREATE TABLE IF NOT EXISTS crm_facts (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        contact_id TEXT NOT NULL REFERENCES contacts(id),
        fact TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL DEFAULT 'dchat',
        parent_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_crm_facts_user_contact ON crm_facts(user, contact_id);
      CREATE INDEX IF NOT EXISTS idx_crm_facts_status ON crm_facts(user, status);

      CREATE TABLE IF NOT EXISTS crm_context (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(user, key)
      );
      CREATE INDEX IF NOT EXISTS idx_crm_context_user ON crm_context(user);

      CREATE TABLE IF NOT EXISTS crm_briefing_log (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        sent_at INTEGER NOT NULL DEFAULT (unixepoch()),
        date_str TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS email_summaries (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        gmail_message_id TEXT UNIQUE,
        subject TEXT,
        from_name TEXT,
        from_email TEXT,
        received_at INTEGER,
        summary TEXT,
        project_slug TEXT,
        contact_id TEXT,
        processed_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_email_summaries_user_ts ON email_summaries(user, received_at DESC);
    `);

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

    // LinkedIn content pipeline posts
    _hub.exec(`
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
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_linkedin_posts_user ON linkedin_posts(user, created_at DESC);
    `);
    const addLiCol = (sql) => { try { _hub.exec(sql); } catch (_) {} };
    addLiCol('ALTER TABLE linkedin_posts ADD COLUMN content_type TEXT NOT NULL DEFAULT \'\'');

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

  if (user === 'douglas') {
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
