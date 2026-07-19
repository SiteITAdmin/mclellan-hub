const Database = require('better-sqlite3');
const path = require('path');
const { getAiAssistedBuildsText } = require('./aiBuilds');
const { syncDouglasVerifiedEmployment } = require('./verifiedEmployment');
const {
  US_STATE_FINANCIAL_REGULATORS,
  US_STATE_AG_NEWSROOMS,
  NAAG_NEWSROOM,
} = require('./us-regulatory-sources');

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
    // Remove system-model overrides that point at models since deleted from
    // model_config — otherwise the slot silently runs its code fallback while
    // the admin page displays the stale override as if it were live.
    try {
      _hub.exec(`DELETE FROM crm_context
                 WHERE key LIKE 'hub_sys_model_%'
                   AND value NOT IN (SELECT key FROM model_config)
                   AND EXISTS (SELECT 1 FROM model_config)`);
    } catch (_) {}
    // Debrief rebuild (Jul 2026): stored interviewer overrides still carrying
    // the retired 4-phase feelings framework would shadow the new operational
    // prompt — drop them so the new default (or a fresh admin edit) applies.
    try {
      _hub.exec(`DELETE FROM crm_context
                 WHERE key = 'hub_sys_prompt_debrief_interviewer'
                   AND value LIKE '%where did it start and where did it end%'`);
    } catch (_) {}
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
    addCol('ALTER TABLE email_summaries ADD COLUMN gmail_label TEXT');
    addCol('ALTER TABLE email_summaries ADD COLUMN gmail_label_source TEXT');
    addCol('ALTER TABLE email_summaries ADD COLUMN gmail_label_checked_at INTEGER');
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
        gmail_label TEXT,
        gmail_label_source TEXT,
        gmail_label_checked_at INTEGER,
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

      -- WhatsApp / messaging capture (Hermes edge). Raw evidence only —
      -- relationship meaning is compiled by the CRM knowledge engine.
      CREATE TABLE IF NOT EXISTS messaging_messages (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'whatsapp',
        external_message_id TEXT NOT NULL,
        chat_id TEXT NOT NULL DEFAULT '',
        chat_name TEXT NOT NULL DEFAULT '',
        is_group INTEGER NOT NULL DEFAULT 0,
        sender_id TEXT NOT NULL DEFAULT '',
        sender_name TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        received_at INTEGER NOT NULL DEFAULT (unixepoch()),
        raw_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'received',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(user, platform, external_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messaging_messages_user_ts
        ON messaging_messages(user, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messaging_messages_status
        ON messaging_messages(user, status, received_at DESC);

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
    addLiCol("ALTER TABLE linkedin_posts ADD COLUMN post_url TEXT NOT NULL DEFAULT ''");
    addLiCol("ALTER TABLE linkedin_posts ADD COLUMN display_title TEXT NOT NULL DEFAULT ''");
    // Manual override of an active quality-board veto: Douglas has read the post
    // and chosen to publish anyway. Recorded (timestamp + reason) for audit.
    addLiCol('ALTER TABLE linkedin_posts ADD COLUMN quality_override INTEGER');
    addLiCol("ALTER TABLE linkedin_posts ADD COLUMN quality_override_reason TEXT NOT NULL DEFAULT ''");

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

      CREATE TABLE IF NOT EXISTS content_research_jobs (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        plan_date TEXT NOT NULL,
        topic TEXT NOT NULL,
        tone TEXT NOT NULL DEFAULT 'professional',
        limit_n INTEGER NOT NULL DEFAULT 3,
        topic_context TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        claim_token TEXT,
        claimed_at INTEGER,
        claimed_by TEXT,
        completed_at INTEGER,
        error TEXT,
        result_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_content_research_jobs_status
        ON content_research_jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_content_research_jobs_user_date
        ON content_research_jobs(user, plan_date, created_at DESC);
    `);
    // Topic description + searchQuery travel with the job so the Mac worker
    // can pass them to Grok without a second taxonomy lookup on the mini.
    addCol('ALTER TABLE content_research_jobs ADD COLUMN topic_context TEXT');
    // Drop pre-window-hardening prompt overrides so the tightened default
    // (engine-evidence primary, 30-day cite rule, thin-signal honesty) applies.
    // Safe: only removes overrides that still look like the old weak default.
    try {
      _hub.exec(`DELETE FROM crm_context
                 WHERE key LIKE 'hub_sys_prompt_%content_research_driver'
                   AND value NOT LIKE '%window_start%'
                   AND value NOT LIKE '%AUTHORITATIVE%'
                   AND value NOT LIKE '%CITATION PRIORITY%'`);
    } catch (_) {}

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
    // reg_monitor_items: full LLM assessment + briefing-inclusion audit trail
    // (previously only site/title/url/synopsis were ever stored, and a refactor
    // on 18 June 2026 silently dropped the INSERT entirely — see runs table below)
    addCol("ALTER TABLE reg_monitor_items ADD COLUMN publication_type TEXT");
    addCol("ALTER TABLE reg_monitor_items ADD COLUMN priority TEXT");
    addCol("ALTER TABLE reg_monitor_items ADD COLUMN why_it_matters TEXT");
    addCol("ALTER TABLE reg_monitor_items ADD COLUMN affected_firms TEXT");
    addCol("ALTER TABLE reg_monitor_items ADD COLUMN ireland_eu_relevance TEXT");
    addCol("ALTER TABLE reg_monitor_items ADD COLUMN confidence REAL");
    addCol("ALTER TABLE reg_monitor_items ADD COLUMN source_evidence TEXT");
    addCol("ALTER TABLE reg_monitor_items ADD COLUMN fetch_status TEXT");
    addCol("ALTER TABLE reg_monitor_items ADD COLUMN human_check_needed INTEGER DEFAULT 0");
    addCol("ALTER TABLE reg_monitor_items ADD COLUMN is_relevant INTEGER DEFAULT 1");
    addCol("ALTER TABLE reg_monitor_items ADD COLUMN exclusion_reason TEXT");
    addCol("ALTER TABLE reg_monitor_items ADD COLUMN included_in_briefing TEXT");
    addCol("ALTER TABLE reg_monitor_items ADD COLUMN run_id TEXT");
    addCol("ALTER TABLE reg_monitor_items ADD COLUMN backfilled INTEGER DEFAULT 0");
    addCol("ALTER TABLE reg_monitor_items ADD COLUMN source_kind TEXT DEFAULT 'web'");
    addCol("ALTER TABLE reg_monitor_items ADD COLUMN external_id TEXT");
    addCol("ALTER TABLE reg_monitor_items ADD COLUMN detail_json TEXT DEFAULT '{}'");
    _hub.exec(`
      CREATE INDEX IF NOT EXISTS idx_reg_monitor_items_run ON reg_monitor_items(run_id);
      CREATE INDEX IF NOT EXISTS idx_reg_monitor_items_source_kind ON reg_monitor_items(source_kind, found_at DESC);
    `);

    // Structured regulator Q&A tracking. These rows are raw-ish source evidence:
    // the briefing still consumes compiled reg_monitor_items, but this table lets
    // us detect answer/status changes without relying only on URL baselines.
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS reg_qa_items (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '',
        question TEXT NOT NULL DEFAULT '',
        answer TEXT NOT NULL DEFAULT '',
        topic TEXT NOT NULL DEFAULT '',
        subject_matter TEXT NOT NULL DEFAULT '',
        legislative_act TEXT NOT NULL DEFAULT '',
        response_date TEXT,
        published_date TEXT,
        content_hash TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_changed_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(source, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_reg_qa_items_source_changed
        ON reg_qa_items(source, last_changed_at DESC);
    `);

    // Daily intelligence pipeline run log — health/audit trail so a silent
    // "checked nothing" day is visible instead of looking identical to a quiet day.
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS reg_monitor_runs (
        id TEXT PRIMARY KEY,
        run_date TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        sources_total INTEGER NOT NULL DEFAULT 0,
        sources_ok INTEGER NOT NULL DEFAULT 0,
        sources_error INTEGER NOT NULL DEFAULT 0,
        sources_zero_links INTEGER NOT NULL DEFAULT 0,
        items_checked INTEGER NOT NULL DEFAULT 0,
        items_relevant INTEGER NOT NULL DEFAULT 0,
        items_excluded INTEGER NOT NULL DEFAULT 0,
        items_included_in_briefing INTEGER NOT NULL DEFAULT 0,
        panic INTEGER NOT NULL DEFAULT 0,
        panic_reasons TEXT,
        briefing_edition TEXT,
        briefing_ok INTEGER NOT NULL DEFAULT 0,
        briefing_error TEXT,
        report_email_sent INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_reg_monitor_runs_date ON reg_monitor_runs(run_date DESC);
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
    // Target model family a prompt was shaped for (style profile routing).
    // Runs after the tables exist so it works on both fresh and existing DBs.
    addCol('ALTER TABLE prompt_library ADD COLUMN target_model_family TEXT');
    addCol('ALTER TABLE prompt_adaptations ADD COLUMN target_model_family TEXT');
    addCol('ALTER TABLE prompt_optimizations ADD COLUMN target_model_family TEXT');

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
      let migrated = 0;
      for (const wf of toMigrate) {
        const slug = (wf.label || wf.url)
          .toLowerCase().replace(/^https?:\/\/(www\.)?/, '')
          .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
        migrated += ins.run(wf.id, wf.user, wf.label || slug, slug,
          wf.url, wf.provider || 'auto', wf.interval_mins || 1440, wf.enabled ?? 1).changes;
      }
      if (migrated) console.log(`[db] migrated ${migrated} watchlist feed(s) to rss_feeds`);
    } catch (_) { /* table may not exist yet on first run */ }

    addTaskCol('ALTER TABLE google_tasks ADD COLUMN contact_id TEXT');
    addTaskCol('ALTER TABLE google_tasks ADD COLUMN company_id TEXT');
    addTaskCol('ALTER TABLE google_tasks ADD COLUMN project_slug TEXT');
    addTaskCol('ALTER TABLE google_tasks ADD COLUMN deleted_at INTEGER');
    addTaskCol('ALTER TABLE google_tasks ADD COLUMN deadline TEXT');
    addTaskCol('ALTER TABLE google_tasks ADD COLUMN parent_id TEXT');
    addTaskCol('ALTER TABLE google_tasks ADD COLUMN position TEXT');
    addTaskCol('ALTER TABLE google_tasks ADD COLUMN completed_at INTEGER');
    addTaskCol('ALTER TABLE projects ADD COLUMN google_task_list_id TEXT');
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

      CREATE TABLE IF NOT EXISTS suggestion_lessons (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        domain TEXT NOT NULL,
        lesson_key TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        rule TEXT NOT NULL,
        applies_to TEXT NOT NULL DEFAULT '{}',
        evidence_count INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(user, domain, lesson_key)
      );
      CREATE INDEX IF NOT EXISTS idx_suggestion_lessons_active
        ON suggestion_lessons(user, domain, active, evidence_count DESC);

      CREATE TABLE IF NOT EXISTS suggestion_feedback (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        suggestion_id TEXT NOT NULL,
        suggestion_code INTEGER,
        suggestion_domain TEXT NOT NULL,
        suggestion_title TEXT NOT NULL,
        suggestion_body TEXT NOT NULL,
        suggestion_evidence TEXT,
        user_reason TEXT NOT NULL,
        analysis TEXT,
        analysis_error TEXT,
        lesson_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_user_created
        ON suggestion_feedback(user, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_suggestion
        ON suggestion_feedback(user, suggestion_id, created_at DESC);
    `);
    // LinkedIn topic ideas now belong exclusively to the dedicated LinkedIn
    // research pipeline. Preserve the old rows as history but stop presenting
    // them as active CRM suggestions.
    _hub.prepare(`
      UPDATE suggestions SET status = 'retired'
      WHERE domain = 'content' AND status = 'open'
    `).run();
    // Historical numbering originally considered open rows only, so a code
    // could be reused after an earlier suggestion was dismissed or expired.
    // Preserve every row and give only the later duplicate a new sequence
    // number before enforcing stable per-user codes.
    try {
      const duplicateSuggestionCodes = _hub.prepare(`
        SELECT id, user, created_at
        FROM (
          SELECT id, user, short_code, created_at,
                 ROW_NUMBER() OVER (
                   PARTITION BY user, short_code ORDER BY created_at, id
                 ) AS occurrence
          FROM suggestions
          WHERE short_code IS NOT NULL
        )
        WHERE occurrence > 1
        ORDER BY user, created_at, id
      `).all();
      const nextByUser = new Map();
      const maxCode = _hub.prepare(
        'SELECT COALESCE(MAX(short_code), 0) AS max FROM suggestions WHERE user = ?'
      );
      const renumber = _hub.prepare('UPDATE suggestions SET short_code = ? WHERE id = ?');
      _hub.transaction(() => {
        for (const row of duplicateSuggestionCodes) {
          const next = (nextByUser.get(row.user) || maxCode.get(row.user).max) + 1;
          renumber.run(next, row.id);
          nextByUser.set(row.user, next);
        }
      })();
      _hub.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_suggestions_user_code
          ON suggestions(user, short_code) WHERE short_code IS NOT NULL;
      `);
    } catch (err) {
      console.warn('[db] suggestion code repair failed:', err.message);
    }

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

    // Short-lived opportunities extracted from source evidence: retail offers,
    // event windows, local-only discounts, renewals, and similar "notice this
    // if context makes it relevant" signals. Suggestions decide whether to
    // surface them; this table is just the source-backed signal cache.
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS opportunity_signals (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        signal_type TEXT NOT NULL DEFAULT 'retail_offer',
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_label TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        actor TEXT,
        geography TEXT,
        currency TEXT,
        valid_from TEXT,
        valid_until TEXT,
        details_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        observed_at INTEGER NOT NULL DEFAULT (unixepoch()),
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(user, source_kind, source_id, signal_type, title)
      );
      CREATE INDEX IF NOT EXISTS idx_opportunity_signals_user_status
        ON opportunity_signals(user, status, observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_opportunity_signals_validity
        ON opportunity_signals(user, valid_until, observed_at DESC);
    `);

    // CRM nudge columns: follow-up due dates, birthdays, keep-warm cadence,
    // and last_contacted_at (cached — recomputed nightly by lib/crm-nudges.js)
    addCol('ALTER TABLE crm_facts ADD COLUMN due_date TEXT');
    addCol('ALTER TABLE crm_facts ADD COLUMN project_slug TEXT');
    addCol('CREATE INDEX IF NOT EXISTS idx_crm_facts_project ON crm_facts(user, project_slug, status)');
    addCol('ALTER TABLE contacts ADD COLUMN birthday TEXT');
    addCol('ALTER TABLE contacts ADD COLUMN keep_warm_days INTEGER');
    addCol('ALTER TABLE contacts ADD COLUMN last_contacted_at INTEGER');
    // phone is a column (not an atom) so it can serve as a dedup/matching key
    // alongside email — agreed exception to knowledge-over-tables, 6 Jul 2026
    addCol('ALTER TABLE contacts ADD COLUMN phone TEXT');

    // Per-project report schedule config — user preference, not derivable
    // knowledge, so it gets a table (agreed exception, 6 Jul 2026). cadence is
    // 'weekly:<mon..sun>' or 'monthly:<1..28>'; the scheduler job compares
    // last_run_at against the cadence to decide when to generate and email.
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS project_report_schedules (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        project_slug TEXT NOT NULL,
        cadence TEXT NOT NULL DEFAULT 'weekly:mon',
        window_days INTEGER NOT NULL DEFAULT 30,
        recipient TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(user, project_slug)
      );
    `);

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

    // Suggestions are candidates, not knowledge. Older opportunity builds
    // compiled atoms before review; retire any such atom unless its suggestion
    // has actually been accepted. Acceptance reactivates the atom explicitly.
    try {
      const candidateAtoms = _hub.prepare(`
        SELECT id, source_refs FROM knowledge_atoms
        WHERE derived_by = 'suggestion_opportunity' AND status = 'active'
      `).all();
      const suggestionStatus = _hub.prepare('SELECT status FROM suggestions WHERE id = ?');
      const retireAtom = _hub.prepare(
        "UPDATE knowledge_atoms SET status = 'retired', updated_at = unixepoch() WHERE id = ?"
      );
      for (const atom of candidateAtoms) {
        let refs = [];
        try { refs = JSON.parse(atom.source_refs || '[]'); } catch (_) { refs = []; }
        const suggestionIds = refs.filter(ref => ref?.kind === 'suggestion').map(ref => ref.id);
        if (!suggestionIds.length || suggestionIds.some(id => suggestionStatus.get(id)?.status !== 'accepted')) {
          retireAtom.run(atom.id);
        }
      }
    } catch (err) {
      console.warn('[db] unaccepted suggestion atom retirement failed:', err.message);
    }

    // Prompted CRM knowledge-engine receipts. These are not source-of-truth CRM
    // facts; they are audit/provenance records showing which prompt stage looked
    // at a source, what it decided, and which compiled knowledge action followed.
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_receipts (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'done',
        summary TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        model_key TEXT,
        model_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_receipts_source ON knowledge_receipts(user, source_kind, source_id, stage, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_knowledge_receipts_stage ON knowledge_receipts(user, stage, status, created_at DESC);
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
      _hub.prepare(`
        DELETE FROM crm_context
         WHERE user = 'system'
           AND key  = 'hub_sys_model_embeddings'
           AND value = 'z-ai-glm-5-2'
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

    // ── Nakai Reg Monitor Sites ───────────────────────────────────────────────
    // Replaces the hardcoded SITES array in lib/regulatory-monitor.js.
    // cadence: 'daily' | 'fortnightly' | 'monthly'
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS nakai_reg_monitor_sites (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        browser INTEGER NOT NULL DEFAULT 1,
        cadence TEXT NOT NULL DEFAULT 'daily',
        active INTEGER NOT NULL DEFAULT 1,
        last_checked_at INTEGER,
        notes TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    _hub.prepare(`INSERT OR IGNORE INTO nakai_reg_monitor_sites (id, name, url, browser, cadence) VALUES (?, ?, ?, ?, ?)`).run('nrs_cbi',  'Central Bank of Ireland',  'https://www.centralbank.ie/news/article',             1, 'daily');
    _hub.prepare(`INSERT OR IGNORE INTO nakai_reg_monitor_sites (id, name, url, browser, cadence) VALUES (?, ?, ?, ?, ?)`).run('nrs_fca',  'FCA',                       'https://www.fca.org.uk/news',                         1, 'daily');
    _hub.prepare(`INSERT OR IGNORE INTO nakai_reg_monitor_sites (id, name, url, browser, cadence) VALUES (?, ?, ?, ?, ?)`).run('nrs_eba',  'EBA',                       'https://www.eba.europa.eu/news-press',                1, 'daily');
    _hub.prepare(`INSERT OR IGNORE INTO nakai_reg_monitor_sites (id, name, url, browser, cadence) VALUES (?, ?, ?, ?, ?)`).run('nrs_esma', 'ESMA',                      'https://www.esma.europa.eu/press-news/esma-news',     1, 'daily');
    _hub.prepare(`INSERT OR IGNORE INTO nakai_reg_monitor_sites (id, name, url, browser, cadence, notes) VALUES (?, ?, ?, ?, ?, ?)`).run('nrs_esma_qa', 'ESMA Q&A', 'https://www.esma.europa.eu/esma-qa-search-page/final', 0, 'daily', 'Structured Q&A tracker; new or changed answers are written into reg_monitor_items.');
    _hub.prepare(`INSERT OR IGNORE INTO nakai_reg_monitor_sites (id, name, url, browser, cadence) VALUES (?, ?, ?, ?, ?)`).run('nrs_dof',  'Dept of Finance Ireland',   'https://www.gov.ie/en/department-of-finance/',        1, 'daily');
    _hub.prepare(`INSERT OR IGNORE INTO nakai_reg_monitor_sites (id, name, url, browser, cadence) VALUES (?, ?, ?, ?, ?)`).run('nrs_fatf', 'FATF',                      'https://www.fatf-gafi.org/en/publications.html',      1, 'fortnightly');
    _hub.prepare(`INSERT OR IGNORE INTO nakai_reg_monitor_sites (id, name, url, browser, cadence) VALUES (?, ?, ?, ?, ?)`).run('nrs_or_doj', 'Oregon Department of Justice', 'https://www.doj.state.or.us/media/news-media-releases/oregon-doj-news/', 0, 'daily');
    _hub.prepare(`INSERT OR IGNORE INTO nakai_reg_monitor_sites (id, name, url, browser, cadence) VALUES (?, ?, ?, ?, ?)`).run('nrs_tx_ag', 'Texas Attorney General', 'https://www.texasattorneygeneral.gov/news', 0, 'daily');

    // The user-maintained US State AG & Financial Regulator source list is
    // processed by the same daily page scraper and LLM assessor as the EU/UK
    // regulators above. These are raw source entry points; relevance remains a
    // synthesis decision for each newly discovered publication.
    const _usRegSiteSeed = _hub.prepare(`
      INSERT OR IGNORE INTO nakai_reg_monitor_sites (id, name, url, browser, cadence, notes)
      VALUES (?, ?, ?, 0, 'daily', 'US State AG & Financial Regulator Bookmark List')
    `);
    for (const source of US_STATE_FINANCIAL_REGULATORS) {
      const slug = source.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42);
      _usRegSiteSeed.run(`nrs_us_fin_${slug}`, `US financial regulator — ${source.name}`, source.url);
    }

    const _usAgSiteSeed = _hub.prepare(`
      INSERT OR IGNORE INTO nakai_reg_monitor_sites (id, name, url, browser, cadence, notes)
      VALUES (?, ?, ?, 0, 'daily', 'US State Attorney General Newsrooms')
    `);
    for (const source of US_STATE_AG_NEWSROOMS) {
      const slug = source.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42);
      _usAgSiteSeed.run(`nrs_us_ag_${slug}`, `US Attorney General — ${source.name}`, source.url);
    }
    _hub.prepare(`
      INSERT OR IGNORE INTO nakai_reg_monitor_sites (id, name, url, browser, cadence, notes)
      VALUES ('nrs_naag', ?, ?, 0, 'daily', 'Multistate Attorney General action aggregator')
    `).run(NAAG_NEWSROOM.name, NAAG_NEWSROOM.url);

    // FCA publication alerts should be consumed through email/RSS, not paywall
    // scraping. Seed sources so AgentMail/Gmail/RSS intake recognises them as
    // briefing-grade regulatory intelligence when subscribed.
    const _intelSrcSeed = _hub.prepare(`
      INSERT OR IGNORE INTO intel_sources
        (id, user, name, source_kind, match_type, match_value, briefing_priority)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    _intelSrcSeed.run('nakai_src_fca_alerts_email', 'nakai', 'FCA publication alerts', 'email', 'sender_email', 'fcaupdates@fca.org.uk', 1);
    _intelSrcSeed.run('nakai_src_fca_warnings_email', 'nakai', 'FCA warning alerts', 'email', 'sender_email', 'fcaupdates@fca.org.uk', 1);
    _intelSrcSeed.run('nakai_src_esma_newsletter_email', 'nakai', 'ESMA newsletter alerts', 'email', 'sender_email', 'info@newsletter.esma.europa.eu', 1);
    _intelSrcSeed.run('nakai_src_ft_myft_email', 'nakai', 'myFT alerts', 'email', 'sender_email', 'myft@news-alerts.ft.com', 3);
    _intelSrcSeed.run('nakai_src_ft_newsletters_email', 'nakai', 'Financial Times newsletters', 'email', 'sender_email', 'ft@newsletters.ft.com', 3);
    try {
      const row = _hub.prepare(`
        SELECT value FROM crm_context
        WHERE user = 'system' AND key = 'hub_sys_prompt_nakai_daily_briefing'
      `).get();
      if (row?.value && !/Regulator Q&A\/alert source handling/i.test(row.value)) {
        _hub.prepare(`
          UPDATE crm_context
             SET value = value || ?
           WHERE user = 'system' AND key = 'hub_sys_prompt_nakai_daily_briefing'
        `).run(`

Regulator Q&A/alert source handling:
- Treat supplied regulator Q&A and Single Rulebook answer updates as supervisory interpretation signals. Extract the practical control implication, evidence to test, and audit-plan read-across.
- Regulator Q&A items count as new when first observed after baseline or when the answer/status/hash changes. Do not restate unchanged Q&A archive material.
- Treat regulator email/RSS alerts as source-backed intelligence when supplied. Use Financial Times or similar press only as market/product context, not as authority for legal obligations, and do not reproduce paywalled article text beyond short summaries.`);
      }
    } catch (_) {}

    // ── Nakai Ref Sources ─────────────────────────────────────────────────────
    // Replaces the hardcoded sources array in scripts/build-nakai-daily-briefing.js.
    // intent: why this source matters to Nakai's audit work — fed to the extraction prompt.
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS nakai_ref_sources (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        intent TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        last_fetched_at INTEGER,
        last_synthesized_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    const _refSrc = _hub.prepare(`INSERT OR IGNORE INTO nakai_ref_sources (id, source_key, title, url, intent) VALUES (?, ?, ?, ?, ?)`);
    _refSrc.run('nrf_s16', 'S16', 'FCA: Our Consumer Duty focus areas',                                          'https://www.fca.org.uk/publications/corporate-documents/consumer-duty-focus-areas',                                                                                    'Signals current FCA supervisory emphasis on Consumer Duty beyond the original rules. Use for audit-horizon planning of Consumer Duty themes and FCA priorities 2025-26.');
    _refSrc.run('nrf_s17', 'S17', 'FCA: Year 2 Consumer Duty Board Reports',                                     'https://www.fca.org.uk/news/blogs/year-2-consumer-duty-board-reports-progress-and-what-comes-next',                                                                       'FCA expectations for board reporting quality on Consumer Duty: ownership, action plans, outcome monitoring. Use to frame audit evidence requirements for board-level governance.');
    _refSrc.run('nrf_s18', 'S18', 'FCA: Consumer understanding - good practice and areas for improvement',       'https://www.fca.org.uk/publications/good-and-poor-practice/consumer-understanding-good-practice-areas-improvement',                                                       'FCA good/poor practice on communication design, testing, monitoring. Use to identify audit criteria for customer journey, disclosure, and consumer understanding controls.');
    _refSrc.run('nrf_s19', 'S19', "FCA blog: What do we mean when we say 'fair value'?",                         'https://www.fca.org.uk/news/blogs/what-do-we-mean-when-we-say-fair-value',                                                                                                 'FCA definition and evidence requirements for fair value. Use to scope fair value audit work: pricing, fees, benefits, customer cohorts, outcomes data, complaints, remediation.');
    _refSrc.run('nrf_s20', 'S20', 'FCA: Operational resilience insights and observations one year on',            'https://www.fca.org.uk/publications/good-and-poor-practice/operational-resilience-insights-observations-one-year',                                                        'FCA post-implementation findings on operational resilience. Use to frame audit scope: service definitions, impact tolerances, scenario testing, vulnerabilities, self-assessment quality.');
    _refSrc.run('nrf_s21', 'S21', 'FCA: Operational resilience (main hub)',                                       'https://www.fca.org.uk/firms/operational-resilience',                                                                                                                      'FCA current operational resilience regime overview including incident reporting preparations. Use for post-transition audit questions: operating within tolerances under severe scenarios.');
    _refSrc.run('nrf_s22', 'S22', 'FCA: Reporting operational incidents',                                         'https://www.fca.org.uk/firms/operational-resilience/reporting-operational-incidents',                                                                                      'FCA new incident reporting rules effective 18 March 2027. Use to audit incident taxonomy, escalation thresholds, MI, ownership, and reporting playbook readiness.');
    _refSrc.run('nrf_s23', 'S23', 'PRA PS7/26: Operational incident and third-party reporting',                   'https://www.bankofengland.co.uk/prudential-regulation/publication/2026/march/operational-incident-and-third-party-reporting-policy-statement',                            'PRA policy on incident and material third-party reporting. Use to audit materiality judgements, third-party inventory, incident severity assessment, governance challenge, reporting evidence.');
    _refSrc.run('nrf_s24', 'S24', 'PRA Business Plan 2026/27',                                                    'https://www.bankofengland.co.uk/prudential-regulation/publication/2026/april/pra-business-plan-2026-27',                                                                  'PRA supervisory priorities for 2026/27 including cyber resilience assessments (CBEST). Use to frame UK operational resilience audit in context of ongoing PRA supervision themes.');
    _refSrc.run('nrf_s25', 'S25', 'Central Bank of Ireland: DORA hub',                                            'https://www.centralbank.ie/regulation/digital-operational-resilience-act-dora',                                                                                             'CBI DORA guidance. Use to scope DORA audit work: ICT risk management, incident reporting, resilience testing, third-party ICT risk, governance ownership.');
    _refSrc.run('nrf_s26', 'S26', 'Central Bank of Ireland: Operational Resilience guidance (July 2025)',         'https://www.centralbank.ie/financial-system/operational-resilience-and-cyber/operational-resilience',                                                                        'CBI updated guidance aligned to DORA. Use to bridge DORA minimum standards with CBI expectations on important services, disruption response, and recovery.');
    _refSrc.run('nrf_s27', 'S27', 'Central Bank of Ireland: Reporting Registers of Information (DORA)',           'https://www.centralbank.ie/regulation/digital-operational-resilience-act-dora/reporting-registers-of-information',                                                          'CBI requirements for DORA Registers of Information on ICT third-party services. Use to audit RoI completeness, data lineage, ownership, contract population, validation, vendor reconciliation.');
    _refSrc.run('nrf_s28', 'S28', 'Central Bank of Ireland: Reporting major ICT incidents (DORA)',                'https://www.centralbank.ie/regulation/digital-operational-resilience-act-dora/reporting-major-ict-related-incidents-and-significant-cyber-threats',                         'CBI requirements for major ICT incident and significant cyber threat reporting under DORA. Use to audit threshold assessment, reporting workflow, incident evidence, and post-incident lessons.');
    _refSrc.run('nrf_s29', 'S29', 'Central Bank of Ireland: Regulatory and Supervisory Outlook 2026',             'https://www.centralbank.ie/publication/regulatory---supervisory-outlook-report',                                                                                              'CBI 2026 regulatory priorities including DORA, ICT risk, and financial resilience. Use to frame Irish operational resilience audit as continuity-of-service obligation, not only tech compliance.');

    // ── Nakai Ref Atoms ───────────────────────────────────────────────────────
    // Compiled knowledge output from ref source synthesis.
    // is_bootstrap=1 means seeded from hardcoded notes; synthesis job upgrades to 0.
    _hub.exec(`
      CREATE TABLE IF NOT EXISTS nakai_ref_atoms (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL,
        content TEXT NOT NULL,
        synthesized_at INTEGER NOT NULL DEFAULT (unixepoch()),
        model_id TEXT,
        receipt_id TEXT,
        is_bootstrap INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_nakai_ref_atoms_source ON nakai_ref_atoms(source_key, synthesized_at DESC);
    `);
    // Bootstrap atoms — seeded from the original hardcoded notes so the briefing
    // has standing context immediately. The synthesis job overwrites these.
    const _atom = _hub.prepare(`INSERT OR IGNORE INTO nakai_ref_atoms (id, source_key, content, is_bootstrap) VALUES (?, ?, ?, 1)`);
    _atom.run('nra_s16_boot', 'S16', 'The FCA Consumer Duty remains a priority under its 2025-2030 strategy. The page sets out 2025-2026 priorities for embedding the Duty, support for firms, and sector-specific focus areas. High-credibility audit-horizon source signalling current FCA supervisory emphasis beyond the original rules.');
    _atom.run('nra_s17_boot', 'S17', 'FCA says firms increasingly set out comprehensive action plans with clear responsibilities, timelines, and progress updates. Most reports now identify accountable owners and track delivery status. Audit relevance: board reporting should evidence ownership, outcome monitoring, action tracking, governance challenge, and closure discipline.');
    _atom.run('nra_s18_boot', 'S18', 'FCA says firms should make communication design, testing, monitoring, and governance a coherent end-to-end process. Audit relevance: test whether communications are designed, tested, monitored, and escalated using evidence rather than assumed to be understandable. Relevant to Consumer Duty audits of customer journeys, disclosures, fees, product terms, complaints, and support channels.');
    _atom.run('nra_s19_boot', 'S19', 'FCA frames fair value as whether customers are paying a reasonable price relative to the benefits they receive. Firms need evidence that customers are getting a fair deal. Audit relevance: fair value work should connect pricing, fees, customer cohorts, benefits, outcomes data, complaints, and remedial action.');
    _atom.run('nra_s20_boot', 'S20', 'FCA tells firms to continue complying with operational resilience rules and use self-assessment observations to evolve their approach. Highlights important business services, impact tolerances, and the need for clear shared understanding of how disruption could cause intolerable harm. Audit relevance: test service definitions, impact tolerances, mapping, scenario testing, vulnerabilities, remediation, self-assessment quality, and senior ownership.');
    _atom.run('nra_s21_boot', 'S21', 'FCA says firms in scope had until 31 March 2025 to ensure they could operate important business services within impact tolerances. Links operational resilience regime to cyber resilience and incident reporting. Audit relevance: post-transition question is whether the firm can evidence operation within tolerances under severe but plausible scenarios.');
    _atom.run('nra_s22_boot', 'S22', 'FCA says firms should prepare for new operational incident reporting rules coming into force on 18 March 2027. Relevant to incident governance, escalation thresholds, data capture, and regulatory reporting readiness. Audit relevance: test incident taxonomy, escalation, MI, ownership, and reporting playbooks against the forthcoming regime.');
    _atom.run('nra_s23_boot', 'S23', 'PRA PS7/26 covers operational incident reporting and material third-party arrangement reporting. PRA says flexibility is important because the same incident may have varying impacts across firms. Audit relevance: test materiality judgements, third-party inventory completeness, incident severity assessment, governance challenge, and reporting evidence.');
    _atom.run('nra_s24_boot', 'S24', 'PRA says its operational resilience policy was fully implemented March 2025. During 2026/27 PRA will continue robust supervisory standards through cyber resilience assessments including CBEST and work with NCSC. Audit relevance: UK operational resilience audit should consider cyber resilience, testing, remediation, and senior-level oversight evidence.');
    _atom.run('nra_s25_boot', 'S25', 'DORA has applied since 17 January 2025 to a wide range of CBI-regulated financial entities. Brings together digital operational risk provisions in a consistent manner. Audit relevance: DORA audit work should cover ICT risk management, incident reporting, resilience testing, third-party ICT risk, and governance ownership.');
    _atom.run('nra_s26_boot', 'S26', 'CBI updated and republished operational resilience guidance July 2025 to align with DORA; withdrew 2016 IT and cybersecurity risk guidance. Explains how to prepare for, respond to, recover, and learn from operational disruptions affecting critical or important business services. Audit relevance: Irish work should bridge DORA minimum standards with CBI expectations on important services and disruption response.');
    _atom.run('nra_s27_boot', 'S27', 'Financial entities subject to DORA must submit Registers of Information on contractual arrangements for ICT third-party services. Audit relevance: test RoI completeness, data lineage, ownership, contract population, validation checks, and reconciliation to vendor/outsourcing inventories.');
    _atom.run('nra_s28_boot', 'S28', 'Financial entities subject to DORA have been obliged since 17 January 2025 to submit major ICT-related incident reports where criteria and thresholds are met. Page also covers significant cyber-threat submissions. Audit relevance: test threshold assessment, reporting workflow, incident evidence, cyber-threat escalation, and post-incident lessons learned.');
    _atom.run('nra_s29_boot', 'S29', 'CBI 2026 Regulatory and Supervisory Outlook sets out key trends, risks, and regulatory priorities for the next two years. Highlights DORA, ICT risk management, and maintaining resilient financial services to consumers and investors. Audit relevance: use the Outlook to frame operational resilience as customer/investor service continuity obligation, not only technology compliance.');

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
        ('google-gemini-2-5-pro', 'Google: Gemini 2.5 Pro', 'openrouter', 'google/gemini-2.5-pro', 'deep-research', 'none', 1, 0, 'System models'),
        ('google-gemini-2-5-pro-preview', 'Google: Gemini 2.5 Pro Preview', 'openrouter', 'google/gemini-2.5-pro-preview', 'deep-research', 'none', 1, 0, 'System models'),
        ('google-gemini-2-5-flash', 'Google: Gemini 2.5 Flash', 'openrouter', 'google/gemini-2.5-flash', 'everyday', 'none', 1, 0, 'System models'),
        ('google-gemini-2-5-flash-lite', 'Google: Gemini 2.5 Flash Lite', 'openrouter', 'google/gemini-2.5-flash-lite', 'everyday', 'none', 1, 0, 'System models'),
        ('anthropic-claude-haiku-4-5', 'Anthropic: Claude Haiku 4.5', 'openrouter', 'anthropic/claude-4.5-haiku-20251001', 'everyday', 'none', 1, 0, 'System models'),
        ('openai-text-embedding-3-small', 'OpenAI: text-embedding-3-small', 'openrouter', 'text-embedding-3-small', 'everyday', 'none', 1, 0, 'System models'),
        ('nvidia-nemotron-nano-9b-v2-free', 'NVIDIA: Nemotron Nano 9B (free)', 'openrouter', 'nvidia/nemotron-nano-9b-v2:free', 'everyday', 'none', 1, 0, NULL),
        ('openai-whisper-large-v3', 'OpenAI: Whisper Large v3 (STT)', 'openrouter', 'openai/whisper-large-v3', 'everyday', 'none', 1, 0, 'System models'),
        ('hexgrad-kokoro-82m', 'Hexgrad: Kokoro 82M (TTS)', 'openrouter', 'hexgrad/kokoro-82m', 'everyday', 'none', 1, 0, 'System models'),
        ('mistralai-voxtral-mini-tts-2603', 'Mistral: Voxtral Mini TTS', 'openrouter', 'mistralai/voxtral-mini-tts-2603', 'everyday', 'none', 1, 0, 'System models'),
        ('microsoft-mai-voice-2', 'Microsoft: MAI-Voice-2 (TTS)', 'openrouter', 'microsoft/mai-voice-2', 'everyday', 'none', 1, 0, 'System models')
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
