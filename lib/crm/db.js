'use strict';

// crm.db: the personal CRM. Raw sources are stored faithfully; people links,
// project membership and "last contact" are derived from them, never typed in.
// Atoms are the compiled knowledge layer built from sources by the Mac worker.

const Database = require('better-sqlite3');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SPACES = ['work', 'personal'];

let _db;

function dbPath() {
  return process.env.CRM_DB_PATH ? path.resolve(process.env.CRM_DB_PATH) : path.join(DATA_DIR, 'crm.db');
}

function crm() {
  if (_db) return _db;
  _db = new Database(dbPath());
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS organisations (
      id TEXT PRIMARY KEY,
      space TEXT NOT NULL CHECK (space IN ('work','personal')),
      name TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(space, name_norm)
    );

    -- An email domain that belongs to an organisation, e.g. beaconhospital.ie.
    -- Used only to suggest the organisation for a new person; Douglas confirms.
    CREATE TABLE IF NOT EXISTS org_domains (
      org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      space TEXT NOT NULL,
      domain TEXT NOT NULL,
      PRIMARY KEY (space, domain)
    );

    -- Departments and teams inside an organisation. A team always sits under a
    -- department of the same organisation (enforced in lib/crm/orgs.js).
    CREATE TABLE IF NOT EXISTS org_units (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES org_units(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('department','team')),
      name TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_org_units_name ON org_units(org_id, COALESCE(parent_id, ''), name_norm);

    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      space TEXT NOT NULL CHECK (space IN ('work','personal')),
      name TEXT NOT NULL,
      org_id TEXT REFERENCES organisations(id) ON DELETE SET NULL,
      unit_id TEXT REFERENCES org_units(id) ON DELETE SET NULL,
      role TEXT NOT NULL DEFAULT '',
      hue INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_people_space ON people(space, name);

    -- An address the Hub has seen. person_id is set once Douglas decides who it
    -- is; status 'ignored' means "not a person" (newsletters, system senders).
    CREATE TABLE IF NOT EXISTS identifiers (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('email','phone')),
      value TEXT NOT NULL,
      person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'linked' CHECK (status IN ('linked','ignored')),
      label TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(kind, value)
    );
    CREATE INDEX IF NOT EXISTS idx_identifiers_person ON identifiers(person_id);

    CREATE TABLE IF NOT EXISTS aliases (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      alias_norm TEXT NOT NULL,
      UNIQUE(person_id, alias_norm)
    );
    CREATE INDEX IF NOT EXISTS idx_aliases_norm ON aliases(alias_norm);

    -- "Not the same as": recorded when Douglas added a new person while another
    -- was shown as a possible match.
    CREATE TABLE IF NOT EXISTS distinct_pairs (
      person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      other_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      decided_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (person_id, other_id)
    );

    CREATE TABLE IF NOT EXISTS identity_log (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL DEFAULT (unixepoch()),
      action TEXT NOT NULL,
      person_id TEXT,
      detail TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      space TEXT NOT NULL CHECK (space IN ('work','personal')),
      name TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(space, name_norm)
    );

    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      space TEXT NOT NULL CHECK (space IN ('work','personal')),
      name TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(space, name_norm)
    );

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      space TEXT NOT NULL CHECK (space IN ('work','personal')),
      kind TEXT NOT NULL,
      origin TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      occurred_at INTEGER NOT NULL,
      direction TEXT,
      text TEXT NOT NULL DEFAULT '',
      text_fresh TEXT NOT NULL DEFAULT '',
      raw_ref TEXT NOT NULL DEFAULT '',
      readable INTEGER NOT NULL DEFAULT 1,
      unreadable_reason TEXT NOT NULL DEFAULT '',
      is_history INTEGER NOT NULL DEFAULT 0,
      atomise_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (atomise_status IN ('pending','held','queued','done','failed','ignored','skipped')),
      atomise_job_id TEXT,
      atomise_error TEXT NOT NULL DEFAULT '',
      atomise_attempts INTEGER NOT NULL DEFAULT 0,
      atomised_at INTEGER,
      atom_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(origin, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sources_space_time ON sources(space, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sources_atomise ON sources(atomise_status, is_history, occurred_at DESC);

    -- Every participant address on a source. People are derived by joining to
    -- identifiers, so approving someone links their past sources automatically.
    CREATE TABLE IF NOT EXISTS source_addresses (
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'email',
      value TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('from','to','cc')),
      name TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (source_id, kind, value, role)
    );
    CREATE INDEX IF NOT EXISTS idx_source_addresses_value ON source_addresses(kind, value);

    CREATE TABLE IF NOT EXISTS atoms (
      id TEXT PRIMARY KEY,
      space TEXT NOT NULL CHECK (space IN ('work','personal')),
      statement TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'fact',
      confidence TEXT NOT NULL DEFAULT 'medium',
      said_at INTEGER NOT NULL,
      valid_from TEXT,
      valid_until TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
      superseded_by TEXT,
      is_history INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_atoms_space_time ON atoms(space, said_at DESC);

    CREATE TABLE IF NOT EXISTS atom_sources (
      atom_id TEXT NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      quote TEXT NOT NULL DEFAULT '',
      quote_verified INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (atom_id, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_atom_sources_source ON atom_sources(source_id);

    -- Names as the model saw them. person_id is filled only by the
    -- deterministic matcher or by Douglas, never by the model.
    CREATE TABLE IF NOT EXISTS atom_mentions (
      id TEXT PRIMARY KEY,
      atom_id TEXT NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('resolved','ambiguous','unresolved','self','none')),
      person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
      how TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_atom_mentions_atom ON atom_mentions(atom_id);
    CREATE INDEX IF NOT EXISTS idx_atom_mentions_person ON atom_mentions(person_id);
    CREATE INDEX IF NOT EXISTS idx_atom_mentions_open ON atom_mentions(status, name_norm);

    CREATE TABLE IF NOT EXISTS atom_projects (
      atom_id TEXT NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      PRIMARY KEY (atom_id, project_id)
    );
    CREATE INDEX IF NOT EXISTS idx_atom_projects_project ON atom_projects(project_id);

    CREATE TABLE IF NOT EXISTS atom_topics (
      atom_id TEXT NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      PRIMARY KEY (atom_id, topic_id)
    );
    CREATE INDEX IF NOT EXISTS idx_atom_topics_topic ON atom_topics(topic_id);

    CREATE TABLE IF NOT EXISTS review_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('person','mention','project')),
      item_key TEXT NOT NULL,
      space TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','decided')),
      snooze_until INTEGER,
      payload TEXT NOT NULL DEFAULT '{}',
      decision TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      decided_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_open_key ON review_items(item_key) WHERE status = 'open';

    -- Last outcome of each scheduled CRM job, so a failure or a silent stop
    -- shows on the Today screens (CLAUDE.md rule 5).
    CREATE TABLE IF NOT EXISTS job_runs (
      name TEXT PRIMARY KEY,
      last_started INTEGER,
      last_ok INTEGER,
      last_error TEXT NOT NULL DEFAULT '',
      last_error_at INTEGER,
      detail TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Current task input and its Google sync checkpoint. context is Douglas's
    -- explicit input; inferred relationships remain in the source/atom layer.
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      space TEXT NOT NULL CHECK (space IN ('work','personal')),
      title TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      due TEXT,
      status TEXT NOT NULL DEFAULT 'needsAction' CHECK (status IN ('needsAction','completed','deleted')),
      context TEXT NOT NULL DEFAULT '{}',
      source_id TEXT REFERENCES sources(id),
      origin TEXT NOT NULL,
      google_list_id TEXT,
      google_id TEXT,
      remote_json TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      synced_revision INTEGER NOT NULL DEFAULT 0,
      synced_at INTEGER,
      sync_error TEXT NOT NULL DEFAULT '',
      conflict TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(google_list_id, google_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_space ON tasks(space, status, due);

    -- What a promise atom means for Douglas, and what became of it. Whether it
    -- is still open also reads the linked task, so ticking in Google closes it.
    CREATE TABLE IF NOT EXISTS promises (
      atom_id TEXT PRIMARY KEY REFERENCES atoms(id) ON DELETE CASCADE,
      space TEXT NOT NULL CHECK (space IN ('work','personal')),
      direction TEXT NOT NULL CHECK (direction IN ('mine','owed_to_me','other')),
      who TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      due TEXT,
      certainty TEXT NOT NULL CHECK (certainty IN ('clear','unsure')),
      state TEXT NOT NULL CHECK (state IN ('open','kept','dismissed','stale','untracked')),
      said_at INTEGER NOT NULL,
      task_id TEXT REFERENCES tasks(id),
      closed_at INTEGER,
      closed_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_promises_ledger ON promises(space, state, direction, said_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_promises_task ON promises(task_id) WHERE task_id IS NOT NULL;

    -- A written summary of a person, project or organisation. Disposable: it is
    -- rebuilt from atoms, and nothing else reads it as a source of truth.
    CREATE TABLE IF NOT EXISTS standings (
      entity_type TEXT NOT NULL CHECK (entity_type IN ('person','project','organisation')),
      entity_id TEXT NOT NULL,
      space TEXT NOT NULL CHECK (space IN ('work','personal')),
      lines TEXT NOT NULL DEFAULT '[]',
      fingerprint TEXT NOT NULL DEFAULT '',
      fact_count INTEGER NOT NULL DEFAULT 0,
      written_at INTEGER,
      tried_at INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (entity_type, entity_id)
    );

    CREATE TABLE IF NOT EXISTS effects (
      id TEXT PRIMARY KEY,
      module TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      request TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('started','done','failed','uncertain')),
      result TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      finished_at INTEGER
    );

    -- A channel (a mailbox, a WhatsApp chat) Douglas has said belongs to one
    -- project. It is a hint to the reader, which still decides per fact.
    CREATE TABLE IF NOT EXISTS channel_projects (
      channel TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      set_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- WhatsApp through Hermes. A chat is stored only once Douglas approves it
    -- and gives it a space; until then only its name and when it was seen.
    CREATE TABLE IF NOT EXISTS whatsapp_chats (
      chat_id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      is_group INTEGER NOT NULL DEFAULT 0,
      is_self INTEGER NOT NULL DEFAULT 0,
      peer_phone TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','approved','ignored')),
      space TEXT CHECK (space IN ('work','personal')),
      first_seen INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen INTEGER NOT NULL DEFAULT (unixepoch()),
      seen_count INTEGER NOT NULL DEFAULT 0,
      decided_at INTEGER
    );

    -- Raw messages from approved chats. They wait here until the chat has been
    -- quiet for 5 minutes, then the burst becomes one source.
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      chat_id TEXT NOT NULL REFERENCES whatsapp_chats(chat_id),
      message_id TEXT NOT NULL,
      from_me INTEGER NOT NULL DEFAULT 0,
      sender_phone TEXT NOT NULL DEFAULT '',
      sender_name TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL DEFAULT (unixepoch()),
      source_id TEXT,
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_chat ON whatsapp_messages(chat_id, sent_at);

    -- Google Calendar events inside the planning window, as Google has them.
    -- flexible is Douglas's own word that the Hub may move that appointment.
    CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      calendar_id TEXT NOT NULL,
      space TEXT NOT NULL CHECK (space IN ('work','personal')),
      title TEXT NOT NULL DEFAULT '',
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 0,
      busy INTEGER NOT NULL DEFAULT 1,
      solo INTEGER NOT NULL DEFAULT 0,
      flexible INTEGER NOT NULL DEFAULT 0,
      link TEXT NOT NULL DEFAULT '',
      seen_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(start_at);

    -- The current plan: when each open task gets done. Disposable and rebuilt on
    -- every run; pushed_* is what Google was last told, so a block Douglas drags
    -- in Google can be told apart from one the Hub moved.
    CREATE TABLE IF NOT EXISTS plan_blocks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      space TEXT NOT NULL CHECK (space IN ('work','personal')),
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      late INTEGER NOT NULL DEFAULT 0,
      google_event_id TEXT,
      pushed_start INTEGER,
      pushed_end INTEGER,
      pushed_title TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_plan_blocks_start ON plan_blocks(start_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS atoms_fts USING fts5(atom_id UNINDEXED, space UNINDEXED, statement, topics, tokenize = 'unicode61 remove_diacritics 2');
    CREATE VIRTUAL TABLE IF NOT EXISTS sources_fts USING fts5(source_id UNINDEXED, space UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
  `);
  addColumnIfMissing(_db, 'sources', 'atomise_attempts', 'INTEGER NOT NULL DEFAULT 0');
  migrateOrgText(_db);
  for (const [column, definition] of [
    ['looked_back_at', 'INTEGER'], ['final_checked_at', 'INTEGER'], ['check_attempts', 'INTEGER NOT NULL DEFAULT 0'], ['check_failed', 'INTEGER NOT NULL DEFAULT 0'],
    ['looks_done_source_id', 'TEXT'], ['looks_done_quote', "TEXT NOT NULL DEFAULT ''"], ['not_done_sources', "TEXT NOT NULL DEFAULT '[]'"],
  ]) addColumnIfMissing(_db, 'promises', column, definition);
  // How long a task takes: minutes_by is 'you' (Douglas set it) or 'guess' (the model's estimate).
  for (const [column, definition] of [['minutes', 'INTEGER'], ['minutes_by', "TEXT NOT NULL DEFAULT ''"], ['minutes_tries', 'INTEGER NOT NULL DEFAULT 0']]) addColumnIfMissing(_db, 'tasks', column, definition);
  addColumnIfMissing(_db, 'people', 'unit_id', 'TEXT REFERENCES org_units(id) ON DELETE SET NULL');
  _db.exec(`
    DROP VIEW IF EXISTS people_v;
    CREATE VIEW people_v AS
      SELECT p.*, COALESCE(o.name, '') AS org,
             CASE u.kind WHEN 'team' THEN d.name WHEN 'department' THEN u.name ELSE '' END AS dept,
             CASE u.kind WHEN 'team' THEN u.name ELSE '' END AS team
        FROM people p
        LEFT JOIN organisations o ON o.id = p.org_id
        LEFT JOIN org_units u ON u.id = p.unit_id
        LEFT JOIN org_units d ON d.id = u.parent_id;
  `);
  return _db;
}

// Older crm.db files predate a column; CREATE TABLE IF NOT EXISTS won't add it.
function addColumnIfMissing(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Phase 1 stored a person's organisation as free text. Turn each distinct
// name into an organisation in the person's space, link it, and retire the
// text column so nothing reads it again.
function migrateOrgText(db) {
  const cols = db.prepare('PRAGMA table_info(people)').all().map(c => c.name);
  if (!cols.includes('org_id')) db.exec('ALTER TABLE people ADD COLUMN org_id TEXT REFERENCES organisations(id) ON DELETE SET NULL');
  if (!cols.includes('org')) return;
  const { randomUUID } = require('crypto');
  const norm = v => String(v).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9'\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
  db.transaction(() => {
    for (const r of db.prepare("SELECT id, space, org FROM people WHERE TRIM(org) != ''").all()) {
      const n = norm(r.org);
      if (!n) continue;
      let org = db.prepare('SELECT id FROM organisations WHERE space = ? AND name_norm = ?').get(r.space, n);
      if (!org) {
        org = { id: randomUUID() };
        db.prepare('INSERT INTO organisations (id, space, name, name_norm) VALUES (?, ?, ?, ?)').run(org.id, r.space, r.org.trim(), n);
      }
      db.prepare('UPDATE people SET org_id = ? WHERE id = ?').run(org.id, r.id);
    }
    db.exec('ALTER TABLE people RENAME COLUMN org TO org_legacy');
  })();
}

function setting(key, fallback = null) {
  const row = crm().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  crm().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function now() { return Math.floor(Date.now() / 1000); }

// Test hook: drop the cached handle so a fresh CRM_DB_PATH takes effect.
function _reset() { if (_db) { _db.close(); _db = null; } }

module.exports = { crm, setting, setSetting, now, SPACES, _reset };
