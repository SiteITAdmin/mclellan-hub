'use strict';

// Read models for the CRM screens. Every view reads sources and atoms; people
// links, last contact and project membership are derived here, not stored.

const { crm, now, setting } = require('./db');
const runs = require('./runs');
const review = require('./review');
const { ftsQuery } = require('./atoms');

const DAY = 86400;

function dublinMidnight(ts = now()) {
  const d = new Date(ts * 1000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).map(p => [p.type, p.value]));
  const secsToday = (Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return ts - secsToday;
}

function personSources(personId, space, limit = 50) {
  return crm().prepare(`
    SELECT DISTINCT s.* FROM identifiers i
      JOIN source_addresses a ON a.kind = i.kind AND a.value = i.value
      JOIN sources s ON s.id = a.source_id
     WHERE i.person_id = ? AND i.status = 'linked' AND s.space = ?
     ORDER BY s.occurred_at DESC LIMIT ?
  `).all(personId, space, limit);
}

function personSourceCount(personId, space) {
  return crm().prepare(`
    SELECT COUNT(DISTINCT s.id) AS n FROM identifiers i
      JOIN source_addresses a ON a.kind = i.kind AND a.value = i.value
      JOIN sources s ON s.id = a.source_id
     WHERE i.person_id = ? AND i.status = 'linked' AND s.space = ?
  `).get(personId, space).n;
}

function lastContact(personId, space) {
  return crm().prepare(`
    SELECT MAX(s.occurred_at) AS t FROM identifiers i
      JOIN source_addresses a ON a.kind = i.kind AND a.value = i.value
      JOIN sources s ON s.id = a.source_id
     WHERE i.person_id = ? AND i.status = 'linked' AND s.space = ?
  `).get(personId, space).t || null;
}

function people(space, q = '') {
  const rows = crm().prepare('SELECT * FROM people WHERE space = ? ORDER BY name COLLATE NOCASE').all(space);
  const needle = String(q || '').trim().toLowerCase();
  return rows
    .filter(p => !needle || p.name.toLowerCase().includes(needle) || p.org.toLowerCase().includes(needle))
    .map(p => ({ ...p, last: lastContact(p.id, space), sources: personSourceCount(p.id, space), facts: atomCountForPerson(p.id) }));
}

function atomCountForPerson(personId) {
  return crm().prepare("SELECT COUNT(DISTINCT m.atom_id) AS n FROM atom_mentions m JOIN atoms a ON a.id = m.atom_id WHERE m.person_id = ? AND a.status = 'active'").get(personId).n;
}

function atomsForPerson(personId, limit = 30) {
  return withDetail(crm().prepare(`
    SELECT DISTINCT a.* FROM atom_mentions m JOIN atoms a ON a.id = m.atom_id
     WHERE m.person_id = ? AND a.status = 'active' ORDER BY a.said_at DESC LIMIT ?
  `).all(personId, limit));
}

function withDetail(atomRows) {
  const db = crm();
  return atomRows.map(a => ({
    ...a,
    sources: db.prepare(`
      SELECT s.id, s.title, s.kind, s.occurred_at, x.quote, x.quote_verified FROM atom_sources x JOIN sources s ON s.id = x.source_id
       WHERE x.atom_id = ? ORDER BY s.occurred_at DESC
    `).all(a.id),
    topics: db.prepare('SELECT t.id, t.name FROM atom_topics x JOIN topics t ON t.id = x.topic_id WHERE x.atom_id = ?').all(a.id),
    projects: db.prepare('SELECT p.id, p.name FROM atom_projects x JOIN projects p ON p.id = x.project_id WHERE x.atom_id = ?').all(a.id),
    mentions: db.prepare('SELECT m.name, m.status, m.person_id, p.name AS person_name FROM atom_mentions m LEFT JOIN people p ON p.id = m.person_id WHERE m.atom_id = ?').all(a.id),
  }));
}

function person(id) {
  const db = crm();
  const p = db.prepare('SELECT * FROM people WHERE id = ?').get(id);
  if (!p) return null;
  return {
    ...p,
    identifiers: db.prepare(`
      SELECT i.*, (SELECT COUNT(DISTINCT a.source_id) FROM source_addresses a JOIN sources s ON s.id = a.source_id
                    WHERE a.kind = i.kind AND a.value = i.value AND s.space = ?) AS sources
        FROM identifiers i WHERE i.person_id = ? AND i.status = 'linked' ORDER BY i.created_at
    `).all(p.space, id),
    aliases: db.prepare('SELECT * FROM aliases WHERE person_id = ? ORDER BY alias').all(id),
    distinct: db.prepare('SELECT p.* FROM distinct_pairs d JOIN people p ON p.id = d.other_id WHERE d.person_id = ?').all(id),
    timeline: personSources(id, p.space, 30),
    sourceCount: personSourceCount(id, p.space),
    atoms: atomsForPerson(id),
    last: lastContact(id, p.space),
    projects: db.prepare(`
      SELECT pr.id, pr.name, COUNT(DISTINCT m.atom_id) AS n FROM atom_mentions m
        JOIN atom_projects ap ON ap.atom_id = m.atom_id JOIN projects pr ON pr.id = ap.project_id
       WHERE m.person_id = ? GROUP BY pr.id ORDER BY n DESC
    `).all(id),
  };
}

function source(id) {
  const db = crm();
  const s = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  if (!s) return null;
  const addresses = db.prepare(`
    SELECT a.*, i.person_id, i.status AS id_status, p.name AS person_name, p.space AS person_space
      FROM source_addresses a LEFT JOIN identifiers i ON i.kind = a.kind AND i.value = a.value
      LEFT JOIN people p ON p.id = i.person_id
     WHERE a.source_id = ? ORDER BY CASE a.role WHEN 'from' THEN 0 WHEN 'to' THEN 1 ELSE 2 END
  `).all(id);
  const atomRows = db.prepare(`
    SELECT a.* FROM atom_sources x JOIN atoms a ON a.id = x.atom_id WHERE x.source_id = ? ORDER BY a.created_at
  `).all(id);
  return { ...s, addresses, atoms: withDetail(atomRows) };
}

function captured(space, { limit = 50, filter = '' } = {}) {
  const where = ['space = ?'];
  const args = [space];
  if (filter === 'attention') where.push("(atomise_status IN ('failed','held') OR readable = 0)");
  return crm().prepare(`SELECT * FROM sources WHERE ${where.join(' AND ')} ORDER BY occurred_at DESC LIMIT ?`).all(...args, limit);
}

function projects(space) {
  return crm().prepare(`
    SELECT p.*, COUNT(DISTINCT ap.atom_id) AS facts, MAX(a.said_at) AS last
      FROM projects p LEFT JOIN atom_projects ap ON ap.project_id = p.id LEFT JOIN atoms a ON a.id = ap.atom_id AND a.status = 'active'
     WHERE p.space = ? GROUP BY p.id ORDER BY p.name COLLATE NOCASE
  `).all(space);
}

function project(id) {
  const db = crm();
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!p) return null;
  const atomRows = db.prepare(`
    SELECT a.* FROM atom_projects ap JOIN atoms a ON a.id = ap.atom_id
     WHERE ap.project_id = ? AND a.status = 'active' ORDER BY a.said_at DESC LIMIT 60
  `).all(id);
  return {
    ...p,
    atoms: withDetail(atomRows),
    people: db.prepare(`
      SELECT pe.id, pe.name, pe.hue, COUNT(DISTINCT m.atom_id) AS n FROM atom_projects ap
        JOIN atom_mentions m ON m.atom_id = ap.atom_id JOIN people pe ON pe.id = m.person_id
       WHERE ap.project_id = ? GROUP BY pe.id ORDER BY n DESC LIMIT 12
    `).all(id),
    topics: db.prepare(`
      SELECT t.id, t.name, COUNT(*) AS n FROM atom_projects ap JOIN atom_topics at ON at.atom_id = ap.atom_id
        JOIN topics t ON t.id = at.topic_id WHERE ap.project_id = ? GROUP BY t.id ORDER BY n DESC LIMIT 12
    `).all(id),
  };
}

function topic(id) {
  const db = crm();
  const t = db.prepare('SELECT * FROM topics WHERE id = ?').get(id);
  if (!t) return null;
  const atomRows = db.prepare(`
    SELECT a.* FROM atom_topics x JOIN atoms a ON a.id = x.atom_id WHERE x.topic_id = ? AND a.status = 'active' ORDER BY a.said_at DESC LIMIT 60
  `).all(id);
  return { ...t, atoms: withDetail(atomRows) };
}

function search(space, q) {
  const query = String(q || '').trim();
  if (!query) return { atoms: [], sources: [], people: [] };
  const fts = ftsQuery(query, 8) || `"${query.replace(/"/g, '')}"`;
  const db = crm();
  let atomRows = [];
  let sourceRows = [];
  try {
    atomRows = db.prepare(`
      SELECT a.* FROM atoms_fts f JOIN atoms a ON a.id = f.atom_id
       WHERE atoms_fts MATCH ? AND f.space = ? AND a.status = 'active' ORDER BY bm25(atoms_fts) LIMIT 30
    `).all(fts, space);
    sourceRows = db.prepare(`
      SELECT s.id, s.title, s.kind, s.occurred_at, snippet(sources_fts, 3, '', '', ' … ', 18) AS snip FROM sources_fts f JOIN sources s ON s.id = f.source_id
       WHERE sources_fts MATCH ? AND f.space = ? ORDER BY bm25(sources_fts) LIMIT 20
    `).all(fts, space);
  } catch (_) { /* a query FTS can't parse returns nothing rather than an error page */ }
  return { atoms: withDetail(atomRows), sources: sourceRows, people: people(space, query).slice(0, 8) };
}

function topicsThisWeek(space, limit = 8) {
  return crm().prepare(`
    SELECT t.id, t.name, COUNT(DISTINCT a.id) AS n FROM atoms a JOIN atom_topics x ON x.atom_id = a.id JOIN topics t ON t.id = x.topic_id
     WHERE a.space = ? AND a.created_at > ? AND a.status = 'active' GROUP BY t.id ORDER BY n DESC, t.name LIMIT ?
  `).all(space, now() - 7 * DAY, limit);
}

function recentAtoms(space, limit = 6) {
  return withDetail(crm().prepare(`
    SELECT * FROM atoms WHERE space = ? AND status = 'active' AND is_history = 0 ORDER BY created_at DESC LIMIT ?
  `).all(space, limit));
}

// What could be silently wrong right now, in words.
function health(space) {
  const r = runs.all();
  const out = [];
  const t = now();
  const capture = space === 'work' ? r.outlook_capture : r.gmail_capture;
  const label = space === 'work' ? 'Outlook mail' : 'Gmail';
  if (!capture || !capture.last_started) out.push({ level: 'warn', text: `${label} capture hasn't run yet` });
  else if (capture.last_error && (!capture.last_ok || capture.last_error_at > capture.last_ok)) out.push({ level: 'bad', text: `${label} capture failed: ${capture.last_error}` });
  else if (capture.last_ok < t - 45 * 60) out.push({ level: 'bad', text: `${label} capture last worked ${ago(capture.last_ok)}` });
  if (space === 'work') {
    const lastFile = setting('outlook_last_file_at');
    const lastTs = lastFile ? Math.floor(Date.parse(lastFile) / 1000) : null;
    const dow = new Date().toLocaleDateString('en-GB', { timeZone: 'Europe/Dublin', weekday: 'short' });
    if (lastTs && lastTs < t - 30 * 3600 && !['Sat', 'Sun', 'Mon'].includes(dow)) {
      out.push({ level: 'bad', text: `No work email has arrived from the Outlook flow since ${ago(lastTs)}` });
    }
  }
  const a = r.atomise;
  if (a && a.last_error && (!a.last_ok || a.last_error_at > a.last_ok)) out.push({ level: 'bad', text: `Reading sources failed: ${a.last_error}` });
  const stuck = crm().prepare(`
    SELECT s.id, s.title FROM sources s WHERE s.atomise_status = 'queued'
  `).all();
  if (stuck.length) {
    const job = require('../subscription-agent-jobs').getJob(crm().prepare("SELECT atomise_job_id FROM sources WHERE atomise_status = 'queued' LIMIT 1").get()?.atomise_job_id);
    if (job && job.status === 'pending' && job.created_at < t - 20 * 60) {
      out.push({ level: 'bad', text: `The Mac worker hasn't picked up a job since ${ago(job.created_at)}. Check com.mclellan.hub.subscription-agent-worker` });
    }
  }
  const failed = crm().prepare("SELECT COUNT(*) AS n FROM sources WHERE space = ? AND atomise_status = 'failed'").get(space).n;
  if (failed) out.push({ level: 'bad', text: `${failed} source${failed === 1 ? '' : 's'} couldn't be read into facts`, href: `/crm/${space}/captured?filter=attention` });
  return out;
}

function ago(ts) {
  if (!ts) return 'never';
  const d = now() - ts;
  if (d < 90) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < DAY) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / DAY)} days ago`;
}

function today(space) {
  const db = crm();
  const midnight = dublinMidnight();
  const r = runs.all();
  const capture = space === 'work' ? r.outlook_capture : r.gmail_capture;
  return {
    capturedToday: db.prepare('SELECT COUNT(*) AS n FROM sources WHERE space = ? AND created_at >= ?').get(space, midnight).n,
    factsToday: db.prepare('SELECT COUNT(*) AS n FROM atoms WHERE space = ? AND created_at >= ? AND is_history = 0').get(space, midnight).n,
    waitingReview: review.openCount(space),
    reviewAll: review.openCount(),
    peopleCount: db.prepare('SELECT COUNT(*) AS n FROM people WHERE space = ?').get(space).n,
    reading: db.prepare("SELECT COUNT(*) AS n FROM sources WHERE space = ? AND atomise_status IN ('pending','queued')").get(space).n,
    held: db.prepare("SELECT COUNT(*) AS n FROM sources WHERE space = ? AND atomise_status = 'held'").get(space).n,
    captured: captured(space, { limit: 6 }),
    facts: recentAtoms(space, 6),
    topics: topicsThisWeek(space),
    projects: projects(space),
    health: health(space),
    captureLast: capture?.last_ok || null,
    totalFacts: db.prepare("SELECT COUNT(*) AS n FROM atoms WHERE space = ? AND status = 'active'").get(space).n,
  };
}

module.exports = { today, people, person, source, captured, projects, project, topic, search, health, ago, dublinMidnight };
