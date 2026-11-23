'use strict';

// Unified attention inbox across both spaces: gathers every item waiting on a
// decision by Douglas into three priority buckets (urgent/blocking, quick
// triage, optional) so he never has to hunt across a dozen separate queues.

const { crm, now } = require('./db');
const review = require('./review');
const promises = require('./promises');
const followups = require('./task-followups');
const keepintouch = require('./keepintouch');
const whatsapp = require('./whatsapp');
const imports = require('./imports');
const views = require('./views');

function summary(t = now()) {
  const db = crm();
  const recordings = db.prepare("SELECT id, title, origin, occurred_at, received_at FROM krisp_intake WHERE status = 'pending' ORDER BY COALESCE(occurred_at, received_at) DESC").all();

  const looksDone = [];
  const unsurePromises = [];
  const followList = [];
  const likelyTasks = [];
  const healthBad = [];
  const cadence = [];
  const failedSources = [];

  for (const space of ['work', 'personal']) {
    const ledger = promises.ledger(space);
    for (const p of [...ledger.mine, ...ledger.owed]) {
      if (p.looks_done_source_id) looksDone.push({ ...p, space });
      else if (p.direction === 'mine' && !p.task_id && !p.is_request) unsurePromises.push({ ...p, space });
    }
    for (const f of followups.suggested(space)) followList.push({ ...f, space });
    for (const row of db.prepare(`
      SELECT e.task_id, e.source_id, e.quote, t.title, s.title AS source_title
        FROM task_email_evidence e
        JOIN tasks t ON t.id = e.task_id
        JOIN sources s ON s.id = e.source_id
       WHERE t.space = ? AND t.status = 'needsAction' AND e.verdict = 'likely'
       ORDER BY e.checked_at DESC LIMIT 20
    `).all(space)) likelyTasks.push({ ...row, space });
    for (const h of views.health(space).filter(x => x.level === 'bad')) healthBad.push({ ...h, space });
    for (const c of keepintouch.suggestions(space, 5, t)) cadence.push({ ...c, space });
    const badSrc = db.prepare("SELECT COUNT(*) AS n FROM sources WHERE space = ? AND atomise_status = 'failed'").get(space).n;
    if (badSrc) failedSources.push({ space, count: badSrc });
  }

  const reviewItems = review.openItems();
  const automatedCount = reviewItems.filter(i => i.kind === 'person' && i.payload?.automated).length;
  const whatsappChats = whatsapp.list().waiting;
  const importCount = imports.count();

  const urgentCount = recordings.length + looksDone.length + likelyTasks.length + followList.length + healthBad.length;
  const triageCount = reviewItems.length + whatsappChats.length + unsurePromises.length;
  const optionalCount = cadence.length + (importCount > 0 ? 1 : 0);

  return {
    urgent: { recordings, looksDone, likelyTasks, followups: followList, healthBad, failedSources, count: urgentCount },
    triage: { reviewItems, automatedCount, whatsappChats, unsurePromises, count: triageCount },
    optional: { cadence, importCount, count: optionalCount },
    total: urgentCount + triageCount,
  };
}

function badgeCount() {
  const db = crm();
  const rec = db.prepare("SELECT COUNT(*) AS n FROM krisp_intake WHERE status = 'pending'").get().n;
  const rev = review.openCount();
  const wa = whatsapp.waitingCount();
  const fu = db.prepare("SELECT COUNT(*) AS n FROM followup_suggestions WHERE state = 'suggested'").get().n;
  const looks = db.prepare("SELECT COUNT(*) AS n FROM promises WHERE state = 'open' AND looks_done_source_id IS NOT NULL").get().n;
  return rec + rev + wa + fu + looks;
}

module.exports = { summary, badgeCount };
