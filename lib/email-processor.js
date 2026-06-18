const fetch = require('./fetch');
const db = require('./db');
const { uuid } = require('./id');
const { parseModelObject } = require('./model-response');
const { recordProcessingFailure, resolveProcessingFailure } = require('./processing-failures');
const { fetchNewEmails, fetchSentEmails, moveToLabel } = require('./gmail');
const { writeNote } = require('./obsidian-vault');
const { logUsageFromResponse } = require('./openrouter-usage');
const { TASK_CODES, openRouterHeaders } = require('./openrouter-attribution');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');
const { isApprovedExternalEmail, extractTopicsFromEmail } = require('./newsletter-pipeline');
const {
  getEnabledEmailLabels,
  learnFromPendingEmailLabels,
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

  const started = Date.now();
  const modelId = getSystemModelId('email_classifier', 'system', 'google/gemini-2.5-pro-preview');
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.EMAIL_CLASSIFICATION),
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });

  if (!resp.ok) throw new Error(`OpenRouter ${resp.status}`);
  const data = await resp.json();
  logUsageFromResponse({
    user: 'system',
    feature: 'email-classifier',
    modelKey: 'email-classifier',
    fallbackModelId: modelId,
    data,
    taskCode: TASK_CODES.EMAIL_CLASSIFICATION,
    durationMs: Date.now() - started,
  });
  return parseModelObject(data.choices?.[0]?.message?.content, {
    contact_name: null,
    project_slug: null,
    summary: '',
    fact: null,
    move_label: null,
    action_task: null,
  }, 'Email classifier response');
}

// ── Main: fetch + classify + label + store ────────────────────────────────────

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

  const learned = await learnFromPendingEmailLabels(user, gmail);
  for (const item of learned) {
    console.log(`[email] learned ${item.fromEmail} → "${item.label}" from manual label`);
  }

  if (!emails.length && process.env.EMAIL_POLL_DEBUG === '1') {
    console.log(`[email] no new received emails for ${user}`);
  }

  if (emails.length) console.log(`[email] classifying ${emails.length} new email(s) for ${user}`);

  let processed = 0;
  let moved = 0;

  for (const email of emails) {
    try {
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
        hub.prepare(`INSERT OR IGNORE INTO email_summaries
          (id, user, gmail_message_id, subject, from_name, from_email, received_at, summary, project_slug)
          VALUES (?, ?, ?, ?, ?, ?, ?, '', '__skip')`)
          .run(uuid(), user, email.id, email.subject, email.fromName, email.fromEmail, email.receivedAt);
        console.log(`[email] skip: ${email.subject}`);
        processed++;
        continue;
      }
      if (emailCat === 'silent') {
        hub.prepare(`INSERT OR IGNORE INTO email_summaries
          (id, user, gmail_message_id, subject, from_name, from_email, received_at, summary, project_slug)
          VALUES (?, ?, ?, ?, ?, ?, ?, '', '__system')`)
          .run(uuid(), user, email.id, email.subject, email.fromName, email.fromEmail, email.receivedAt);
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

      // Store email summary
      hub.prepare(`
        INSERT OR IGNORE INTO email_summaries
          (id, user, gmail_message_id, subject, from_name, from_email,
           received_at, summary, project_slug, contact_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuid(), user, email.id, email.subject, email.fromName, email.fromEmail,
        email.receivedAt, result.summary, validSlug, contactId
      );

      // Store CRM fact if we matched a contact and have something useful
      if (contactId && matchedContact && result.fact) {
        const factId = uuid();
        hub.prepare(`
          INSERT INTO crm_facts (id, user, contact_id, fact, status, source)
          VALUES (?, ?, ?, ?, 'active', 'email')
        `).run(factId, user, contactId, result.fact);
        console.log(`[email] CRM fact added for ${result.contact_name}: ${result.fact}`);
        appendContactVaultEntry(
          matchedContact.name,
          `[email] ${email.subject} — ${result.fact}`,
          { factId, date: new Date(email.receivedAt * 1000) }
        );
      }

      // Create Google Task if email requires action
      if (result.action_task) {
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

      if (targetSlug) {
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

      // Move only to an enabled canonical label. Deterministic admin rules win,
      // followed by an exact allowed label returned by the classifier.
      const safeLabel = taxonomyMatch?.label
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
        try {
          await moveToLabel(gmail, user, email.id, safeLabel, emailLabels);
          moved++;
        } catch (labelErr) {
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

      processed++;
      resolveProcessingFailure('gmail', email.id);
    } catch (err) {
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

  return { processed, moved, learned: learned.length, sentProcessed: sent.processed };
}

// ── Classify a sent email (Douglas is the sender; contact is the recipient) ────

async function classifySentEmail(email, contacts, projects, user = 'douglas') {
  const contactList = contacts.length
    ? contacts.map(c => `- ${c.name}${c.email ? ` <${c.email}>` : ''}`).join('\n')
    : '(none yet)';
  const projectList = projects.map(p => `- ${p.slug}: ${p.name}`).join('\n');

  const prompt = `You are analysing an email that Douglas McLellan SENT (he is the author, not the recipient).

Email sent by Douglas:
To: ${email.toName} <${email.toEmail}>
Subject: ${email.subject}
Body: ${email.bodyText.slice(0, 1000)}

Known contacts:
${contactList}

Known projects/categories:
${projectList}

Return ONLY valid JSON:
{
  "recipient_contact_name": "exact name from the known contacts list if the TO address matches a known contact by name or email — otherwise null",
  "about_contact_name": "exact name from the known contacts list if this email is ON BEHALF OF or ABOUT a known contact who is NOT the recipient (e.g. emailing a council about a family member, emailing a solicitor about a client) — otherwise null. This takes priority over recipient_contact_name for CRM fact recording.",
  "project_slug": "exact slug from the projects list if clearly relevant — otherwise null",
  "summary": "one plain-English sentence describing what Douglas communicated in this email",
  "fact": "a CRM fact in third person describing what Douglas communicated, sent, or committed to — attach this to about_contact_name if set, otherwise recipient_contact_name. E.g. 'Douglas emailed Fife Council on his behalf regarding care assessment — June 2026'. Null only if genuinely nothing useful.",
  "commitment_task": "if Douglas made a promise or said he would do something, a short imperative task title (e.g. 'Send invoice to Tom by Friday') — otherwise null",
  "create_recipient": "null if the recipient is transactional (customer service, automated system, one-off query to a large organisation where no ongoing relationship exists). Otherwise an object: { \"name\": \"recipient display name\", \"email\": \"their email\", \"note\": \"one sentence on who they are and why they matter\" } — use this for real people Douglas is building a relationship with, or organisations he will deal with repeatedly (solicitors, councils handling a case, suppliers, etc.)"
}

Rules:
- about_contact_name is the primary CRM target when set — it means the email concerns a known contact even though they aren't the recipient
- recipient_contact_name is only used when about_contact_name is null
- fact must be directly evidenced by the subject or body — do not invent details
- commitment_task only when Douglas explicitly stated he would do something
- create_recipient: set for people and ongoing-relationship orgs; null for Ikea CS, automated confirmations, subscription services, one-off queries
- project_slug: only when clearly relevant`;

  const knowledgeBlock = await buildKnowledgeBlock(
    user,
    `${email.subject || ''}. ${(email.bodyText || '').slice(0, 800)} (recipient: ${email.toName} ${email.toEmail})`
  );

  const started = Date.now();
  const modelId = getSystemModelId('email_classifier', 'system', 'google/gemini-2.5-pro-preview');
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.EMAIL_CLASSIFICATION),
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt + knowledgeBlock }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });

  if (!resp.ok) throw new Error(`OpenRouter ${resp.status}`);
  const data = await resp.json();
  logUsageFromResponse({
    user: 'system',
    feature: 'email-classifier-sent',
    modelKey: 'email-classifier',
    fallbackModelId: modelId,
    data,
    taskCode: TASK_CODES.EMAIL_CLASSIFICATION,
    durationMs: Date.now() - started,
  });
  return parseModelObject(data.choices?.[0]?.message?.content, {
    recipient_contact_name: null,
    about_contact_name: null,
    project_slug: null,
    summary: '',
    fact: null,
    commitment_task: null,
    create_recipient: null,
  }, 'Sent email classifier response');
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

      // Create new contact for recipient if the LLM says it's worth it
      let recipientContactId = null;
      if (result.create_recipient && typeof result.create_recipient === 'object') {
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

      hub.prepare(`
        INSERT OR IGNORE INTO email_summaries
          (id, user, gmail_message_id, subject, from_name, from_email,
           received_at, summary, project_slug, contact_id, direction)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent')
      `).run(
        uuid(), user, email.id, email.subject, email.toName, email.toEmail,
        email.sentAt, result.summary, validSlug, primaryContactId
      );

      if (primaryContactId && primaryContact && result.fact) {
        const factId = uuid();
        hub.prepare(`
          INSERT INTO crm_facts (id, user, contact_id, fact, status, source)
          VALUES (?, ?, ?, ?, 'active', 'email_sent')
        `).run(factId, user, primaryContactId, result.fact);
        console.log(`[email-sent] CRM fact for ${primaryContact.name}: ${result.fact}`);
        appendContactVaultEntry(
          primaryContact.name,
          `[sent] ${email.subject} — ${result.fact}`,
          { factId, date: new Date(email.sentAt * 1000) }
        );
      }

      // If about_contact is a different person from the recipient, also note the interaction on the recipient
      if (recipientContactId && contactId && recipientContactId !== contactId && result.fact) {
        const recipientContact = contacts.find(c => c.id === recipientContactId);
        if (recipientContact) {
          const factId = uuid();
          const recipientFact = `Douglas contacted them regarding ${result.about_contact_name} — ${result.summary}`;
          hub.prepare(`
            INSERT INTO crm_facts (id, user, contact_id, fact, status, source)
            VALUES (?, ?, ?, ?, 'active', 'email_sent')
          `).run(factId, user, recipientContactId, recipientFact);
          console.log(`[email-sent] CRM fact for recipient ${recipientContact.name}: ${recipientFact}`);
        }
      }

      if (result.commitment_task) {
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
      if (targetSlug) {
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
    } catch (err) {
      console.error(`[email-sent] classify error for message ${email.id}:`, err.message);
    }
  }

  console.log(`[email-sent] done — ${processed} processed for ${user}`);
  return { processed };
}

module.exports = { classifyEmail, processNewEmails, processSentEmails };
