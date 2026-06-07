'use strict';

const fetch = require('node-fetch');
const db = require('./db');
const { uuid } = require('./id');
const { classifyEmail } = require('./email-processor');
const { getMessage, listMessages, updateMessage } = require('./agentmail');
const { isNewsletter, extractTopicsFromEmail } = require('./newsletter-pipeline');
const { getEnabledEmailLabels, matchEmailTaxonomy } = require('./email-taxonomy');
const { getSystemModelId } = require('./settings');
const { logUsageFromResponse } = require('./openrouter-usage');
const { writeNote } = require('./obsidian-vault');

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
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function messageBody(message) {
  const extracted = String(message.extracted_text || '').trim();
  const full = String(message.text || '').trim()
    || stripHtml(message.extracted_html || message.html || '').trim();
  // Only use extracted_text if it's substantive (>100 chars); otherwise prefer full text
  // which includes forwarded content that AgentMail's extractor strips out
  const body = (extracted.length > 100 ? extracted : null) || full || extracted || message.preview || '';
  return String(body).slice(0, 12000);
}

async function extractWorkIntelligence(email, contacts, projects, companyProjects = []) {
  const contactNames = contacts.map(contact => contact.name).join(', ') || '(none)';
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
- Return an empty people array when no person-specific fact is evidenced.`;

  const modelId = getSystemModelId('email_classifier', 'system', 'google/gemini-2.5-pro-preview');
  const started = Date.now();
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://dchat.mclellan.scot',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });
  if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
  const data = await response.json();
  logUsageFromResponse({
    user: 'system',
    feature: 'agentmail-work-extractor',
    modelKey: 'agentmail-work-extractor',
    fallbackModelId: modelId,
    data,
    durationMs: Date.now() - started,
  });
  return JSON.parse(data.choices[0].message.content);
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

function storePeopleFacts(hub, user, email, people, source = 'agentmail', factType = 'fact') {
  const sourceLabel = source === 'gmail' ? 'Gmail' : 'AgentMail';
  const validTypes = new Set(['fact', 'decision', 'action', 'note']);
  const resolved = (people || [])
    .filter(item => item?.name && item?.fact)
    .map(item => ({ item, contact: resolveContact(hub, user, item.name) }))
    .filter(row => row.contact);

  for (const { item, contact } of resolved) {
    const linkedContacts = resolved
      .filter(row => row.contact.id !== contact.id)
      .map(row => row.contact.id);
    const itemType = item.role === 'action_owner'
      ? 'action'
      : validTypes.has(factType) ? factType : 'fact';
    const duplicate = hub.prepare(`
      SELECT 1 FROM crm_facts
      WHERE user = ? AND contact_id = ? AND fact = ? AND source = ?
    `).get(user, contact.id, item.fact, source);
    if (duplicate) continue;
    hub.prepare(`
      INSERT INTO crm_facts
        (id, user, contact_id, fact, status, source, linked_contacts, fact_type)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(uuid(), user, contact.id, item.fact, source, JSON.stringify(linkedContacts), itemType);
    try {
      const date = new Date(email.receivedAt * 1000).toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
      });
      writeNote({
        notePath: `People/${contact.name}.md`,
        content: `\n- ${date}: [${sourceLabel}] ${email.subject} — ${item.fact}`,
        mode: 'append',
      });
    } catch (err) {
      console.warn(`[agentmail] vault write failed for ${contact.name}:`, err.message);
    }
  }
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

async function processAgentMail(user = 'douglas') {
  const hub = db.hub();
  const listed = await fetchReceivedMessages();
  if (!listed.length) return { processed: 0, newsletters: 0, peopleFacts: 0, pending: 0 };

  const contacts = hub.prepare('SELECT id, name FROM contacts WHERE user = ? ORDER BY name').all(user);
  const projects = hub.prepare('SELECT slug, name FROM projects WHERE user = ? ORDER BY name').all(user);
  const emailLabels = getEnabledEmailLabels(user);

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
        receivedAt: Math.floor(new Date(full.timestamp || full.created_at).getTime() / 1000),
        bodyText: messageBody(full),
      };
      const taxonomyMatch = matchEmailTaxonomy(user, email);
      const newsletter = isNewsletter(email);
      const hasContent = email.bodyText.trim().length >= 5;
      const classification = hasContent
        ? await classifyEmail(email, contacts, projects, emailLabels)
        : { summary: '', project_slug: null, move_label: null };
      const work = hasContent && !newsletter
        ? await extractWorkIntelligence(email, contacts, projects, companyProjects)
        : { is_work_content: false, summary: '', project_slug: null, people: [] };

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
      if (work.is_work_content) storePeopleFacts(hub, user, email, work.people, 'agentmail', work.fact_type);
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
           received_at, summary, project_slug)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuid(), user, `agentmail:${externalId}`, email.subject, email.fromName,
        email.fromEmail, email.receivedAt, work.summary || classification.summary || '',
        validProject
      );

      if (newsletter) {
        const topicIds = await extractTopicsFromEmail(email, user, { sourceLabel: email.fromEmail });
        if (topicIds.length) newsletters++;
      }
      if (!canonicalLabel && !newsletter && !work.is_work_content) pending++;

      const agentLabels = [
        'hub-processed',
        validProject ? `project:${validProject}` : null,
        newsletter ? 'hub:newsletter' : null,
        work.is_work_content ? 'hub:work' : null,
        !canonicalLabel && !newsletter && !work.is_work_content ? 'hub:review' : null,
      ].filter(Boolean);
      await updateMessage(externalId, { addLabels: agentLabels });
      processed++;
    } catch (err) {
      console.error(`[agentmail] failed ${externalId}:`, err.message);
    }
  }

  return { processed, newsletters, peopleFacts, pending };
}

module.exports = {
  extractWorkIntelligence,
  processAgentMail,
  storePeopleFacts,
};
