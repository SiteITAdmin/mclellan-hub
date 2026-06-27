'use strict';

const fetch = require('./fetch');
const db = require('./db');
const { uuid } = require('./id');
const { classifyEmail } = require('./email-processor');
const { getMessage, listMessages, updateMessage } = require('./agentmail');
const { isApprovedExternalEmail, extractTopicsFromEmail } = require('./newsletter-pipeline');
const { getEnabledEmailLabels, matchEmailTaxonomy } = require('./email-taxonomy');
const { getSystemModelId } = require('./settings');
const { logUsageFromResponse } = require('./openrouter-usage');
const { TASK_CODES, openRouterHeaders } = require('./openrouter-attribution');
const { appendContactVaultEntry } = require('./crm');
const { createTask } = require('./google-tasks');
const { parseModelObject } = require('./model-response');
const { recordProcessingFailure, resolveProcessingFailure } = require('./processing-failures');

function normalizeActionTasks(work) {
  const raw = Array.isArray(work?.action_tasks)
    ? work.action_tasks
    : work?.action_task
      ? [{ title: work.action_task }]
      : [];
  const seen = new Set();
  return raw
    .map(item => typeof item === 'string' ? { title: item } : item)
    .filter(item => item && typeof item.title === 'string')
    .map(item => ({
      title: item.title.trim().slice(0, 240),
      evidence: String(item.evidence || '').trim().slice(0, 800),
    }))
    .filter(item => {
      const key = item.title.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

function actionTaskKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'action';
}

function rootSubject(subject) {
  let cleaned = String(subject || '(no subject)').trim();
  let previous;
  do {
    previous = cleaned;
    cleaned = cleaned.replace(/^\s*(re|fw|fwd)\s*:\s*/i, '').trim();
  } while (cleaned && cleaned !== previous);
  return cleaned || '(no subject)';
}

function hasMailSubjectPrefix(subject) {
  return /^\s*(re|fw|fwd)\s*:/i.test(String(subject || ''));
}

function followUpSummary(fact, fallbackSubject) {
  const sentence = String(fact || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)[0]
    .trim()
    .replace(/[.!?]+$/g, '');
  const base = sentence || rootSubject(fallbackSubject);
  return base.length > 92 ? `${base.slice(0, 89).trim()}...` : base;
}

function followUpTaskTitle(person, subject) {
  const name = String(person?.name || '').trim() || 'owner';
  return `Follow up with ${name}: ${followUpSummary(person?.fact, subject)}`;
}

function followUpTaskSourceId(email, person) {
  const threadPart = email.threadId && !hasMailSubjectPrefix(email.subject)
    ? `thread:${actionTaskKey(email.threadId)}`
    : `subject:${actionTaskKey(rootSubject(email.subject))}`;
  return `agentmail:owner:${threadPart}:${actionTaskKey(person?.name)}`;
}

function agentmailFactLinks() {
  // Names sharing a digest or forwarded thread are not necessarily related.
  return '[]';
}

function parseSender(from) {
  const raw = String(from || '').trim();
  const match = raw.match(/^(.*?)\s*<([^>]+)>$/);
  return {
    fromName: (match?.[1] || raw).trim().replace(/^["']|["']$/g, ''),
    fromEmail: (match?.[2] || raw).trim().toLowerCase(),
  };
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function messageBody(message) {
  const full = String(message.text || '').trim()
    || stripHtml(message.extracted_html || message.html || '').trim();
  const extracted = String(message.extracted_text || '').trim();
  // Prefer full text — it includes forwarded chains that AgentMail's extractor strips out
  const body = full || extracted || message.preview || '';
  return String(body).slice(0, 500000);
}

async function extractWorkIntelligence(email, contacts, projects, companyProjects = [], wrongFacts = []) {
  const { formatLearnedTaskRules } = require('./task-learning');
  const contactNames = contacts
    .map(contact => `${contact.name}${contact.email ? ` <${contact.email}>` : ''}`)
    .join(', ') || '(none)';
  const projectRows = projects.map(project => `${project.slug}: ${project.name}`).join('\n') || '(none)';
  const companyRows = companyProjects.length
    ? companyProjects.map(cp => `${cp.company_name} → ${cp.project_slug}`).join('\n')
    : '(none)';
  const prompt = `Extract work intelligence from this inbound or forwarded email.

From: ${email.fromName} <${email.fromEmail}>
Subject: ${email.subject}
Body:
${email.bodyText.slice(0, 8000)}

Known people: ${contactNames}
Known projects:
${projectRows}
Companies linked to projects (use sender domain/name to infer project_slug):
${companyRows}

Return only JSON:
{
  "is_work_content": true,
  "summary": "one factual sentence",
  "project_slug": "exact known slug or null",
  "fact_type": "fact | decision | action | note",
  "action_tasks": [
    {
      "title": "short imperative task title for an explicit action Douglas needs to take",
      "evidence": "brief source wording that proves this is outstanding"
    }
  ],
  "people": [
    {
      "name":"full name exactly stated",
      "fact":"specific fact or work item directly evidenced",
      "role":"subject | decision_maker | affected | action_owner"
    }
  ]
}

Rules:
- Set is_work_content false for newsletters, promotions, account alerts, or empty tests.
- Include people mentioned inside forwarded content, not merely the forwarding sender.
- Do not invent surnames, facts, employers, or projects.
- A fact must say what the person did, requested, owns, plans, or needs.
- Use decision when the email records an approval, rejection, or settled choice.
- Use action when the main intelligence is an unresolved task; otherwise use fact or note.
- Return an empty people array when no person-specific fact is evidenced.
- Only include someone in people if there is a direct, specific fact about them — not just a passive mention.
- action_tasks: include every distinct action Douglas must personally reply to, decide, arrange, investigate, review or follow up. Use an empty array for passive reading, FYI content, completed work, or mere recommendations.
- Digest and summary emails can contain several unrelated actions. Evaluate each item independently and do not collapse the whole digest into one generic task.${wrongFacts.length ? `

The following past extractions were marked WRONG by the user — do not repeat similar errors:
${wrongFacts.map(w => `- "${w.fact}" (about ${w.contact_name})`).join('\n')}` : ''}${formatLearnedTaskRules('douglas', 'agentmail')}`;

  const modelId = getSystemModelId('agentmail_extractor', 'system', 'google/gemini-3.1-pro-preview');
  const started = Date.now();
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.AGENTMAIL),
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
    timeout: 60_000,
  });
  if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
  const data = await response.json();
  logUsageFromResponse({
    user: 'system',
    feature: 'agentmail-work-extractor',
    modelKey: 'agentmail-work-extractor',
    fallbackModelId: modelId,
    data,
    taskCode: TASK_CODES.AGENTMAIL,
    durationMs: Date.now() - started,
  });
  const parsed = parseModelObject(data.choices?.[0]?.message?.content, {
    is_work_content: false,
    summary: '',
    project_slug: null,
    fact_type: 'fact',
    action_tasks: [],
    people: [],
  }, 'AgentMail work-extractor response');
  parsed.people = Array.isArray(parsed.people) ? parsed.people : [];
  parsed.action_tasks = normalizeActionTasks(parsed);
  return parsed;
}

function resolveContact(hub, user, name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return null;
  const contacts = hub.prepare('SELECT * FROM contacts WHERE user = ?').all(user);
  let contact = contacts.find(item => item.name.toLowerCase() === normalized);
  if (!contact) {
    contact = contacts.find(item => {
      try {
        return JSON.parse(item.aliases || '[]').some(alias => alias.toLowerCase() === normalized);
      } catch (_) {
        return false;
      }
    });
  }
  if (contact) return contact;
  const id = uuid();
  hub.prepare('INSERT INTO contacts (id, user, name) VALUES (?, ?, ?)').run(id, user, String(name).trim());
  return hub.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
}

function storePeopleFacts(hub, user, email, people, source = 'agentmail', factType = 'fact', projectSlug = null) {
  const sourceLabel = source === 'gmail' ? 'Gmail' : 'AgentMail';
  const validTypes = new Set(['fact', 'decision', 'action', 'note']);
  const resolved = (people || [])
    .filter(item => item?.name && item?.fact)
    .map(item => ({ item, contact: resolveContact(hub, user, item.name) }))
    .filter(row => row.contact);

  for (const { item, contact } of resolved) {
    const itemType = item.role === 'action_owner'
      ? 'action'
      : validTypes.has(factType) ? factType : 'fact';
    const duplicate = hub.prepare(`
      SELECT 1 FROM crm_facts
      WHERE user = ? AND contact_id = ? AND fact = ? AND source = ?
    `).get(user, contact.id, item.fact, source);
    if (duplicate) continue;
    const factId = uuid();
    hub.prepare(`
      INSERT INTO crm_facts
        (id, user, contact_id, fact, status, source, linked_contacts, fact_type, project_slug)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(factId, user, contact.id, item.fact, source, agentmailFactLinks(), itemType, projectSlug);
    appendContactVaultEntry(
      contact.name,
      `[${sourceLabel}] ${email.subject} — ${item.fact}`,
      { factId, date: new Date(email.receivedAt * 1000) }
    );
  }
  return resolved.map(r => r.contact.id);
}

function linkContactsToProject(hub, user, contactIds, projectSlug) {
  if (!contactIds.length || !projectSlug) return;
  const project = hub.prepare('SELECT id FROM projects WHERE user = ? AND slug = ?').get(user, projectSlug);
  if (!project) return;
  const stmt = hub.prepare('INSERT OR IGNORE INTO contact_projects (contact_id, project_id) VALUES (?, ?)');
  for (const id of contactIds) stmt.run(id, project.id);
}

async function fetchReceivedMessages() {
  const messages = [];
  let pageToken;
  do {
    const page = await listMessages({ limit: 100, pageToken });
    messages.push(...(page.messages || []).filter(message =>
      (message.labels || []).includes('received')
      && !(message.labels || []).includes('hub-processed')
    ));
    pageToken = page.next_page_token;
  } while (pageToken);
  return messages;
}

function domainMatchesCompany(fromEmail, companyName) {
  const domain = (fromEmail.split('@')[1] || '').replace(/\.[^.]+$/, '').toLowerCase();
  const words = companyName.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 2);
  return domain.length > 0 && words.some(word => domain.includes(word));
}

// Domains whose emails always bypass newsletter detection and always get work extraction.
// Set AGENTMAIL_WORK_DOMAINS=beaconhospital.ie,h3odigital.co.uk in .env to configure.
function isWorkSenderDomain(fromEmail) {
  const raw = (process.env.AGENTMAIL_WORK_DOMAINS || '').trim();
  if (!raw) return false;
  const host = (fromEmail || '').split('@')[1] || '';
  return raw.split(',').map(d => d.trim().toLowerCase()).some(d => host.toLowerCase().endsWith(d));
}

function isForcedWorkSender(fromEmail) {
  return String(fromEmail || '').trim().toLowerCase() === 'douglas.mclellan@beaconhospital.ie';
}

async function processAgentMail(user = 'douglas') {
  const hub = db.hub();
  const listed = await fetchReceivedMessages();
  if (!listed.length) return { processed: 0, newsletters: 0, peopleFacts: 0, pending: 0 };

  const contacts = hub.prepare('SELECT id, name, email FROM contacts WHERE user = ? ORDER BY name').all(user);
  const projects = hub.prepare('SELECT slug, name FROM projects WHERE user = ? ORDER BY name').all(user);
  const emailLabels = getEnabledEmailLabels(user);
  const wrongFacts = hub.prepare(`
    SELECT f.fact, c.name AS contact_name
    FROM crm_facts f JOIN contacts c ON c.id = f.contact_id
    WHERE f.user = ? AND f.status = 'wrong'
    ORDER BY f.updated_at DESC LIMIT 10
  `).all(user);

  // Companies linked to projects — used for deterministic domain matching and LLM context
  const companyProjects = hub.prepare(`
    SELECT co.name AS company_name, co.id AS company_id, p.slug AS project_slug
    FROM company_projects cp
    JOIN companies co ON co.id = cp.company_id
    JOIN projects p ON p.id = cp.project_id
    WHERE p.user = ?
  `).all(user);
  let processed = 0;
  let newsletters = 0;
  let peopleFacts = 0;
  let pending = 0;

  for (const listedMessage of listed) {
    const externalId = listedMessage.message_id;
    const exists = hub.prepare(`
      SELECT 1 FROM inbound_email_records
      WHERE user = ? AND source = 'agentmail' AND external_message_id = ?
    `).get(user, externalId);
    if (exists) {
      await updateMessage(externalId, { addLabels: ['hub-processed'] });
      continue;
    }

    try {
      const full = await getMessage(externalId);
      const sender = parseSender(full.from);
      const email = {
        id: `agentmail:${externalId}`,
        ...sender,
        subject: full.subject || '(no subject)',
        threadId: full.thread_id || null,
        receivedAt: Math.floor(new Date(full.timestamp || full.created_at).getTime() / 1000),
        bodyText: messageBody(full),
      };
      const senderContact = contacts.find(contact =>
        contact.email
        && contact.email.trim().toLowerCase() === String(email.fromEmail || '').trim().toLowerCase()
      );
      const taxonomyMatch = matchEmailTaxonomy(user, email);
      const trustedWork = isForcedWorkSender(email.fromEmail) || isWorkSenderDomain(email.fromEmail);
      const newsletter = !trustedWork && isApprovedExternalEmail(user, email, taxonomyMatch?.label || '');
      const hasContent = email.bodyText.trim().length >= 5;
      const classification = (hasContent
        ? await classifyEmail(email, contacts, projects, emailLabels, user, 'agentmail')
        : null) ?? { summary: '', project_slug: null, move_label: null };
      const work = (hasContent && (trustedWork || !newsletter)
        ? await extractWorkIntelligence(email, contacts, projects, companyProjects, wrongFacts)
        : null) ?? { is_work_content: false, summary: '', project_slug: null, people: [] };

      // Deterministic company→project match via sender domain
      const companyDomainMatch = companyProjects.find(cp => domainMatchesCompany(email.fromEmail, cp.company_name));
      const companyProjectSlug = companyDomainMatch?.project_slug || null;
      if (companyDomainMatch) console.log(`[agentmail] domain match: ${email.fromEmail} → ${companyDomainMatch.company_name} → ${companyProjectSlug}`);

      const validProject = companyProjectSlug
        || (projects.some(p => p.slug === work.project_slug) ? work.project_slug : null)
        || (projects.some(p => p.slug === classification.project_slug) ? classification.project_slug : null)
        || (work.is_work_content && projects.some(p => p.slug === 'beacon') ? 'beacon' : null);
      const canonicalLabel = taxonomyMatch?.label
        || (emailLabels.includes(classification.move_label) ? classification.move_label : null);

      const beforeFacts = hub.prepare(
        "SELECT COUNT(*) AS n FROM crm_facts WHERE user = ? AND source = 'agentmail'"
      ).get(user).n;
      // For trusted work senders, extract facts even if the model said is_work_content: false.
      // Forwarded daily summaries from work domains are genuine work intelligence.
      const hasPeople = (work.people || []).length > 0;
      const shouldExtract = work.is_work_content || (trustedWork && hasPeople);
      const resolvedContactIds = shouldExtract
        ? storePeopleFacts(hub, user, email, work.people, 'agentmail', work.fact_type, validProject)
        : [];
      if (resolvedContactIds.length && validProject) {
        linkContactsToProject(hub, user, resolvedContactIds, validProject);
      }

      // Create Google Tasks for action items
      if (shouldExtract) {
        // Primary: explicit actions Douglas needs to take personally.
        for (const action of normalizeActionTasks(work)) {
          await createTask(user, {
            title: action.title,
            notes: [
              `From: ${email.fromName || email.fromEmail} — ${email.subject}`,
              action.evidence,
              work.summary || '',
            ].filter(Boolean).join('\n'),
            source: 'agentmail',
            sourceId: `agentmail:action:${externalId}:${actionTaskKey(action.title)}`,
            projectSlug: validProject || null,
          });
        }

        // Secondary: one task per named action owner (someone else has an action Douglas needs to track)
        const actionOwners = (work.people || []).filter(p => p.role === 'action_owner');
        for (const person of actionOwners) {
          const personContact = resolvedContactIds.length
            ? hub.prepare('SELECT id FROM contacts WHERE user = ? AND name = ?').get(user, person.name)
            : null;
          await createTask(user, {
            title: followUpTaskTitle(person, email.subject),
            notes: `${person.fact}\n\nFrom: ${email.fromName || email.fromEmail} — ${email.subject}`,
            source: 'agentmail',
            sourceId: followUpTaskSourceId(email, person),
            contactId: personContact?.id || null,
            projectSlug: validProject || null,
          });
        }
      }

      const afterFacts = hub.prepare(
        "SELECT COUNT(*) AS n FROM crm_facts WHERE user = ? AND source = 'agentmail'"
      ).get(user).n;
      peopleFacts += afterFacts - beforeFacts;

      hub.prepare(`
        INSERT INTO inbound_email_records
          (id, user, source, external_message_id, thread_id, from_name, from_email,
           subject, received_at, summary, classification, project_slug, status, raw_metadata)
        VALUES (?, ?, 'agentmail', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuid(), user, externalId, full.thread_id || null, email.fromName, email.fromEmail,
        email.subject, email.receivedAt, work.summary || classification.summary || '',
        canonicalLabel, validProject,
        canonicalLabel || newsletter || work.is_work_content ? 'processed' : 'review',
        JSON.stringify({
          labels: full.labels || [],
          to: full.to || [],
          cc: full.cc || [],
          attachments: full.attachments || [],
        })
      );

      // Preserve compatibility with Hub search and digest surfaces.
      hub.prepare(`
        INSERT OR IGNORE INTO email_summaries
          (id, user, gmail_message_id, subject, from_name, from_email,
           received_at, summary, project_slug, contact_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuid(), user, `agentmail:${externalId}`, email.subject, email.fromName,
        email.fromEmail, email.receivedAt, work.summary || classification.summary || '',
        validProject, senderContact?.id || null
      );

      if (newsletter) {
        const topicIds = await extractTopicsFromEmail(email, user, { sourceLabel: email.fromEmail });
        if (topicIds.length) newsletters++;
      }
      if (!canonicalLabel && !newsletter && !shouldExtract) pending++;

      const agentLabels = [
        'hub-processed',
        validProject ? `project:${validProject}` : null,
        newsletter ? 'hub:newsletter' : null,
        shouldExtract ? 'hub:work' : null,
        !canonicalLabel && !newsletter && !shouldExtract ? 'hub:review' : null,
      ].filter(Boolean);
      await updateMessage(externalId, { addLabels: agentLabels });
      processed++;
      resolveProcessingFailure('agentmail', externalId);
    } catch (err) {
      recordProcessingFailure('agentmail', externalId, err);
      console.error(`[agentmail] failed ${externalId}:`, err.message);
    }
  }

  return { processed, newsletters, peopleFacts, pending };
}

module.exports = {
  actionTaskKey,
  agentmailFactLinks,
  extractWorkIntelligence,
  followUpTaskSourceId,
  followUpTaskTitle,
  hasMailSubjectPrefix,
  isForcedWorkSender,
  normalizeActionTasks,
  processAgentMail,
  rootSubject,
  storePeopleFacts,
};
