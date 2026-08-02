const db = require('./db');
const { uuid } = require('./id');
const { recordProcessingFailure, resolveProcessingFailure } = require('./processing-failures');
const {
  fetchEmailById,
  fetchEmailByIdWithClient,
  fetchMessagesByLabelId,
  fetchNewEmails,
  fetchNewPromotionEmails,
  fetchSentEmails,
  moveToLabel,
} = require('./gmail');
const { writeNote } = require('./obsidian-vault');
const { requestModelObject } = require('./model-request');
const { TASK_CODES } = require('./openrouter-attribution');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');
const { legacyDirectCrmWritesEnabled } = require('./crm-pipeline-mode');
const { isApprovedExternalEmail, extractTopicsFromEmail } = require('./newsletter-pipeline');
const { extractOpportunitySignals } = require('./opportunity-engine');
const {
  getEnabledEmailLabels,
  learnFromPendingEmailLabels,
  learnFromRecentEmailLabelCorrections,
  matchEmailTaxonomy,
  recordPendingEmail,
} = require('./email-taxonomy');
const { createTask } = require('./google-tasks');
const { appendContactVaultEntry } = require('./crm');

const ALERT_EMAIL_RE = /\b(security alert|new login|new sign-?in|verification code|suspicious|password reset|2fa|two-factor|authenticator)\b/i;

// ── Ryanair booking auto-import ───────────────────────────────────────────────

const MONTH_MAP = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };

const CITY_IATA = {
  dublin: 'DUB', edinburgh: 'EDI', glasgow: 'GLA',
  reus: 'REU', manchester: 'MAN', 'london stansted': 'STN', london: 'STN',
};

function parseRyanairDate(str) {
  const m = str.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2,4})/);
  if (!m) return null;
  const day = m[1].padStart(2, '0');
  const mon = String(MONTH_MAP[m[2]]).padStart(2, '0');
  const yr = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${yr}-${mon}-${day}`;
}

function detectRyanairFlights(email) {
  if (!/itinerary@ryanair\.com/i.test(email.fromEmail || '')) return [];
  const body = email.bodyText || '';

  // Log body sample so we can debug format issues
  console.log(`[email] Ryanair body sample: ${body.slice(0, 400).replace(/\n/g, ' ')}`);

  const reservationMatch = body.match(/Reservation:?\s*([A-Z0-9]{6})/i);
  const ref = reservationMatch ? reservationMatch[1] : null;

  const flights = [];
  // No leading \b — HTML stripping can leave "EdinburghFR808" with no word boundary
  const frRe = /FR\s*(\d{3,4})/g;
  const positions = [];
  let m;
  while ((m = frRe.exec(body)) !== null) positions.push({ num: 'FR' + m[1], idx: m.index });

  if (!positions.length) {
    console.warn(`[email] Ryanair itinerary email but no flight numbers found — body: ${body.slice(0, 300)}`);
    return [];
  }

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].idx;
    const end = positions[i + 1]?.idx ?? body.length;
    const chunk = body.slice(start, end);

    const date = parseRyanairDate(chunk);
    const dep = chunk.match(/Departure time\s*[-:]\s*(\d{2}:\d{2})/i)?.[1] ?? null;
    const arr = chunk.match(/Arrival time\s*[-:]\s*(\d{2}:\d{2})/i)?.[1] ?? null;

    // Try IATA codes with parentheses, then without, then fall back to city names
    let direction = null;
    const iataParens = chunk.match(/\(([A-Z]{3})\)\s*[-–]?\s*\(([A-Z]{3})\)/);
    const iataPlain  = chunk.match(/\b([A-Z]{3})\s*[-–]\s*([A-Z]{3})\b/);
    const cityRoute  = chunk.match(/\b(Dublin|Edinburgh|Glasgow|Reus|Manchester|London)\s*[-–]\s*(Dublin|Edinburgh|Glasgow|Reus|Manchester|London)\b/i);

    if (iataParens) {
      direction = `${iataParens[1]}-${iataParens[2]}`;
    } else if (iataPlain) {
      direction = `${iataPlain[1]}-${iataPlain[2]}`;
    } else if (cityRoute) {
      const from = CITY_IATA[cityRoute[1].toLowerCase()];
      const to   = CITY_IATA[cityRoute[2].toLowerCase()];
      if (from && to) direction = `${from}-${to}`;
    }

    if (!date || !direction) {
      console.warn(`[email] Ryanair leg ${positions[i].num}: missing date=${date} direction=${direction} — chunk: ${chunk.slice(0, 200)}`);
      continue;
    }
    flights.push({
      flightNumber: positions[i].num,
      date,
      scheduledDep: dep,
      scheduledArr: arr,
      direction,
      notes: ref ? `Booking ref ${ref}` : '',
    });
  }
  return flights;
}
const AUTOMATED_SENDER_RE = /\b(no-?reply|notifications?|security|accounts?|support|automated|mailer|noreply)\b/i;

// ── Pre-classification email filter ──────────────────────────────────────────

// Skip entirely — store as __skip to prevent reprocessing, no LLM, no digest
const SKIP_DOMAINS = [
  'confused.com', 'moneysupermarket.com', 'comparethemarket.com',
  'gocompare.com', 'uswitch.com', 'meerkat.com',
];

// Store silently as __system — no LLM, excluded from digest, kept in DB
const SILENT_SUBJECT_RE = /\b(verification code|verify your (email|account)|activate your (account|email)|new sign.?in|new login|new device|suspicious sign.?in|password reset|reset your password|two.?factor|2fa code|authenticator code|backup (complete|ran|success|failed)|api key (generated|created|rotated)|scheduled (backup|report|task)|system alert|server (alert|error|down))\b/i;

// Trusted retail senders — always process normally
const TRUSTED_RETAIL = ['coop.co.uk', 'coopfood.co.uk', 'co-op', 'creatorsfriends', 'creators friends'];

function categorizeEmail(email) {
  const domain = (email.fromEmail || '').split('@')[1]?.toLowerCase() || '';
  const from   = `${email.fromName || ''} ${email.fromEmail || ''}`.toLowerCase();
  const subj   = (email.subject  || '').toLowerCase();
  const body   = (email.bodyText || '').slice(0, 300).toLowerCase();

  if (SKIP_DOMAINS.some(d => domain.includes(d))) return 'skip';
  if (SILENT_SUBJECT_RE.test(subj) || SILENT_SUBJECT_RE.test(body)) return 'silent';
  if (TRUSTED_RETAIL.some(t => from.includes(t) || domain.includes(t))) return null;
  return null;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function gmailRawMetadata(email, direction) {
  const headers = Array.isArray(email?.rawHeaders)
    ? email.rawHeaders.map(header => ({ name: String(header?.name || ''), value: String(header?.value || '') }))
    : [];
  const metadata = {
    provider: 'gmail',
    direction,
    thread_id: email?.threadId || null,
    label_ids: Array.isArray(email?.labelIds) ? email.labelIds : [],
    headers,
  };
  if (Array.isArray(email?.attachments) && email.attachments.length) metadata.attachments = email.attachments;
  return JSON.stringify(metadata);
}

function preserveGmailAttachmentManifest(hub, messageId, metadata) {
  if (metadata.includes('"attachments"')) return metadata;
  const existing = hub.prepare('SELECT raw_metadata FROM email_summaries WHERE gmail_message_id = ?').get(messageId);
  if (!existing?.raw_metadata) return metadata;
  try {
    const current = JSON.parse(existing.raw_metadata);
    if (!Array.isArray(current.attachments) || !current.attachments.length) return metadata;
    const next = JSON.parse(metadata);
    next.attachments = current.attachments;
    return JSON.stringify(next);
  } catch (_) {
    return metadata;
  }
}

// Capture is deliberately a small, synchronous boundary before any model,
// classifier, or derived projection sees a Gmail message.  On a later failure
// this row remains a durable retry record instead of an invisible fetch.
function captureRawGmailEmail(hub, user, email, { direction = 'received' } = {}) {
  const sent = direction === 'sent';
  const name = sent ? email.toName : email.fromName;
  const address = sent ? email.toEmail : email.fromEmail;
  const timestamp = sent ? email.sentAt : email.receivedAt;
  const metadata = gmailRawMetadata(email, direction);
  hub.prepare(`
    INSERT INTO email_summaries
      (id, user, gmail_message_id, subject, from_name, from_email, received_at,
       summary, direction, body_text, raw_metadata, ingestion_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 'captured')
    ON CONFLICT(gmail_message_id) DO UPDATE SET
      subject = COALESCE(excluded.subject, email_summaries.subject),
      from_name = COALESCE(excluded.from_name, email_summaries.from_name),
      from_email = COALESCE(excluded.from_email, email_summaries.from_email),
      received_at = COALESCE(excluded.received_at, email_summaries.received_at),
      direction = excluded.direction,
      body_text = CASE
        WHEN TRIM(COALESCE(excluded.body_text, '')) != '' THEN excluded.body_text
        ELSE email_summaries.body_text
      END,
      raw_metadata = CASE
        WHEN excluded.raw_metadata IS NOT NULL AND excluded.raw_metadata != '{}' THEN excluded.raw_metadata
        ELSE email_summaries.raw_metadata
      END,
      ingestion_status = CASE
        WHEN COALESCE(email_summaries.ingestion_status, 'processed') = 'processed' THEN 'processed'
        ELSE 'captured'
      END
  `).run(
    uuid(), user, email.id, email.subject || '(no subject)', name || '', address || '', timestamp || null,
    direction, email.bodyText == null ? null : String(email.bodyText),
    preserveGmailAttachmentManifest(hub, email.id, metadata),
  );
}

function markRawGmailEmail(hub, user, messageId, status, { projectSlug = null } = {}) {
  if (projectSlug) {
    hub.prepare(`
      UPDATE email_summaries
         SET ingestion_status = ?, project_slug = ?, processed_at = unixepoch()
       WHERE user = ? AND gmail_message_id = ?
    `).run(status, projectSlug, user, messageId);
    return;
  }
  hub.prepare(`
    UPDATE email_summaries
       SET ingestion_status = ?, processed_at = unixepoch()
     WHERE user = ? AND gmail_message_id = ?
  `).run(status, user, messageId);
}

function recordGmailSemanticCompatibility(hub, user, email, result, { direction = 'received', projectSlug = null, contactId = null } = {}) {
  // Name/project-routed compatibility fields are a rollback-only path.  The
  // normal evidence pipeline intentionally leaves raw Gmail rows unprojected.
  if (!legacyDirectCrmWritesEnabled()) {
    markRawGmailEmail(hub, user, email.id, 'processed');
    return;
  }
  hub.prepare(`
    UPDATE email_summaries
       SET summary = ?, project_slug = ?, contact_id = ?, ingestion_status = 'processed', processed_at = unixepoch()
     WHERE user = ? AND gmail_message_id = ? AND direction = ?
  `).run(result?.summary || '', projectSlug, contactId, user, email.id, direction);
}

function isAutomatedAlertEmail(email) {
  const haystack = [
    email.fromName,
    email.fromEmail,
    email.subject,
    email.bodyText?.slice(0, 500),
  ].filter(Boolean).join('\n');
  return ALERT_EMAIL_RE.test(haystack) || (
    AUTOMATED_SENDER_RE.test(`${email.fromName || ''} ${email.fromEmail || ''}`) &&
    /\b(login|sign-?in|security|verification|password|alert)\b/i.test(haystack)
  );
}

function contactMatchesSender(contact, email) {
  const senderName = normalizeEmail(email.fromName);
  const senderEmail = normalizeEmail(email.fromEmail);
  const contactName = normalizeEmail(contact.name);
  const contactEmail = normalizeEmail(contact.email);

  if (contactEmail && senderEmail === contactEmail) return true;
  if (contactName && senderName === contactName) return true;
  return false;
}

function subjectExplicitlyMentionsContact(contact, email) {
  const subject = normalizeEmail(email.subject);
  const contactName = normalizeEmail(contact.name);
  if (!subject || !contactName || contactName.length < 3) return false;
  return new RegExp(`(^|\\b)${contactName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\b|$)`, 'i').test(subject);
}

// Best-effort semantic retrieval over the knowledge layer (L3). Surfaces
// background that names + emails alone cannot — e.g. that an address in the body
// belongs to a known contact. Never blocks classification if embeddings fail.
async function buildKnowledgeBlock(user, queryText, k = 5) {
  try {
    const { semanticSearch } = require('./retrieval');
    const hits = await semanticSearch(user, queryText, k, { minScore: 0.15 });
    if (!hits.length) return '';
    return '\n\nRelevant background from existing records (use to identify who or what this email concerns, to enrich the fact, and to recognise when the email is ABOUT a known person or place even if their name is not obvious in the email):\n'
      + hits.map(h => `- ${h.chunk_text.slice(0, 220)}`).join('\n');
  } catch (err) {
    console.warn('[email] knowledge retrieval skipped:', err.message);
    return '';
  }
}

// Three attempts (not the shared default of two): classification failures
// strand real emails in processing_failures, so the extra retry is worth it.
function requestClassifierJson({ prompt, modelId, feature, defaults, label }) {
  return requestModelObject({
    modelId,
    messages: [{ role: 'user', content: prompt }],
    feature,
    modelKey: feature,
    taskCode: TASK_CODES.EMAIL_CLASSIFICATION,
    defaults,
    label,
    attempts: 3,
  });
}

// ── Classify a single email against contacts + projects ───────────────────────

async function classifyEmail(email, contacts, projects, emailLabels, user = 'douglas', taskSource = 'email') {
  const { formatLearnedTaskRules } = require('./task-learning');
  const contactList = contacts.length
    ? contacts.map(c => `- ${c.name}${c.email ? ` <${c.email}>` : ''}`).join('\n')
    : '(none yet)';
  const projectList = projects.map(p => `- ${p.slug}: ${p.name}`).join('\n');
  const labelList = emailLabels.length
    ? emailLabels.map(label => `- ${label}`).join('\n')
    : '(none configured)';

  const defaultPrompt = `You are classifying an email for a personal CRM and project system.

Email:
From: ${email.fromName} <${email.fromEmail}>
Subject: ${email.subject}
Body: ${email.bodyText.slice(0, 1000)}

Known contacts:
${contactList}

Known projects/categories:
${projectList}

Allowed Gmail labels:
${labelList}

Return ONLY valid JSON:
{
  "contact_name": "exact name from the contacts list if this email is FROM them or the subject line is explicitly about them — otherwise null",
  "project_slug": "exact slug from the projects list if clearly relevant — otherwise null",
  "summary": "one plain-English sentence: what is this email about?",
  "fact": "if contact_name is set, a CRM fact directly evidenced by this email's subject or body (e.g. 'Sent invoice for £450 — April 2026') — otherwise null",
  "move_label": "exact label from the allowed Gmail labels list, or null. Only set if confident.",
  "action_task": "if this email requires a specific action from the recipient (reply needed, form to complete, decision required, payment to make, document to review and sign, etc.) — a short imperative task title (e.g. 'Reply to John re: contract renewal', 'Complete onboarding form for ACME') — otherwise null. Do NOT set for newsletters, notifications, automated alerts, or FYI emails."
}

Rules:
- contact_name MUST match the SENDER (From: name or email address). A contact whose name appears in the email body or subject — but who did not send the email — must be null. The recipient's own name in a greeting ("Hi Douglas") is never grounds for a contact match.
- Do NOT infer a contact from shared surname, employer, or topic alone (e.g. an email about a colleague's pension is not FROM that colleague)
- Only set project_slug if the email clearly belongs to that category — when in doubt, leave null
- The fact must be directly stated or clearly implied by the email content — do not infer or invent details not present in the email
- move_label MUST exactly match an allowed Gmail label; never invent a new label
- summary must be factual and specific
- action_task: only set when the recipient clearly needs to DO something — high bar, not for passive reading
- If uncertain about ANY field, set it to null — do not guess`;
  const prompt = (getSystemPrompt('email_classifier', 'system', PROMPTS.email_classifier || defaultPrompt)
    .replaceAll('[FROM_NAME]', email.fromName || '')
    .replaceAll('[FROM_EMAIL]', email.fromEmail || '')
    .replaceAll('[SUBJECT]', email.subject || '')
    .replaceAll('[BODY]', email.bodyText.slice(0, 1000))
    .replaceAll('[CONTACTS]', contactList)
    .replaceAll('[PROJECTS]', projectList)
    .replaceAll('[LABELS]', labelList))
    + formatLearnedTaskRules(user, taskSource)
    + await buildKnowledgeBlock(user, `${email.subject || ''}. ${(email.bodyText || '').slice(0, 800)}`);

  const modelId = getSystemModelId('email_classifier', 'system', 'google/gemini-2.5-pro-preview');
  return requestClassifierJson({
    prompt,
    modelId,
    feature: 'email_classifier',
    defaults: {
      contact_name: null,
      project_slug: null,
      summary: '',
      fact: null,
      move_label: null,
      action_task: null,
    },
    label: 'Email classifier response',
  });
}

// ── Main: fetch + classify + label + store ────────────────────────────────────

async function appraisePromotionEmails(user, emails, {
  extract = extractOpportunitySignals,
  synthesise = null,
  deliver = null,
} = {}) {
  const hub = db.hub();
  let appraised = 0;
  let candidates = 0;
  for (const email of emails || []) {
    try {
      captureRawGmailEmail(hub, user, email);
      const n = await extract(user, email, { sourceLabel: 'Commerce/Offers' });
      candidates += Number(n || 0);
      appraised++;
      // Keep promotion appraisal distinct from the main classifier terminal
      // state: a user-filed/curated promotion may still be admitted through
      // the label-driven full-ingestion lane below.
      markRawGmailEmail(hub, user, email.id, 'promotion_processed');
      resolveProcessingFailure('gmail_promotion', email.id);
      console.log(`[email-promotions] appraised "${email.subject}" — ${n || 0} candidate(s)`);
    } catch (err) {
      // A captured row is intentionally left visible and re-fetchable after a
      // non-model opportunity appraisal fails.
      try { markRawGmailEmail(hub, user, email.id, 'retry'); } catch (_) {}
      recordProcessingFailure('gmail_promotion', email.id, err);
      console.warn(`[email-promotions] appraisal failed for ${email.id}:`, err.message);
    }
  }
  let suggestions = [];
  if (candidates > 0) {
    const run = synthesise || (async targetUser => {
      const { SUGGESTERS } = require('./suggestion-engine');
      return SUGGESTERS.opportunity(targetUser);
    });
    suggestions = await run(user);
    const send = deliver || (async (targetUser, rows) => {
      const { emailOpportunitySuggestions } = require('./suggestion-engine');
      return emailOpportunitySuggestions(targetUser, rows);
    });
    await send(user, suggestions);
  }
  return { appraised, candidates, suggestions: suggestions.length };
}

// Canonical labels whose contents feed the Intelligence briefing rather than the
// CRM classifier. Everything else Douglas files is routed to classification.
const INTELLIGENCE_LABELS = new Set(['resources/newsletters', 'resources/research']);

// Label-driven ingestion. Gmail's category tabs (Promotions/Social) gate the
// main fetch, so anything Gmail buries there — MasterClass/Maven under
// Resources/Learning, newsletters it decides are "promotions" — never reaches
// the Hub. This polls by label id instead, category-blind: what Douglas (or a
// Gmail filter) has filed is the signal. Intelligence-labelled mail feeds topic
// extraction; the rest is handed to the classifier carrying its filed label so
// the classifier cannot re-file it somewhere else. Dedup: intelligence extraction
// keys on the message id (intel_documents.external_id); classification skips ids
// already summarised or already seen in this run.
async function pollFiledLabels(user, gmail, emailLabels, seenEmailIds) {
  const hub = db.hub();
  const key = '_gmail_label_poll_last_check_ts';
  const row = hub.prepare("SELECT value FROM crm_context WHERE user = ? AND key = ?").get(user, key);
  // First run stays short so it does not pull a large newsletter backlog through
  // the extractor in one poll; steady state is a 15-minute window.
  const sinceTs = row ? parseInt(row.value, 10) : Math.floor(Date.now() / 1000) - 3600;

  let labelList;
  try {
    labelList = (await gmail.users.labels.list({ userId: 'me' })).data.labels || [];
  } catch (err) {
    console.warn('[label-poll] labels.list failed:', err.message);
    return { classifyEmails: [], intelTopics: 0 };
  }
  const idByName = new Map(labelList.map(l => [String(l.name || '').toLowerCase(), l.id]));

  const processedIds = new Set(
    hub.prepare("SELECT gmail_message_id FROM email_summaries WHERE user = ? AND COALESCE(ingestion_status, 'processed') = 'processed' AND body_text IS NOT NULL").all(user).map(r => r.gmail_message_id)
  );

  const classifyEmails = [];
  const classifySeen = new Set();
  let intelTopics = 0;
  let checkpointFailed = false;

  for (const name of emailLabels || []) {
    const lname = String(name || '').toLowerCase();
    const labelId = idByName.get(lname);
    if (!labelId) continue;
    let fetched;
    try {
      fetched = await fetchMessagesByLabelId(gmail, labelId, sinceTs, new Set(), {
        onFetchError: (messageId, err) => recordProcessingFailure('gmail', messageId, err),
        returnErrors: true,
      });
      if (fetched.errors.length) checkpointFailed = true;
    } catch (err) {
      checkpointFailed = true;
      console.warn(`[label-poll] fetch failed for "${name}":`, err.message);
      continue;
    }
    for (const email of fetched.emails) {
      // Label-polled mail can go straight to an extractor, so capture it here
      // rather than relying on the later main-classifier loop.
      try {
        captureRawGmailEmail(hub, user, email);
      } catch (err) {
        checkpointFailed = true;
        recordProcessingFailure('gmail', email.id, err);
        console.warn(`[label-poll] raw capture failed for ${email.id}:`, err.message);
        continue;
      }
      if (INTELLIGENCE_LABELS.has(lname)) {
        try {
          const ids = await extractTopicsFromEmail(email, user, { sourceLabel: name });
          intelTopics += ids.length;
          markRawGmailEmail(hub, user, email.id, 'processed');
        } catch (err) {
          checkpointFailed = true;
          markRawGmailEmail(hub, user, email.id, 'retry');
          console.warn(`[label-poll] intel extract failed for ${email.id}:`, err.message);
        }
        continue;
      }
      if (processedIds.has(email.id) || classifySeen.has(email.id)) continue;
      if (seenEmailIds && seenEmailIds.has(email.id)) continue;
      classifySeen.add(email.id);
      email.filedLabel = name; // honour the label the user filed under
      classifyEmails.push(email);
    }
  }

  if (!checkpointFailed) {
    hub.prepare(`
      INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, ?, ?)
      ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
    `).run(uuid(), user, key, String(Math.max(0, Math.floor(Date.now() / 1000) - 1)));
  }

  return { classifyEmails, intelTopics, checkpointAdvanced: !checkpointFailed };
}

// Label moves are provider side effects, not semantic work. A failed move is
// persisted on the already-processed raw row and retried here on the next poll,
// so replaying a classifier/model is never required just to finish filing mail.
async function retryPendingGmailLabels(user, gmail, emailLabels = []) {
  if (!gmail) return { retried: 0, moved: 0, failed: 0 };
  const hub = db.hub();
  const pending = hub.prepare(`
    SELECT gmail_message_id, gmail_label
    FROM email_summaries
    WHERE user = ?
      AND COALESCE(gmail_label, '') != ''
      AND gmail_label_checked_at IS NULL
      AND COALESCE(ingestion_status, 'processed') IN ('processed', 'promotion_processed')
    ORDER BY COALESCE(processed_at, received_at, 0) ASC
  `).all(user);
  let moved = 0;
  let failed = 0;
  for (const row of pending) {
    if (!row.gmail_message_id || !row.gmail_label) continue;
    try {
      await moveToLabel(gmail, user, row.gmail_message_id, row.gmail_label, emailLabels);
      hub.prepare(`
        UPDATE email_summaries
           SET gmail_label_checked_at = unixepoch()
         WHERE user = ? AND gmail_message_id = ?
      `).run(user, row.gmail_message_id);
      resolveProcessingFailure('gmail_label', row.gmail_message_id);
      moved++;
    } catch (err) {
      failed++;
      recordProcessingFailure('gmail_label', row.gmail_message_id, err);
      console.error(`[email-label] retry failed for ${row.gmail_message_id}:`, err.message);
    }
  }
  return { retried: pending.length, moved, failed };
}

async function processNewEmails(user) {
  const hub = db.hub();

  // Load contacts. crm_context remains as a fallback for older installations.
  const contacts = hub.prepare('SELECT id, name, email FROM contacts WHERE user = ?').all(user);
  const ctxEmails = hub.prepare(
    "SELECT key, value FROM crm_context WHERE user = ? AND key LIKE '%_email'"
  ).all(user);
  const emailByKey = {};
  for (const r of ctxEmails) emailByKey[r.key] = r.value;

  const enrichedContacts = contacts.map(c => ({
    ...c,
    email: c.email || emailByKey[`${c.name.toLowerCase().replace(/\s+/g, '_')}_email`] || null,
  }));

  // Load projects for category matching
  const projects = hub.prepare('SELECT slug, name FROM projects WHERE user = ? ORDER BY name').all(user);
  const emailLabels = getEnabledEmailLabels(user);

  // Fetch new emails (also returns the authenticated gmail client for reuse)
  let emails, gmail, lastCheckTs;
  try {
    ({ emails, gmail, lastCheckTs } = await fetchNewEmails(user));
  } catch (err) {
    console.error(`[email] Gmail fetch failed for ${user}:`, err.message);
    return { processed: 0, moved: 0, error: err.message };
  }

  // Finish any provider label effects left unresolved by a prior run before
  // entering semantic processing. This is a label-only replay and therefore
  // cannot duplicate classifier/extractor side effects.
  const labelRetry = await retryPendingGmailLabels(user, gmail, emailLabels);
  if (labelRetry.failed) {
    console.warn(`[email-label] ${labelRetry.failed} pending move(s) remain unresolved for ${user}`);
  }

  // Promotions stay out of the main fetch to hold marketing volume down, but the
  // bounded lane below still appraises them for time-sensitive offers.
  let promotionResult = { appraised: 0, candidates: 0, suggestions: 0 };
  try {
    const promotionFetch = await fetchNewPromotionEmails(user, gmail);
    const promotionEmails = promotionFetch.emails || [];
    const seenPromotions = new Set(promotionEmails.map(email => email.id));
    const promotionRetries = hub.prepare(`
      SELECT external_id FROM processing_failures
      WHERE source = 'gmail_promotion' AND resolved_at IS NULL
      ORDER BY last_failed_at ASC
    `).all();
    for (const retry of promotionRetries) {
      if (!retry.external_id || seenPromotions.has(retry.external_id)) continue;
      try {
        promotionEmails.push(await fetchEmailByIdWithClient(gmail, retry.external_id));
        seenPromotions.add(retry.external_id);
      } catch (err) {
        console.warn(`[email-promotions] could not refetch ${retry.external_id}:`, err.message);
      }
    }
    promotionResult = await appraisePromotionEmails(user, promotionEmails);
  } catch (err) {
    console.warn(`[email-promotions] fetch/appraisal failed for ${user}:`, err.message);
  }

  const seenEmailIds = new Set(emails.map(email => email.id));

  // Label-driven ingestion (category-blind): pull anything Douglas or a Gmail
  // filter has filed under a canonical label, no matter which category tab Gmail
  // used. Intelligence-labelled mail feeds the briefing; the rest joins the
  // classifier below carrying its filed label.
  let labelPollTopics = 0;
  try {
    const labelPoll = await pollFiledLabels(user, gmail, emailLabels, seenEmailIds);
    labelPollTopics = labelPoll.intelTopics;
    for (const filedEmail of labelPoll.classifyEmails) {
      if (seenEmailIds.has(filedEmail.id)) continue;
      emails.push(filedEmail);
      seenEmailIds.add(filedEmail.id);
      console.log(`[label-poll] admitting filed "${filedEmail.filedLabel}" mail to classifier: "${filedEmail.subject}"`);
    }
    if (labelPollTopics) console.log(`[label-poll] intelligence: ${labelPollTopics} topic(s) from filed mail`);
  } catch (err) {
    console.warn(`[label-poll] ingestion failed for ${user}:`, err.message);
  }
  const retryRows = hub.prepare(`
    SELECT external_id
    FROM processing_failures
    WHERE source = 'gmail' AND resolved_at IS NULL
    ORDER BY last_failed_at ASC
  `).all();
  for (const row of retryRows) {
    if (!row.external_id || seenEmailIds.has(row.external_id)) continue;
    try {
      const retryEmail = await fetchEmailById(user, row.external_id);
      emails.push(retryEmail);
      seenEmailIds.add(row.external_id);
      console.log(`[email] retrying unresolved Gmail failure ${row.external_id}`);
    } catch (err) {
      console.warn(`[email] failed to refetch unresolved Gmail message ${row.external_id}:`, err.message);
    }
  }
  // A process may die after raw capture but before it can record a classifier
  // failure.  Retry those durable captures as well; they are intentionally not
  // treated as processed merely because their Gmail cursor has moved on.
  const capturedRows = hub.prepare(`
    SELECT gmail_message_id
    FROM email_summaries
    WHERE user = ?
      AND COALESCE(direction, 'received') = 'received'
      AND COALESCE(ingestion_status, 'processed') IN ('captured', 'retry')
      AND gmail_message_id NOT LIKE 'agentmail:%'
    ORDER BY processed_at ASC
  `).all(user);
  for (const row of capturedRows) {
    if (!row.gmail_message_id || seenEmailIds.has(row.gmail_message_id)) continue;
    try {
      const retryEmail = await fetchEmailByIdWithClient(gmail, row.gmail_message_id);
      emails.push(retryEmail);
      seenEmailIds.add(row.gmail_message_id);
      console.log(`[email] retrying raw Gmail capture ${row.gmail_message_id}`);
    } catch (err) {
      console.warn(`[email] failed to refetch raw Gmail capture ${row.gmail_message_id}:`, err.message);
    }
  }

  const learned = await learnFromPendingEmailLabels(user, gmail);
  for (const item of learned) {
    console.log(`[email] learned ${item.fromEmail} → "${item.label}" from manual label`);
  }
  const corrections = await learnFromRecentEmailLabelCorrections(user, gmail);
  for (const item of corrections) {
    const previous = item.previousLabel ? ` (was "${item.previousLabel}")` : '';
    console.log(`[email] learned ${item.fromEmail} → "${item.label}" from Gmail correction${previous}`);
  }

  if (!emails.length && process.env.EMAIL_POLL_DEBUG === '1') {
    console.log(`[email] no new received emails for ${user}`);
  }

  if (emails.length) console.log(`[email] classifying ${emails.length} new email(s) for ${user}`);

  let processed = 0;
  let moved = 0;

  for (const email of emails) {
    try {
      captureRawGmailEmail(hub, user, email);

      // ── Skyscanner price alerts: capture before generic skip rules ─────────
      if (/skyscanner/i.test(email.fromEmail || '')) {
        try {
          const { extractTravelPrices } = require('./suggestion-engine');
          const n = await extractTravelPrices(user, email);
          if (n) console.log(`[email] skyscanner: ${n} price point(s) from "${email.subject}"`);
        } catch (err) {
          console.warn('[email] skyscanner extraction failed:', err.message);
        }
      }

      // ── Pre-filter: skip or store silently ─────────────────────────────────
      const emailCat = categorizeEmail(email);
      if (emailCat === 'skip') {
        markRawGmailEmail(hub, user, email.id, 'processed', { projectSlug: '__skip' });
        console.log(`[email] skip: ${email.subject}`);
        processed++;
        continue;
      }
      if (emailCat === 'silent') {
        markRawGmailEmail(hub, user, email.id, 'processed', { projectSlug: '__system' });
        console.log(`[email] silent: ${email.subject}`);
        processed++;
        continue;
      }

      // ── Auto-import Ryanair bookings ────────────────────────────────────────
      const ryanairLegs = detectRyanairFlights(email);
      for (const f of ryanairLegs) {
        const exists = hub.prepare(
          'SELECT id FROM flights WHERE user = ? AND flight_date = ? AND flight_number = ?'
        ).get(user, f.date, f.flightNumber);
        if (!exists) {
          hub.prepare(`
            INSERT INTO flights (id, user, flight_number, airline, direction, flight_date,
              scheduled_dep, scheduled_arr, status, notes)
            VALUES (?, ?, ?, 'Ryanair', ?, ?, ?, ?, 'scheduled', ?)
          `).run(uuid(), user, f.flightNumber, f.direction, f.date,
            f.scheduledDep ?? '', f.scheduledArr ?? '', f.notes);
          console.log(`[email] auto-added flight ${f.flightNumber} ${f.date} (${f.direction})`);
          // Schedule task creation and live tracking via job queue
          const { scheduleJob, scheduleFlightRefresh } = require('./job-queue');
          scheduleJob('mycelium_flights', { user }, null, 'ryanair-email');
          const insertedFlight = hub.prepare(
            'SELECT * FROM flights WHERE user = ? AND flight_number = ? AND flight_date = ?'
          ).get(user, f.flightNumber, f.date);
          if (insertedFlight) scheduleFlightRefresh(insertedFlight);
        }
      }

      const taxonomyMatch = matchEmailTaxonomy(user, email);
      const result = await classifyEmail(email, enrichedContacts, projects, emailLabels, user, 'email');
      const exactSenderContact = enrichedContacts.find(contact =>
        contact.email && normalizeEmail(contact.email) === normalizeEmail(email.fromEmail)
      );
      if (exactSenderContact && !isAutomatedAlertEmail(email)) {
        result.contact_name = exactSenderContact.name;
      }

      // Resolve contact ID from name match
      let contactId = null;
      let matchedContact = null;
      if (result.contact_name) {
        const match = contacts.find(
          c => c.name.toLowerCase() === (result.contact_name || '').toLowerCase()
        );
        if (match) {
          const enriched = enrichedContacts.find(c => c.id === match.id) || match;
          const canAttachToContact = !isAutomatedAlertEmail(email)
            && (contactMatchesSender(enriched, email) || subjectExplicitlyMentionsContact(enriched, email));
          if (canAttachToContact) {
            contactId = match.id;
            matchedContact = enriched;
          } else {
            console.warn(`[email] ignored contact match for ${result.contact_name}: ${email.subject}`);
          }
        }
      }

      // Validate project slug exists
      const validSlug = projects.some(p => p.slug === result.project_slug)
        ? result.project_slug
        : null;

      recordGmailSemanticCompatibility(hub, user, email, result, {
        projectSlug: validSlug,
        contactId,
      });

      // Legacy direct write path. Default is off: source evidence now goes
      // through crm_source_triage -> duplicate review -> synthesis.
      if (legacyDirectCrmWritesEnabled() && contactId && matchedContact && result.fact) {
        const factId = uuid();
        hub.prepare(`
          INSERT INTO crm_facts (id, user, contact_id, fact, status, source, project_slug)
          VALUES (?, ?, ?, ?, 'active', 'email', ?)
        `).run(factId, user, contactId, result.fact, validSlug);
        console.log(`[email] CRM fact added for ${result.contact_name}: ${result.fact}`);
        appendContactVaultEntry(
          matchedContact.name,
          `[email] ${email.subject} — ${result.fact}`,
          { factId, date: new Date(email.receivedAt * 1000) }
        );
      }

      // Legacy direct task path. Default is off; crm_action_projection now owns
      // source-backed task creation after duplicate review.
      if (legacyDirectCrmWritesEnabled() && result.action_task) {
        createTask(user, {
          title: result.action_task,
          notes: `From: ${email.fromName || email.fromEmail} — ${email.subject}\n${result.summary}`,
          source: 'email',
          sourceId: email.id,
          contactId: contactId || null,
          projectSlug: validSlug || null,
        }).catch(err => console.warn('[tasks] email task create failed:', err.message));
      }

      // Inject email into matching project context so it surfaces in chat
      // Priority: explicit project_slug match, then contact-name-as-slug fallback
      const targetSlug = validSlug
        || (result.contact_name ? result.contact_name.toLowerCase().replace(/\s+/g, '-') : null);

      if (legacyDirectCrmWritesEnabled() && targetSlug) {
        const project = hub.prepare(
          'SELECT id FROM projects WHERE user = ? AND slug = ?'
        ).get(user, targetSlug);

        if (project) {
          const dateStr = new Date(email.receivedAt * 1000).toLocaleDateString('en-GB', {
            day: 'numeric', month: 'short', year: 'numeric',
          });
          const emailContext = [
            `📧 *Email — ${dateStr}*`,
            `**From:** ${email.fromName || email.fromEmail}`,
            `**Subject:** ${email.subject}`,
            result.summary,
          ].join('\n');

          hub.prepare(`
            INSERT INTO messages (id, project_id, role, content, user, model, ts)
            VALUES (?, ?, 'assistant', ?, ?, 'email', ?)
          `).run(uuid(), project.id, emailContext, user, email.receivedAt);

          console.log(`[email] added to project /${targetSlug}: "${email.subject}"`);
        }
      }

      // Move only to an enabled canonical label. A label the user already filed
      // under (label-poll mail) is authoritative — never let the classifier
      // re-file it. Then deterministic admin/learned rules, then the classifier.
      const safeLabel = (email.filedLabel && emailLabels.includes(email.filedLabel) ? email.filedLabel : null)
        || taxonomyMatch?.label
        || (emailLabels.includes(result.move_label) ? result.move_label : null)
        || (contactId
          ? emailLabels.find(label =>
              label.toLowerCase() === `people/${matchedContact?.name || result.contact_name}`.toLowerCase()
            )
          : null)
        || (validSlug
          ? emailLabels.find(label =>
              label.toLowerCase() === `projects/${projects.find(p => p.slug === validSlug)?.name}`.toLowerCase()
            )
          : null);

      if (safeLabel && gmail) {
        // Persist the intended effect before touching Gmail. If the provider
        // call fails, the row and receipt are enough for the next label-only
        // retry, even if the process crashes immediately afterwards.
        hub.prepare(`
          UPDATE email_summaries
             SET gmail_label = ?, gmail_label_source = 'hub', gmail_label_checked_at = NULL
           WHERE user = ? AND gmail_message_id = ?
        `).run(safeLabel, user, email.id);
        try {
          await moveToLabel(gmail, user, email.id, safeLabel, emailLabels);
          hub.prepare(`
            UPDATE email_summaries
            SET gmail_label_checked_at = unixepoch()
            WHERE user = ? AND gmail_message_id = ?
          `).run(user, email.id);
          resolveProcessingFailure('gmail_label', email.id);
          moved++;
        } catch (labelErr) {
          recordProcessingFailure('gmail_label', email.id, labelErr);
          console.error(`[email] label error for message ${email.id}:`, labelErr.message);
        }
      } else {
        recordPendingEmail(user, email);
        console.log(`[email] left unclassified for user training: ${email.subject}`);
      }

      // Newsletter topic extraction — fire async, don't block CRM pipeline
      if (isApprovedExternalEmail(user, email, taxonomyMatch?.label || safeLabel || '')) {
        setImmediate(() => {
          extractTopicsFromEmail(email, user, { sourceLabel: taxonomyMatch?.label || safeLabel || '' })
            .catch(err => console.error(`[newsletter] extraction error for ${email.id}:`, err.message));
        });
      }

      // Short-lived opportunities such as retail offers are source-backed
      // signals. A separate suggestion pass decides whether current context
      // makes them worth surfacing.
      try {
        const n = await extractOpportunitySignals(user, email, {
          sourceLabel: taxonomyMatch?.label || safeLabel || '',
        });
        if (n) console.log(`[email] opportunity signals: ${n} from "${email.subject}"`);
      } catch (err) {
        console.warn('[email] opportunity extraction failed:', err.message);
      }

      processed++;
      resolveProcessingFailure('gmail', email.id);
    } catch (err) {
      try { markRawGmailEmail(hub, user, email.id, 'retry'); } catch (_) {}
      recordProcessingFailure('gmail', email.id, err);
      console.error(`[email] classify error for message ${email.id}:`, err.message);
    }
  }

  console.log(`[email] done — ${processed} processed, ${moved} moved for ${user}`);

  // Run sent email pass with the same authenticated client to avoid token rotation issues
  const sent = await processSentEmails(user, gmail, lastCheckTs).catch(err => {
    console.error(`[email-sent] processSentEmails error (${user}):`, err.message);
    return { processed: 0 };
  });

  return {
    processed,
    moved,
    learned: learned.length,
    correctionsLearned: corrections.length,
    sentProcessed: sent.processed,
    promotionsAppraised: promotionResult.appraised,
    promotionCandidates: promotionResult.candidates,
    promotionSuggestions: promotionResult.suggestions,
    labelPollTopics,
  };
}

// ── Classify a sent email (Douglas is the sender; contact is the recipient) ────

async function classifySentEmail(email, contacts, projects, user = 'douglas') {
  const contactList = contacts.length
    ? contacts.map(c => `- ${c.name}${c.email ? ` <${c.email}>` : ''}`).join('\n')
    : '(none yet)';
  const projectList = projects.map(p => `- ${p.slug}: ${p.name}`).join('\n');

  const prompt = getSystemPrompt('email_classifier_sent', 'system', PROMPTS.email_classifier_sent)
    .replaceAll('[TO_NAME]', email.toName || '')
    .replaceAll('[TO_EMAIL]', email.toEmail || '')
    .replaceAll('[SUBJECT]', email.subject || '')
    .replaceAll('[BODY]', email.bodyText.slice(0, 1000))
    .replaceAll('[CONTACTS]', contactList)
    .replaceAll('[PROJECTS]', projectList);

  const knowledgeBlock = await buildKnowledgeBlock(
    user,
    `${email.subject || ''}. ${(email.bodyText || '').slice(0, 800)} (recipient: ${email.toName} ${email.toEmail})`
  );

  const modelId = getSystemModelId('email_classifier', 'system', 'google/gemini-2.5-pro-preview');
  return requestClassifierJson({
    prompt: prompt + knowledgeBlock,
    modelId,
    feature: 'email_classifier_sent',
    defaults: {
      recipient_contact_name: null,
      about_contact_name: null,
      project_slug: null,
      summary: '',
      fact: null,
      commitment_task: null,
      create_recipient: null,
    },
    label: 'Sent email classifier response',
  });
}

// ── Process sent emails ────────────────────────────────────────────────────────

async function processSentEmails(user, existingGmailClient, sinceTs) {
  const hub = db.hub();

  const contacts = hub.prepare('SELECT id, name, email FROM contacts WHERE user = ?').all(user);
  const projects = hub.prepare('SELECT slug, name FROM projects WHERE user = ? ORDER BY name').all(user);

  let emails;
  try {
    ({ emails } = await fetchSentEmails(user, existingGmailClient, sinceTs));
  } catch (err) {
    console.error(`[email-sent] Gmail fetch failed for ${user}:`, err.message);
    return { processed: 0 };
  }

  if (!emails.length) return { processed: 0 };
  console.log(`[email-sent] classifying ${emails.length} sent email(s) for ${user}`);

  let processed = 0;
  for (const email of emails) {
    try {
      captureRawGmailEmail(hub, user, email, { direction: 'sent' });
      const result = await classifySentEmail(email, contacts, projects, user);

      // Resolve the primary CRM contact: about_contact takes priority over recipient match
      let contactId = null;
      let matchedContact = null;

      const findContact = name => contacts.find(
        c => c.name.toLowerCase() === (name || '').toLowerCase()
      );

      if (result.about_contact_name) {
        const match = findContact(result.about_contact_name);
        if (match) { contactId = match.id; matchedContact = match; }
      }

      if (!contactId && result.recipient_contact_name) {
        const match = findContact(result.recipient_contact_name);
        if (match) { contactId = match.id; matchedContact = match; }
      }

      // Direct email address fallback
      if (!contactId) {
        const direct = contacts.find(c => c.email && normalizeEmail(c.email) === normalizeEmail(email.toEmail));
        if (direct) { contactId = direct.id; matchedContact = direct; }
      }

      // Contact creation is a legacy direct projection only.  In the normal
      // knowledge-first path the faithful sent email is raw evidence and
      // synthesis/review decides whether it establishes a durable identity.
      let recipientContactId = null;
      if (legacyDirectCrmWritesEnabled() && result.create_recipient && typeof result.create_recipient === 'object') {
        const cr = result.create_recipient;
        const newName = String(cr.name || email.toName || '').trim().slice(0, 200);
        const newEmail = normalizeEmail(cr.email || email.toEmail);
        if (newName) {
          // Check it doesn't already exist (avoid duplicates from concurrent runs)
          const existing = hub.prepare(
            'SELECT id FROM contacts WHERE user = ? AND (LOWER(name) = LOWER(?) OR (email IS NOT NULL AND LOWER(email) = LOWER(?)))'
          ).get(user, newName, newEmail);
          if (existing) {
            recipientContactId = existing.id;
            console.log(`[email-sent] recipient already in CRM: ${newName}`);
          } else {
            recipientContactId = uuid();
            hub.prepare(`
              INSERT INTO contacts (id, user, name, email, notes, aliases)
              VALUES (?, ?, ?, ?, ?, '[]')
            `).run(recipientContactId, user, newName, newEmail || null, cr.note || '');
            // Refresh the in-memory list so the slug fallback below can find them
            contacts.push({ id: recipientContactId, name: newName, email: newEmail || null });
            console.log(`[email-sent] created contact: ${newName} <${newEmail}>`);
          }
        }
      }

      // If about_contact is set, the fact attaches to them; the recipient (if newly created) gets a lighter note
      const primaryContactId = contactId || recipientContactId;
      const primaryContact = matchedContact || (recipientContactId ? contacts.find(c => c.id === recipientContactId) : null);

      const validSlug = projects.some(p => p.slug === result.project_slug) ? result.project_slug : null;

      recordGmailSemanticCompatibility(hub, user, email, result, {
        direction: 'sent',
        projectSlug: validSlug,
        contactId: primaryContactId,
      });

      if (legacyDirectCrmWritesEnabled() && primaryContactId && primaryContact && result.fact) {
        const factId = uuid();
        hub.prepare(`
          INSERT INTO crm_facts (id, user, contact_id, fact, status, source, project_slug)
          VALUES (?, ?, ?, ?, 'active', 'email_sent', ?)
        `).run(factId, user, primaryContactId, result.fact, validSlug);
        console.log(`[email-sent] CRM fact for ${primaryContact.name}: ${result.fact}`);
        appendContactVaultEntry(
          primaryContact.name,
          `[sent] ${email.subject} — ${result.fact}`,
          { factId, date: new Date(email.sentAt * 1000) }
        );
      }

      // If about_contact is a different person from the recipient, also note the interaction on the recipient
      if (legacyDirectCrmWritesEnabled() && recipientContactId && contactId && recipientContactId !== contactId && result.fact) {
        const recipientContact = contacts.find(c => c.id === recipientContactId);
        if (recipientContact) {
          const factId = uuid();
          const recipientFact = `Douglas contacted them regarding ${result.about_contact_name} — ${result.summary}`;
          hub.prepare(`
            INSERT INTO crm_facts (id, user, contact_id, fact, status, source, project_slug)
            VALUES (?, ?, ?, ?, 'active', 'email_sent', ?)
          `).run(factId, user, recipientContactId, recipientFact, validSlug);
          console.log(`[email-sent] CRM fact for recipient ${recipientContact.name}: ${recipientFact}`);
        }
      }

      if (legacyDirectCrmWritesEnabled() && result.commitment_task) {
        createTask(user, {
          title: result.commitment_task,
          notes: `Committed to in email to ${email.toName || email.toEmail} — ${email.subject}\n${result.summary}`,
          source: 'email_sent',
          sourceId: email.id,
          contactId: primaryContactId || null,
          projectSlug: validSlug || null,
        }).catch(err => console.warn('[tasks] sent-email task create failed:', err.message));
      }

      // Inject into project context — prefer about_contact slug, then project slug, then recipient slug
      const aboutSlug = result.about_contact_name
        ? result.about_contact_name.toLowerCase().replace(/\s+/g, '-')
        : null;
      const targetSlug = validSlug || aboutSlug
        || (result.recipient_contact_name ? result.recipient_contact_name.toLowerCase().replace(/\s+/g, '-') : null);
      if (legacyDirectCrmWritesEnabled() && targetSlug) {
        const project = hub.prepare('SELECT id FROM projects WHERE user = ? AND slug = ?').get(user, targetSlug);
        if (project) {
          const dateStr = new Date(email.sentAt * 1000).toLocaleDateString('en-GB', {
            day: 'numeric', month: 'short', year: 'numeric',
          });
          hub.prepare(`
            INSERT INTO messages (id, project_id, role, content, user, model, ts)
            VALUES (?, ?, 'assistant', ?, ?, 'email', ?)
          `).run(uuid(), project.id, [
            `📤 *Email sent — ${dateStr}*`,
            `**To:** ${email.toName || email.toEmail}`,
            `**Subject:** ${email.subject}`,
            result.summary,
          ].join('\n'), user, email.sentAt);
          console.log(`[email-sent] added to project /${targetSlug}: "${email.subject}"`);
        }
      }

      processed++;
      resolveProcessingFailure('gmail_sent', email.id);
    } catch (err) {
      try { markRawGmailEmail(hub, user, email.id, 'retry'); } catch (_) {}
      recordProcessingFailure('gmail_sent', email.id, err);
      console.error(`[email-sent] classify error for message ${email.id}:`, err.message);
    }
  }

  console.log(`[email-sent] done — ${processed} processed for ${user}`);
  return { processed };
}

module.exports = {
  appraisePromotionEmails,
  classifyEmail,
  pollFiledLabels,
  processNewEmails,
  processSentEmails,
  _test: {
    gmailRawMetadata,
    captureRawGmailEmail,
    markRawGmailEmail,
    recordGmailSemanticCompatibility,
    retryPendingGmailLabels,
  },
};
