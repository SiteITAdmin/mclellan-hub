'use strict';

// The old Hub emailed its automated reports to nakai@mclellan.scot from
// Douglas's account. The three-month look-back took them for his own words.

const { crm, setting, setSetting, now } = require('./db');

const NAKAI_REPORT = /^(Daily Briefing \d+|US Block Special Edition)\b/i;
const NAKAI_ADDRESS = 'nakai@mclellan.scot';

function isNakaiReport(subject, recipients) {
  return NAKAI_REPORT.test(String(subject || '').trim())
    && recipients.length > 0 && recipients.every(e => String(e).toLowerCase() === NAKAI_ADDRESS);
}

// Runs once. Facts another email also supports stay, with that email as their
// only source. An older fact one of these replaced becomes current again.
function removeNakaiReports() {
  if (setting('nakai_reports_removed')) return null;
  const db = crm();
  const result = db.transaction(() => {
    const sentMail = db.prepare("SELECT id, title FROM sources WHERE origin = 'gmail' AND direction = 'out'").all();
    const recipients = db.prepare("SELECT value FROM source_addresses WHERE source_id = ? AND role != 'from'");
    const { isSelf } = require('./identity');
    const ids = sentMail.filter(s => isNakaiReport(s.title, recipients.all(s.id).map(r => r.value).filter(v => !isSelf(v)))).map(s => s.id);
    if (!ids.length) return { sources: 0, atoms: 0 };
    const marks = ids.map(() => '?').join(',');
    const only = db.prepare(`
      SELECT atom_id FROM atom_sources GROUP BY atom_id
      HAVING SUM(CASE WHEN source_id IN (${marks}) THEN 1 ELSE 0 END) = COUNT(*)
    `).all(...ids).map(r => r.atom_id);
    const topicIds = new Set();
    const topicsOf = db.prepare('SELECT topic_id FROM atom_topics WHERE atom_id = ?');
    for (const atomId of only) {
      for (const t of topicsOf.all(atomId)) topicIds.add(t.topic_id);
      db.prepare("UPDATE atoms SET status = 'active', superseded_by = NULL WHERE superseded_by = ?").run(atomId);
      db.prepare('DELETE FROM atoms_fts WHERE atom_id = ?').run(atomId);
      db.prepare('DELETE FROM atoms WHERE id = ?').run(atomId);
    }
    for (const id of ids) {
      db.prepare('DELETE FROM sources_fts WHERE source_id = ?').run(id);
      db.prepare('DELETE FROM sources WHERE id = ?').run(id);
    }
    for (const id of topicIds) {
      if (!db.prepare('SELECT 1 FROM atom_topics WHERE topic_id = ? LIMIT 1').get(id)) db.prepare('DELETE FROM topics WHERE id = ?').run(id);
    }
    let reviewRemoved = 0;
    for (const item of db.prepare("SELECT id, kind, payload FROM review_items WHERE status = 'open' AND kind IN ('mention','project')").all()) {
      const p = JSON.parse(item.payload);
      if (item.kind === 'mention') {
        if (!db.prepare('SELECT 1 FROM atom_mentions WHERE id = ?').get(p.mentionId)) reviewRemoved += db.prepare('DELETE FROM review_items WHERE id = ?').run(item.id).changes;
      } else {
        const atomIds = p.atomIds.filter(id => db.prepare('SELECT 1 FROM atoms WHERE id = ?').get(id));
        if (!atomIds.length) reviewRemoved += db.prepare('DELETE FROM review_items WHERE id = ?').run(item.id).changes;
        else if (atomIds.length !== p.atomIds.length) db.prepare('UPDATE review_items SET payload = ? WHERE id = ?').run(JSON.stringify({ ...p, atomIds }), item.id);
      }
    }
    return { sources: ids.length, atoms: only.length, reviewRemoved };
  })();
  setSetting('nakai_reports_removed', JSON.stringify({ at: now(), ...result }));
  return result;
}

module.exports = { isNakaiReport, removeNakaiReports };
