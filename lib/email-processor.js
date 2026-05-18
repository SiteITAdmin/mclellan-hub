const fetch = require('node-fetch');
const db = require('./db');
const { uuid } = require('./id');
const { fetchNewEmails, moveToLabel } = require('./gmail');
const { writeNote } = require('./obsidian-vault');

const ALERT_EMAIL_RE = /\b(security alert|new login|new sign-?in|verification code|suspicious|password reset|2fa|two-factor|authenticator)\b/i;
const AUTOMATED_SENDER_RE = /\b(no-?reply|notifications?|security|accounts?|support|automated|mailer|noreply)\b/i;

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

// ── Classify a single email against contacts + projects ───────────────────────

async function classifyEmail(email, contacts, projects) {
  const contactList = contacts.length
    ? contacts.map(c => `- ${c.name}${c.email ? ` <${c.email}>` : ''}`).join('\n')
    : '(none yet)';
  const projectList = projects.map(p => `- ${p.slug}: ${p.name}`).join('\n');

  const prompt = `You are classifying an email for a personal CRM and project system.

Email:
From: ${email.fromName} <${email.fromEmail}>
Subject: ${email.subject}
Body: ${email.bodyText.slice(0, 1000)}

Known contacts:
${contactList}

Known projects/categories:
${projectList}

Return ONLY valid JSON:
{
  "contact_name": "exact name from the contacts list if this email is FROM them or the subject line is explicitly about them — otherwise null",
  "project_slug": "exact slug from the projects list if clearly relevant — otherwise null",
  "summary": "one plain-English sentence: what is this email about?",
  "fact": "if contact_name is set, a CRM fact directly evidenced by this email's subject or body (e.g. 'Sent invoice for £450 — April 2026') — otherwise null",
  "move_label": "Gmail label name to file this under — use contact_name if set, else the project name, else null. Only set if confident."
}

Rules:
- contact_name MUST match the SENDER (From: name or email address). A contact whose name appears in the email body or subject — but who did not send the email — must be null. The recipient's own name in a greeting ("Hi Douglas") is never grounds for a contact match.
- Do NOT infer a contact from shared surname, employer, or topic alone (e.g. an email about a colleague's pension is not FROM that colleague)
- Only set project_slug if the email clearly belongs to that category — when in doubt, leave null
- The fact must be directly stated or clearly implied by the email content — do not infer or invent details not present in the email
- move_label should be the display name (e.g. "Nate" not a slug) — use existing contact/project names
- summary must be factual and specific
- If uncertain about ANY field, set it to null — do not guess`;

  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://dchat.mclellan.scot',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });

  if (!resp.ok) throw new Error(`OpenRouter ${resp.status}`);
  const data = await resp.json();
  return JSON.parse(data.choices[0].message.content);
}

// ── Main: fetch + classify + label + store ────────────────────────────────────

async function processNewEmails(user) {
  const hub = db.hub();

  // Load contacts — also try to pull any stored email addresses from crm_context
  const contacts = hub.prepare('SELECT id, name FROM contacts WHERE user = ?').all(user);
  const ctxEmails = hub.prepare(
    "SELECT key, value FROM crm_context WHERE user = ? AND key LIKE '%_email'"
  ).all(user);
  const emailByKey = {};
  for (const r of ctxEmails) emailByKey[r.key] = r.value;

  const enrichedContacts = contacts.map(c => ({
    ...c,
    email: emailByKey[`${c.name.toLowerCase().replace(/\s+/g, '_')}_email`] || null,
  }));

  // Load projects for category matching
  const projects = hub.prepare('SELECT slug, name FROM projects WHERE user = ? ORDER BY name').all(user);

  // Fetch new emails (also returns the authenticated gmail client for reuse)
  let emails, gmail;
  try {
    ({ emails, gmail } = await fetchNewEmails(user));
  } catch (err) {
    console.error(`[email] Gmail fetch failed for ${user}:`, err.message);
    return { processed: 0, moved: 0, error: err.message };
  }

  if (!emails.length) {
    console.log(`[email] no new emails for ${user}`);
    return { processed: 0, moved: 0 };
  }

  console.log(`[email] classifying ${emails.length} new email(s) for ${user}`);

  let processed = 0;
  let moved = 0;

  for (const email of emails) {
    try {
      const result = await classifyEmail(email, enrichedContacts, projects);

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
        hub.prepare(`
          INSERT INTO crm_facts (id, user, contact_id, fact, status, source)
          VALUES (?, ?, ?, ?, 'active', 'email')
        `).run(uuid(), user, contactId, result.fact);
        console.log(`[email] CRM fact added for ${result.contact_name}: ${result.fact}`);
        // Mirror to vault People note
        const d = new Date(email.receivedAt * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        try {
          writeNote({ notePath: `People/${result.contact_name}.md`, content: `\n- ${d}: [email] ${email.subject} — ${result.fact}`, mode: 'append' });
        } catch (err) {
          console.warn(`[email] vault write failed for People/${result.contact_name}.md:`, err.message);
        }
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

      // Move to Gmail label — only use validated contact/project, never raw LLM output
      const safeLabel = contactId
        ? (matchedContact?.name || result.contact_name)
        : validSlug
          ? (projects.find(p => p.slug === validSlug)?.name || null)
          : null;

      if (safeLabel && gmail) {
        try {
          await moveToLabel(gmail, user, email.id, safeLabel);
          moved++;
        } catch (labelErr) {
          console.error(`[email] label error for message ${email.id}:`, labelErr.message);
        }
      }

      processed++;
    } catch (err) {
      console.error(`[email] classify error for message ${email.id}:`, err.message);
    }
  }

  console.log(`[email] done — ${processed} processed, ${moved} moved for ${user}`);
  return { processed, moved };
}

module.exports = { processNewEmails };
