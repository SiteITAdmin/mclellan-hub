'use strict';

module.exports = `
  CREATE TABLE IF NOT EXISTS house_mail (
    gmail_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    sender TEXT NOT NULL DEFAULT '',
    recipients TEXT NOT NULL DEFAULT '',
    occurred_at INTEGER NOT NULL,
    body TEXT,
    links TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','reading','failed','read','unreadable','stale')),
    job_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    queued_at INTEGER,
    error TEXT NOT NULL DEFAULT '',
    direction TEXT NOT NULL DEFAULT 'received',
    captured_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS house_mail_queue ON house_mail(status, occurred_at);
  CREATE INDEX IF NOT EXISTS house_mail_thread ON house_mail(thread_id);

  CREATE TABLE IF NOT EXISTS house_properties (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    daft_id TEXT UNIQUE,
    asking_price INTEGER,
    beds INTEGER,
    area REAL,
    status TEXT NOT NULL DEFAULT 'researching',
    notes TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS house_events (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'confirmed' CHECK (state IN ('suggested','confirmed','dismissed')),
    property_id TEXT REFERENCES house_properties(id),
    replaces_id TEXT REFERENCES house_events(id),
    superseded_at INTEGER,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    day TEXT NOT NULL DEFAULT '',
    time TEXT NOT NULL DEFAULT '',
    amount INTEGER,
    person TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    gmail_id TEXT REFERENCES house_mail(gmail_id),
    quote TEXT NOT NULL DEFAULT '',
    listing TEXT,
    dedupe_key TEXT UNIQUE,
    occurred_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS house_events_state ON house_events(state, occurred_at);
  CREATE INDEX IF NOT EXISTS house_events_property ON house_events(property_id, occurred_at);

  CREATE TABLE IF NOT EXISTS house_valuations (
    property_id TEXT PRIMARY KEY REFERENCES house_properties(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    county TEXT NOT NULL,
    locality TEXT NOT NULL,
    snapshot TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS house_sale_comparables (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL REFERENCES house_properties(id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    day TEXT NOT NULL,
    sold INTEGER NOT NULL,
    asking INTEGER,
    beds INTEGER,
    area REAL,
    url TEXT NOT NULL,
    source_id TEXT NOT NULL,
    UNIQUE(property_id, source_id)
  );
`;
