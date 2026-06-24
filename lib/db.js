const Database = require('better-sqlite3');
const path = require('path');
const { getAiAssistedBuildsText } = require('./aiBuilds');
const { syncDouglasVerifiedEmployment } = require('./verifiedEmployment');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HUB_DB_PATH = process.env.HUB_DB_PATH
  ? path.resolve(process.env.HUB_DB_PATH)
  : path.join(DATA_DIR, 'hub.db');

let _hub, _douglas, _nakai;

function deduplicateRssData(database) {
  const duplicateFeeds = database.prepare(`
    SELECT user, url
    FROM rss_feeds
    GROUP BY user, url
    HAVING COUNT(*) > 1
  `).all();

  const migrateFeed = database.transaction((keeper, duplicate) => {
    database.prepare(`
      DELETE FROM rss_articles
      WHERE feed_id = ?
        AND EXISTS (
          SELECT 1 FROM rss_articles kept
          WHERE kept.feed_id = ?
            AND (kept.guid = rss_articles.guid OR kept.url = rss_articles.url)
        )
    `).run(duplicate.id, keeper.id);
    database.prepare(`
      UPDATE rss_articles
         SET feed_id = ?, creator_slug = ?
       WHERE feed_id = ?
    `).run(keeper.id, keeper.creator_slug, duplicate.id);
    database.prepare('DELETE FROM rss_feeds WHERE id = ?').run(duplicate.id);
  });

  for (const group of duplicateFeeds) {
    const rows = database.prepare(`
      SELECT * FROM rss_feeds
      WHERE user = ? AND url = ?
      ORDER BY created_at, id
    `).all(group.user, group.url);
    const [keeper, ...duplicates] = rows;
    for (const duplicate of duplicates) migrateFeed(keeper, duplicate);
  }

  database.exec(`
    DELETE FROM rss_articles
    WHERE id NOT IN (
      SELECT MIN(id) FROM rss_articles GROUP BY user, url
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rss_feeds_user_url
      ON rss_feeds(user, url);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rss_articles_user_url
      ON rss_articles(user, url);
  `);
}

function hub() {
  if (!_hub) {
    _hub = new Database(HUB_DB_PATH);
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
    addCol('ALTER TABLE model_config ADD COLUMN brave_tested INTEGER DEFAULT 0');
    addCol('ALTER TABLE model_config ADD COLUMN brave_tested_at TEXT');
    addCol('ALTER TABLE model_config ADD COLUMN brave_preview TEXT');
    addCol('ALTER TABLE documents ADD COLUMN task_extracted_at INTEGER');
    addCol('ALTER TABLE documents ADD COLUMN ingestion_package_path TEXT');
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
    // Built-in orchestrated research workflow. Its planner and synthesiser
    // models are configured separately under System models.
    _hub.prepare(`
      INSERT OR IGNORE INTO model_config
        (key, label, endpoint, model_id, tier, search, enabled, display_order, category)
      VALUES
        ('multi-search', 'Multi-search Research', 'multi-search', 'orchestrated',
         'deep-research', 'orchestrated', 1, -20, 'Research workflow')
    `).run();
    // Request log message ID columns (added after initial release)
    const addLogCol = (sql) => { try { _hub.exec(sql); } catch (_) {} };
    addLogCol('ALTER TABLE request_logs ADD COLUMN user_msg_id TEXT');
    addLogCol('ALTER TABLE request_logs ADD COLUMN asst_msg_id TEXT');
    addLogCol('ALTER TABLE request_logs ADD COLUMN rating INTEGER');
    addLogCol('ALTER TABLE request_logs ADD COLUMN task_code TEXT');
    // Memory compaction flag on messages
    addLogCol('ALTER TABLE messages ADD COLUMN compacted INTEGER DEFAULT 0');
    // Wiki tag subscriptions on projects and contacts
    addCol('ALTER TABLE projects ADD COLUMN wiki_tags TEXT DEFAULT \'[]\'');
    addCol("ALTER TABLE projects ADD COLUMN project_kind TEXT DEFAULT 'workspace'");
    addCol('ALTER TABLE contacts ADD COLUMN wiki_tags TEXT DEFAULT \'[]\'');
    addCol('ALTER TABLE contacts ADD COLUMN curation_flags TEXT DEFAULT \'[]\'');
    addCol('ALTER TABLE contacts ADD COLUMN curation_notes TEXT');
    addCol('ALTER TABLE contacts ADD COLUMN email TEXT');
    addCol('ALTER TABLE nl_briefings ADD COLUMN published_at INTEGER');
    addCol('ALTER TABLE nl_briefings ADD COLUMN wiki_slug TEXT');
    addCol('ALTER TABLE nl_briefings ADD COLUMN date_from TEXT');
    addCol('ALTER TABLE nl_briefings ADD COLUMN date_to TEXT');
    addCol('ALTER TABLE nl_briefings ADD COLUMN format_name TEXT');
    addCol('ALTER TABLE nl_briefings ADD COLUMN writer_model_id TEXT');
    addCol('ALTER TABLE nl_briefings ADD COLUMN provenance_json TEXT');
    addCol('ALTER TABLE intel_items ADD COLUMN extraction_model_id TEXT');
    addCol('ALTER TABLE intel_items ADD COLUMN extraction_model_label TEXT');
    addCol('ALTER TABLE intel_items ADD COLUMN extraction_method TEXT');
    addCol('ALTER TABLE intel_items ADD COLUMN extracted_at INTEGER');
    addCol('ALTER TABLE intel_sources ADD COLUMN briefing_priority INTEGER NOT NULL DEFAULT 3');
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS intel_extraction_runs (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        document_id TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'ai',
        status TEXT NOT NULL DEFAULT 'running',
        requested_model_id TEXT,
        actual_model_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        item_count INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        error TEXT,
        started_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_intel_extraction_runs_document
        ON intel_extraction_runs(document_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_intel_extraction_runs_user
        ON intel_extraction_runs(user, started_at DESC);
    `);
    try {
      _hub.prepare(`
        UPDATE intel_items
        SET extraction_method = 'direct_rss',
            extracted_at = COALESCE(extracted_at, created_at)
        WHERE extraction_method IS NULL
          AND document_id IN (
            SELECT id FROM intel_documents WHERE source_kind = 'rss'
          )
      `).run();
    } catch (_) {}
    addCol('ALTER TABLE nl_topics ADD COLUMN received_at INTEGER');
    addCol('ALTER TABLE email_summaries ADD COLUMN direction TEXT DEFAULT \'received\'');
    addCol('ALTER TABLE nl_formats ADD COLUMN focus_query TEXT');
    addCol('ALTER TABLE nl_formats ADD COLUMN retrieval_limit INTEGER DEFAULT 40');
    addCol('ALTER TABLE nl_formats ADD COLUMN reading_minutes INTEGER DEFAULT 20');
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
        email TEXT,
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

      CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT,
        website TEXT,
        notes TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_companies_user_name ON companies(user, name);

      CREATE TABLE IF NOT EXISTS contact_companies (
        contact_id TEXT NOT NULL,
        company_id TEXT NOT NULL,
        role TEXT,
        is_primary INTEGER DEFAULT 1,
        PRIMARY KEY (contact_id, company_id)
      );
      CREATE INDEX IF NOT EXISTS idx_contact_companies_company ON contact_companies(company_id);

      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        title TEXT NOT NULL,
        meeting_date TEXT NOT NULL,
        meeting_time TEXT,
        duration_mins INTEGER,
        location TEXT,
        notes TEXT,
        company_id TEXT,
        calendar_event_id TEXT,
        source TEXT DEFAULT 'manual',
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_meetings_user_date ON meetings(user, meeting_date DESC, meeting_time);

      CREATE TABLE IF NOT EXISTS meeting_attendees (
        meeting_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        PRIMARY KEY (meeting_id, contact_id)
      );
      CREATE INDEX IF NOT EXISTS idx_meeting_attendees_contact ON meeting_attendees(contact_id);

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

      CREATE TABLE IF NOT EXISTS email_taxonomy_labels (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(user, name)
      );
      CREATE INDEX IF NOT EXISTS idx_email_taxonomy_labels_user
        ON email_taxonomy_labels(user, display_order, name);

      CREATE TABLE IF NOT EXISTS email_taxonomy_rules (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        match_type TEXT NOT NULL,
        match_value TEXT NOT NULL,
        target_label TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 100,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(user, match_type, match_value)
      );
      CREATE INDEX IF NOT EXISTS idx_email_taxonomy_rules_user
        ON email_taxonomy_rules(user, priority DESC);

      CREATE TABLE IF NOT EXISTS email_classification_pending (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        gmail_message_id TEXT NOT NULL,
        from_email TEXT NOT NULL DEFAULT '',
        from_name TEXT NOT NULL DEFAULT '',
        subject TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        learned_label TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        learned_at INTEGER,
        UNIQUE(user, gmail_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_email_classification_pending_user_status
        ON email_classification_pending(user, status, created_at);

      CREATE TABLE IF NOT EXISTS inbound_email_records (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        source TEXT NOT NULL,
        external_message_id TEXT NOT NULL,
        thread_id TEXT,
        from_name TEXT NOT NULL DEFAULT '',
        from_email TEXT NOT NULL DEFAULT '',
        subject TEXT NOT NULL DEFAULT '',
        received_at INTEGER,
        summary TEXT NOT NULL DEFAULT '',
        classification TEXT,
        project_slug TEXT,
        status TEXT NOT NULL DEFAULT 'processed',
        raw_metadata TEXT NOT NULL DEFAULT '{}',
        processed_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(user, source, external_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_inbound_email_records_user_source
        ON inbound_email_records(user, source, received_at DESC);

      CREATE TABLE IF NOT EXISTS processing_failures (
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        last_error TEXT NOT NULL,
        first_failed_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_failed_at INTEGER NOT NULL DEFAULT (unixepoch()),
        resolved_at INTEGER,
        PRIMARY KEY (source, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_processing_failures_unresolved
        ON processing_failures(resolved_at, last_failed_at DESC);
    `);
    const douglasEmail = String(process.env.DOUGLAS_GOOGLE_EMAILS || 'douglas@mclellan.scot')
      .split(',')[0].trim().toLowerCase();
    const douglasContact = _hub.prepare(
      "SELECT id, email FROM contacts WHERE user = 'douglas' AND lower(name) = 'douglas mclellan'"
    ).get();
    if (!douglasContact) {
      _hub.prepare(`
        INSERT OR IGNORE INTO contacts (id, user, name, email)
        VALUES ('self-douglas-mclellan', 'douglas', 'Douglas McLellan', ?)
      `).run(douglasEmail || null);
    } else if (!douglasContact.email && douglasEmail) {
      _hub.prepare('UPDATE contacts SET email = ? WHERE id = ?').run(douglasEmail, douglasContact.id);
    }
    _hub.exec(`
      UPDATE contact_companies AS cc
      SET is_primary = 1
      WHERE cc.company_id = (
        SELECT cc2.company_id
        FROM contact_companies cc2
        JOIN companies co2 ON co2.id = cc2.company_id
        WHERE cc2.contact_id = cc.contact_id
        ORDER BY co2.name
        LIMIT 1
      )
      AND NOT EXISTS (
        SELECT 1
        FROM contact_companies primary_cc
        WHERE primary_cc.contact_id = cc.contact_id
          AND primary_cc.is_primary = 1
      );
    `);
    addCol('ALTER TABLE crm_facts ADD COLUMN meeting_id TEXT');
    addCol('ALTER TABLE crm_facts ADD COLUMN company_id TEXT');
    addCol("ALTER TABLE crm_facts ADD COLUMN linked_contacts TEXT DEFAULT '[]'");
    addCol("ALTER TABLE crm_facts ADD COLUMN fact_type TEXT DEFAULT 'fact'");
    addCol('ALTER TABLE crm_facts ADD COLUMN vault_projection TEXT');
    _hub.exec(`
      DROP INDEX IF EXISTS idx_meetings_user_calendar;
      CREATE UNIQUE INDEX idx_meetings_user_calendar ON meetings(user, calendar_event_id);
      CREATE INDEX IF NOT EXISTS idx_crm_facts_meeting ON crm_facts(user, meeting_id);
      CREATE INDEX IF NOT EXISTS idx_crm_facts_company ON crm_facts(user, company_id);
    `);
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS meeting_intakes (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        meeting_id TEXT,
        project_slug TEXT,
        title TEXT NOT NULL DEFAULT '',
        source_filename TEXT,
        transcript TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        extraction TEXT NOT NULL DEFAULT '{}',
        created_counts TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'processed',
        error TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_meeting_intakes_user
        ON meeting_intakes(user, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meeting_intakes_meeting
        ON meeting_intakes(meeting_id, created_at DESC);
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
    addLiCol("ALTER TABLE linkedin_posts ADD COLUMN spiciness TEXT NOT NULL DEFAULT 'professional'");
    addLiCol('ALTER TABLE linkedin_posts ADD COLUMN published_at INTEGER');

    _hub.exec(`
      CREATE TABLE IF NOT EXISTS content_research_suggestions (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        plan_date TEXT NOT NULL,
        topic TEXT NOT NULL,
        tone TEXT NOT NULL DEFAULT 'professional',
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        source_url TEXT,
        source_title TEXT,
        source_provider TEXT,
        source_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        researched_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(user, plan_date, topic, tone, title)
      );
      CREATE INDEX IF NOT EXISTS idx_content_research_user_date
        ON content_research_suggestions(user, plan_date, researched_at DESC);
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
        error_msg TEXT,
        task_code TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rlogs_ts ON request_logs(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_rlogs_user ON request_logs(user);
    `);

    // Flight log (personal travel tracker, DUB ↔ EDI)
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
    `);

    // Debrief session logs
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS debrief_sessions (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        started_at INTEGER NOT NULL DEFAULT (unixepoch()),
        ended_at INTEGER,
        turns INTEGER NOT NULL DEFAULT 0,
        transcript TEXT,
        note_path TEXT,
        extraction TEXT,
        error TEXT,
        calendar_events TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_debrief_sessions_user ON debrief_sessions(user, started_at DESC);
    `);

    // Regulatory monitor findings log
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS reg_monitor_items (
        id TEXT PRIMARY KEY,
        site TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        synopsis TEXT,
        found_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_reg_monitor_items_found ON reg_monitor_items(found_at DESC);
      CREATE INDEX IF NOT EXISTS idx_reg_monitor_items_site_url ON reg_monitor_items(site, url);
    `);

    // Newsletter intelligence pipeline
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS nl_interests (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        name TEXT NOT NULL,
        auto_include INTEGER DEFAULT 1,
        display_order INTEGER DEFAULT 0,
        gmail_label TEXT,
        mode TEXT DEFAULT 'selective',
        extraction_prompt TEXT,
        body_limit INTEGER,
        extract_max_tokens INTEGER
      );
      CREATE TABLE IF NOT EXISTS nl_formats (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        name TEXT NOT NULL,
        instructions TEXT NOT NULL,
        is_default INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        target_words INTEGER,
        max_tokens INTEGER,
        model_id TEXT
      );
      CREATE TABLE IF NOT EXISTS nl_generation_jobs (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        briefing_id TEXT,
        error TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS intel_sources (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        name TEXT NOT NULL,
        source_kind TEXT NOT NULL DEFAULT 'email',
        match_type TEXT NOT NULL,
        match_value TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        extraction_mode TEXT NOT NULL DEFAULT 'substantial',
        briefing_priority INTEGER NOT NULL DEFAULT 3,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(user, source_kind, match_type, match_value)
      );
      CREATE TABLE IF NOT EXISTS intel_documents (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        source_id TEXT,
        external_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        title TEXT NOT NULL,
        sender_name TEXT,
        sender_email TEXT,
        source_url TEXT,
        published_at INTEGER,
        content_text TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(user, source_kind, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_intel_documents_user_date
        ON intel_documents(user, published_at DESC);
      CREATE TABLE IF NOT EXISTS intel_items (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        document_id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        content_text TEXT NOT NULL,
        item_type TEXT NOT NULL DEFAULT 'news',
        category TEXT,
        entities_json TEXT NOT NULL DEFAULT '[]',
        themes_json TEXT NOT NULL DEFAULT '[]',
        source_url TEXT,
        published_at INTEGER,
        selected INTEGER NOT NULL DEFAULT 1,
        extraction_model_id TEXT,
        extraction_model_label TEXT,
        extraction_method TEXT,
        extracted_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_intel_items_user_date
        ON intel_items(user, published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_intel_items_document
        ON intel_items(document_id);
      CREATE TABLE IF NOT EXISTS intel_extraction_runs (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        document_id TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'ai',
        status TEXT NOT NULL DEFAULT 'running',
        requested_model_id TEXT,
        actual_model_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        item_count INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        error TEXT,
        started_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_intel_extraction_runs_document
        ON intel_extraction_runs(document_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_intel_extraction_runs_user
        ON intel_extraction_runs(user, started_at DESC);
      CREATE TABLE IF NOT EXISTS nl_topics (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        gmail_message_id TEXT,
        from_email TEXT,
        from_name TEXT,
        email_subject TEXT,
        headline TEXT NOT NULL,
        summary TEXT,
        category TEXT,
        week_key TEXT NOT NULL,
        selected INTEGER DEFAULT 1,
        received_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_nl_topics_user_week ON nl_topics(user, week_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_nl_topics_user_received ON nl_topics(user, received_at DESC);
      CREATE TABLE IF NOT EXISTS nl_briefings (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        week_key TEXT NOT NULL,
        format_id TEXT,
        topic_count INTEGER,
        html_content TEXT,
        text_content TEXT,
        sent_at INTEGER,
        date_from TEXT,
        date_to TEXT,
        format_name TEXT,
        writer_model_id TEXT,
        provenance_json TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_nl_briefings_user_week ON nl_briefings(user, week_key DESC);

      CREATE TABLE IF NOT EXISTS briefing_schedules (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        name TEXT NOT NULL,
        format_id TEXT,
        focus_query TEXT,
        recur_spec TEXT NOT NULL DEFAULT 'daily:07:00',
        date_window_days INTEGER NOT NULL DEFAULT 7,
        auto_send INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_briefing_schedules_user ON briefing_schedules(user, enabled);
    `);

    // Prompt library: reusable prompt examples, imported prompt snippets, and
    // adapted work orders generated from rough prompts.
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS prompt_library (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        raw_prompt TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_ref TEXT,
        source_title TEXT,
        source_author TEXT,
        source_url TEXT,
        purpose TEXT NOT NULL DEFAULT 'general',
        function_type TEXT NOT NULL DEFAULT 'other',
        domain TEXT NOT NULL DEFAULT 'General',
        artifact_type TEXT NOT NULL DEFAULT 'Prompt',
        interaction_type TEXT NOT NULL DEFAULT 'one-shot',
        input_types TEXT NOT NULL DEFAULT 'free text',
        tool_needs TEXT NOT NULL DEFAULT 'none',
        minimum_model_tier TEXT NOT NULL DEFAULT 'small-fast',
        recommended_model_tier TEXT NOT NULL DEFAULT 'general-reasoning',
        risk_level TEXT NOT NULL DEFAULT 'low',
        verification_type TEXT NOT NULL DEFAULT 'self-check',
        tags_json TEXT NOT NULL DEFAULT '[]',
        favourite INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(user, source_type, source_ref)
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_library_user_created
        ON prompt_library(user, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prompt_library_user_purpose
        ON prompt_library(user, purpose, function_type);

      CREATE TABLE IF NOT EXISTS prompt_adaptations (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        source_prompt_id TEXT,
        purpose TEXT NOT NULL DEFAULT 'general',
        mode TEXT NOT NULL DEFAULT 'quick',
        raw_request TEXT NOT NULL,
        adapted_prompt TEXT NOT NULL,
        model_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_adaptations_user_created
        ON prompt_adaptations(user, created_at DESC);

      CREATE TABLE IF NOT EXISTS prompt_optimizations (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        source_prompt_id TEXT,
        purpose TEXT NOT NULL DEFAULT 'general',
        task_description TEXT NOT NULL,
        examples_json TEXT NOT NULL DEFAULT '[]',
        rubric_json TEXT NOT NULL DEFAULT '{}',
        candidates_json TEXT NOT NULL DEFAULT '[]',
        winner_index INTEGER NOT NULL DEFAULT 0,
        final_prompt TEXT NOT NULL,
        pitfalls_json TEXT NOT NULL DEFAULT '[]',
        logbook_json TEXT NOT NULL DEFAULT '{}',
        model_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_optimizations_user_created
        ON prompt_optimizations(user, created_at DESC);

      CREATE TABLE IF NOT EXISTS prompt_agent_packs (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT 'internal-audit',
        stage TEXT NOT NULL,
        title TEXT NOT NULL,
        input_json TEXT NOT NULL DEFAULT '{}',
        pack_markdown TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_agent_packs_user_created
        ON prompt_agent_packs(user, created_at DESC);
    `);

    // Seed default interests if none exist
    const hasInterests = _hub.prepare('SELECT 1 FROM nl_interests LIMIT 1').get();
    if (!hasInterests) {
      const insInt = _hub.prepare('INSERT OR IGNORE INTO nl_interests (id, user, name, auto_include, display_order) VALUES (?, ?, ?, ?, ?)');
      const defaults = [
        ['AI & Machine Learning', 1, 0],
        ['Microsoft 365 & Azure', 1, 1],
        ['Healthcare IT', 1, 2],
        ['Ireland & EU Policy', 1, 3],
        ['Cybersecurity', 1, 4],
        ['Career & Leadership', 0, 5],
        ['Business & Finance', 0, 6],
        ['Other', 1, 7],
      ];
      for (const [name, auto, order] of defaults) {
        insInt.run(require('./id').uuid(), 'douglas', name, auto, order);
      }
    }

    // Google Tasks cache (bidirectional sync with Google Tasks API)
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS google_tasks (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        google_task_id TEXT NOT NULL,
        task_list_id TEXT NOT NULL DEFAULT '@default',
        title TEXT NOT NULL,
        notes TEXT,
        due TEXT,
        status TEXT NOT NULL DEFAULT 'needsAction',
        source TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT,
        synced_at INTEGER DEFAULT (unixepoch()),
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(google_task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_google_tasks_user ON google_tasks(user, status);
      CREATE INDEX IF NOT EXISTS idx_google_tasks_source ON google_tasks(source, source_id);
    `);
    // Contact ↔ Project direct links
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS contact_projects (
        contact_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        role TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (contact_id, project_id)
      );
      CREATE INDEX IF NOT EXISTS idx_contact_projects_project ON contact_projects(project_id);
    `);

    // Company ↔ Project direct links
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS company_projects (
        company_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        role TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (company_id, project_id)
      );
      CREATE INDEX IF NOT EXISTS idx_company_projects_project ON company_projects(project_id);
    `);

    // RSS feed subscriptions and ingested articles
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS rss_feeds (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        name TEXT NOT NULL,
        creator_slug TEXT NOT NULL,
        url TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        last_fetched_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_rss_feeds_user ON rss_feeds(user, enabled);

      CREATE TABLE IF NOT EXISTS rss_articles (
        id TEXT PRIMARY KEY,
        feed_id TEXT NOT NULL,
        user TEXT NOT NULL,
        creator_slug TEXT NOT NULL,
        guid TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        published_at INTEGER NOT NULL,
        content_markdown TEXT NOT NULL DEFAULT '',
        word_count INTEGER DEFAULT 0,
        vault_path TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(feed_id, guid)
      );
      CREATE INDEX IF NOT EXISTS idx_rss_articles_user_creator ON rss_articles(user, creator_slug, published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_rss_articles_feed ON rss_articles(feed_id);
    `);
    deduplicateRssData(_hub);

    // URL watchlist — Feedly-style URL monitoring
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS watchlist_feeds (
        id            TEXT PRIMARY KEY,
        user          TEXT NOT NULL,
        url           TEXT NOT NULL,
        label         TEXT NOT NULL DEFAULT '',
        provider      TEXT NOT NULL DEFAULT 'auto',
        interval_mins INTEGER NOT NULL DEFAULT 360,
        enabled       INTEGER DEFAULT 1,
        last_fetched_at  INTEGER,
        last_error       TEXT,
        error_count      INTEGER DEFAULT 0,
        created_at    INTEGER DEFAULT (unixepoch()),
        UNIQUE(user, url)
      );
      CREATE INDEX IF NOT EXISTS idx_watchlist_feeds_user ON watchlist_feeds(user, enabled);

      CREATE TABLE IF NOT EXISTS watchlist_stories (
        id            TEXT PRIMARY KEY,
        feed_id       TEXT NOT NULL REFERENCES watchlist_feeds(id) ON DELETE CASCADE,
        user          TEXT NOT NULL,
        url           TEXT NOT NULL,
        title         TEXT NOT NULL,
        snippet       TEXT NOT NULL DEFAULT '',
        content_markdown TEXT NOT NULL DEFAULT '',
        published_at  INTEGER,
        fetched_at    INTEGER DEFAULT (unixepoch()),
        provider_used TEXT,
        UNIQUE(feed_id, url)
      );
      CREATE INDEX IF NOT EXISTS idx_watchlist_stories_feed ON watchlist_stories(feed_id, fetched_at DESC);
      CREATE INDEX IF NOT EXISTS idx_watchlist_stories_user ON watchlist_stories(user, fetched_at DESC);
    `);

    // System job queue
    _hub.exec(`
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
    `);

    // Add columns and indexes that may not exist on older table instances
    const addTaskCol = (sql) => { try { _hub.exec(sql); } catch (_) {} };
    addTaskCol('ALTER TABLE nl_interests ADD COLUMN keywords TEXT');
    addTaskCol('ALTER TABLE nl_briefings ADD COLUMN schedule_id TEXT');
    addTaskCol('ALTER TABLE rss_feeds ADD COLUMN provider TEXT NOT NULL DEFAULT \'auto\'');
    addTaskCol('ALTER TABLE rss_feeds ADD COLUMN interval_mins INTEGER NOT NULL DEFAULT 1440');
    addTaskCol('ALTER TABLE rss_feeds ADD COLUMN feed_group TEXT NOT NULL DEFAULT \'personal\'');
    addTaskCol('ALTER TABLE rss_feeds ADD COLUMN last_error TEXT');
    addTaskCol('ALTER TABLE rss_feeds ADD COLUMN error_count INTEGER NOT NULL DEFAULT 0');

    // One-time migration: move watchlist_feeds into rss_feeds so all feeds
    // enter the knowledge pipeline (intel_items). Idempotent via UNIQUE(user, url).
    try {
      const toMigrate = _hub.prepare(
        'SELECT * FROM watchlist_feeds WHERE enabled = 1'
      ).all();
      const ins = _hub.prepare(`
        INSERT OR IGNORE INTO rss_feeds
          (id, user, name, creator_slug, url, provider, interval_mins, feed_group, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'work', ?)
      `);
      for (const wf of toMigrate) {
        const slug = (wf.label || wf.url)
          .toLowerCase().replace(/^https?:\/\/(www\.)?/, '')
          .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
        ins.run(wf.id, wf.user, wf.label || slug, slug,
          wf.url, wf.provider || 'auto', wf.interval_mins || 1440, wf.enabled ?? 1);
      }
      if (toMigrate.length) console.log(`[db] migrated ${toMigrate.length} watchlist feed(s) to rss_feeds`);
    } catch (_) { /* table may not exist yet on first run */ }

    addTaskCol('ALTER TABLE google_tasks ADD COLUMN contact_id TEXT');
    addTaskCol('ALTER TABLE google_tasks ADD COLUMN company_id TEXT');
    addTaskCol('ALTER TABLE google_tasks ADD COLUMN project_slug TEXT');
    addTaskCol('ALTER TABLE google_tasks ADD COLUMN deleted_at INTEGER');
    addTaskCol('ALTER TABLE google_tasks ADD COLUMN deadline TEXT');
    addTaskCol('ALTER TABLE google_tasks ADD COLUMN parent_id TEXT');
    addTaskCol('ALTER TABLE google_tasks ADD COLUMN position TEXT');
    addTaskCol('ALTER TABLE google_tasks ADD COLUMN completed_at INTEGER');
    addTaskCol('CREATE INDEX IF NOT EXISTS idx_google_tasks_contact ON google_tasks(contact_id)');
    addTaskCol('CREATE INDEX IF NOT EXISTS idx_google_tasks_company ON google_tasks(company_id)');
    addTaskCol('CREATE INDEX IF NOT EXISTS idx_google_tasks_parent ON google_tasks(parent_id)');
    addTaskCol('CREATE INDEX IF NOT EXISTS idx_google_tasks_completed ON google_tasks(user, completed_at)');
    try {
      _hub.prepare(`
        UPDATE google_tasks
           SET completed_at = COALESCE(synced_at, created_at, unixepoch())
         WHERE status = 'completed' AND completed_at IS NULL
      `).run();
    } catch (_) {}

    _hub.exec(`
      CREATE TABLE IF NOT EXISTS task_extraction_lessons (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        source_scope TEXT NOT NULL,
        lesson_key TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        rule TEXT NOT NULL,
        applies_to TEXT NOT NULL DEFAULT '{}',
        evidence_count INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(user, source_scope, lesson_key)
      );
      CREATE INDEX IF NOT EXISTS idx_task_lessons_active
        ON task_extraction_lessons(user, source_scope, active, evidence_count DESC);

      CREATE TABLE IF NOT EXISTS task_extraction_feedback (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        task_id TEXT NOT NULL,
        task_title TEXT NOT NULL,
        task_notes TEXT,
        source_scope TEXT NOT NULL,
        source_id TEXT,
        document_id TEXT,
        document_filename TEXT,
        project_slug TEXT,
        source_excerpt TEXT,
        user_reason TEXT,
        analysis TEXT,
        analysis_error TEXT,
        lesson_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_task_feedback_user_created
        ON task_extraction_feedback(user, created_at DESC);
    `);

    // Reminders: escalating nudges stored in Hub (lib/reminders.js)
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'adhoc',
        target_id TEXT,
        title TEXT NOT NULL,
        remind_at INTEGER NOT NULL,
        next_fire_at INTEGER,
        escalation_level INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'scheduled',
        short_code INTEGER,
        dedup_key TEXT,
        recur TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        last_fired_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_dedup ON reminders(dedup_key) WHERE dedup_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_reminders_user_status ON reminders(user, status, next_fire_at);
    `);

    // Suggestions: LLM-generated, advisory only (lib/suggestion-engine.js)
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS suggestions (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        domain TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        evidence TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        short_code INTEGER,
        dedup_key TEXT,
        expires_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_suggestions_dedup ON suggestions(dedup_key) WHERE dedup_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_suggestions_user_status ON suggestions(user, status, created_at DESC);
    `);

    // Travel price history extracted from Skyscanner price-alert emails
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS travel_price_points (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        route TEXT NOT NULL,
        travel_window_start TEXT,
        travel_window_end TEXT,
        price REAL NOT NULL,
        currency TEXT DEFAULT 'EUR',
        source TEXT NOT NULL DEFAULT 'skyscanner',
        gmail_message_id TEXT,
        observed_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(gmail_message_id, route, travel_window_start)
      );
      CREATE INDEX IF NOT EXISTS idx_travel_prices_route ON travel_price_points(user, route, observed_at DESC);
    `);

    // CRM nudge columns: follow-up due dates, birthdays, keep-warm cadence,
    // and last_contacted_at (cached — recomputed nightly by lib/crm-nudges.js)
    addCol('ALTER TABLE crm_facts ADD COLUMN due_date TEXT');
    addCol('ALTER TABLE contacts ADD COLUMN birthday TEXT');
    addCol('ALTER TABLE contacts ADD COLUMN keep_warm_days INTEGER');
    addCol('ALTER TABLE contacts ADD COLUMN last_contacted_at INTEGER');

    // ── Knowledge layer (L3 retrieval) ──────────────────────────────────────
    // One row per embedded chunk of a raw/derived source. vector is a JSON float
    // array; cosine similarity is computed in JS (lib/retrieval.js) — personal
    // scale (low thousands of chunks) makes brute force fine and avoids a native
    // vector extension on the VPS. model + dim are stored so a provider/model
    // change is detectable: query and corpus must share the same model to compare.
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        chunk_text TEXT NOT NULL,
        vector TEXT NOT NULL,
        model TEXT,
        dim INTEGER,
        updated_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_user ON embeddings(user);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_src
        ON embeddings(source_kind, source_id, chunk_index);
    `);

    // ── Knowledge layer (L2 substrate) ──────────────────────────────────────
    // Derived claims, not authored rows. Each atom is (subject, predicate, value)
    // with provenance (source_refs → the raw rows that justify it), confidence,
    // and status. Atoms are re-derivable from their sources; the CRM/wiki/project
    // views read from here. subject_id may be null when an atom is not yet
    // resolved to a known entity (the synthesis linker resolves it later).
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_atoms (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        subject_kind TEXT NOT NULL DEFAULT 'contact',
        subject_id TEXT,
        subject_label TEXT NOT NULL,
        predicate TEXT NOT NULL,
        value TEXT NOT NULL,
        source_refs TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0.6,
        status TEXT NOT NULL DEFAULT 'active',
        derived_by TEXT,
        first_seen INTEGER DEFAULT (unixepoch()),
        last_confirmed INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_atoms_user ON knowledge_atoms(user);
      CREATE INDEX IF NOT EXISTS idx_atoms_subject ON knowledge_atoms(subject_kind, subject_id);
      CREATE INDEX IF NOT EXISTS idx_atoms_status ON knowledge_atoms(user, status);
    `);

    // Fix: deepseek/deepseek-v4-flash was accidentally set as the embeddings
    // model. It is a text-completion model, not an embeddings model, so every
    // embed call has been failing. Reset to the fallback (openai/text-embedding-3-small).
    try {
      _hub.prepare(`
        DELETE FROM crm_context
         WHERE user = 'system'
           AND key  = 'hub_sys_model_embeddings'
           AND value = 'deepseek-deepseek-v4-flash'
      `).run();
    } catch (_) {}

    // Tracks which raw sources the synthesis linker has already read, so each is
    // extracted once (and re-extracted only if deliberately reset).
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS synthesis_state (
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        user TEXT,
        processed_at INTEGER,
        atom_count INTEGER DEFAULT 0,
        PRIMARY KEY (source_kind, source_id)
      );
    `);

    // Seed default briefing format if none exist
    const hasFormats = _hub.prepare('SELECT 1 FROM nl_formats LIMIT 1').get();
    if (!hasFormats) {
      _hub.prepare(`INSERT OR IGNORE INTO nl_formats (id, user, name, instructions, is_default) VALUES (?, ?, ?, ?, 1)`)
        .run(
          require('./id').uuid(),
          'douglas',
          'Weekly Intelligence Briefing',
          `You are writing a weekly intelligence briefing for Douglas McLellan, a senior technology leader in Ireland (M365, AI strategy, healthcare IT, operational leadership).

Write a concise, analytical briefing using this structure:

## Signal of the Week
2–3 sentences identifying the single most important theme or shift across all topics this week. Be specific — name the thing, not a vague trend.

## By Category
For each category that has topics, write one tight paragraph synthesising the key points. Analytical prose, not bullet lists. Lead with the implication, not the announcement.

## Worth Your Attention
3–5 specific items with direct relevance to Douglas's work. For each: one sentence on what it is, one sentence on why it matters to him specifically. Be direct about the relevance — M365, AI strategy, healthcare IT, Ireland/EU, or career.

## On the Radar
Brief 1-line mentions of things worth knowing but not actioning yet.

Tone: Direct, no filler, written for someone who reads the FT and thinks strategically. Scale length to match the number of topics — more topics means more coverage, not shorter entries. No preamble, start with the heading.`
        );
    }
    // Fix model_config entries so the health-check canonical comparison works.
    // OpenRouter responds with versioned IDs (e.g. anthropic/claude-4.8-opus-20260528)
    // and strips the date suffix to compare against stored model_ids. The stored IDs
    // must use the same base format as the response, not the routing alias, or they
    // will never match.
    try {
      // Opus 4.8: routing alias is anthropic/claude-opus-4.8 but response is anthropic/claude-4.8-opus-YYYYMMDD
      _hub.prepare(`UPDATE model_config SET model_id = 'anthropic/claude-4.8-opus-20260528' WHERE key = 'anthropic-claude-opus-4-8' AND model_id = 'anthropic/claude-opus-4.8'`).run();
      // Mistral Medium 3.5: stored with a dash (3-5) but OpenRouter responds with a dot (3.5)
      _hub.prepare(`UPDATE model_config SET model_id = 'mistralai/mistral-medium-3.5-20260430' WHERE key = 'mistralai-mistral-medium-3-5' AND model_id = 'mistralai/mistral-medium-3-5'`).run();
    } catch (_) {}
    // Add missing system/fallback models so they don't fire the unapproved-model alert.
    // These are used as fallbacks by synthesis, knowledge query, and embedding jobs.
    _hub.prepare(`
      INSERT OR IGNORE INTO model_config (key, label, endpoint, model_id, tier, search, enabled, display_order, category)
      VALUES
        ('anthropic-claude-haiku-4-5', 'Anthropic: Claude Haiku 4.5', 'openrouter', 'anthropic/claude-4.5-haiku-20251001', 'everyday', 'none', 1, 0, 'System models'),
        ('openai-text-embedding-3-small', 'OpenAI: text-embedding-3-small', 'openrouter', 'text-embedding-3-small', 'everyday', 'none', 1, 0, 'System models'),
        ('nvidia-nemotron-nano-9b-v2-free', 'NVIDIA: Nemotron Nano 9B (free)', 'openrouter', 'nvidia/nemotron-nano-9b-v2:free', 'everyday', 'none', 1, 0, NULL)
    `).run();
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

module.exports = { deduplicateRssData, hub, portfolio };
