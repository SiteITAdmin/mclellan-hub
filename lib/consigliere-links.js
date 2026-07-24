'use strict';

// A problem in the daily brief is only actionable if Douglas can click straight
// to the screen where he fixes it. The model writes the prose; every URL is
// resolved here from the escalation payload, so a link can only exist when the
// record behind it exists. The model is never shown a URL and never invents one.

const DEFAULT_BASE = 'https://dchat.mclellan.scot';
const MAX_LINKS_PER_ITEM = 4;

function hubBaseUrl() {
  return String(process.env.HUB_PUBLIC_URL || process.env.HUB_URL || DEFAULT_BASE).trim().replace(/\/+$/, '');
}

function absolute(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${hubBaseUrl()}${path.startsWith('/') ? '' : '/'}${path}`;
}

// The screen that owns each quality board section.
const CRM_SECTION_ROUTES = {
  'crm:people': { label: 'CRM contacts', path: '/crm/contacts' },
  'crm:meeting_intake': { label: 'Meeting intake', path: '/crm/meeting-intake' },
  'crm:tasks': { label: 'Tasks', path: '/crm/tasks' },
  'crm:project_context': { label: 'Projects', path: '/crm/projects' },
};

// The screen that owns each capo's area. Keys are capo keys from hub-agent-roster.
const CAPO_ROUTES = {
  email: { label: 'CRM knowledge', path: '/crm/knowledge' },
  agentmail: { label: 'CRM knowledge', path: '/crm/knowledge' },
  crm: { label: 'CRM', path: '/crm' },
  knowledge: { label: 'CRM knowledge', path: '/crm/knowledge' },
  tasks: { label: 'Tasks', path: '/crm/tasks' },
  documents_projects: { label: 'Projects', path: '/crm/projects' },
  mycelium: { label: 'Connectivity', path: '/admin/connectivity' },
  reminders: { label: 'Reminders', path: '/crm/reminders' },
  flights: { label: 'Flights', path: '/flights' },
  linkedin_content: { label: 'LinkedIn queue', path: '/lin/queue' },
  briefings: { label: 'CRM', path: '/crm' },
  rss_watchlist: { label: 'Newsletter sources', path: '/newsletter' },
  wiki: { label: 'Wiki', path: 'https://wiki.mclellan.scot/' },
  model_governance: { label: 'Model settings', path: '/admin/models' },
  token_burn: { label: 'Token burn', path: '/token-burn' },
  system_report: { label: 'Hub logs', path: '/logs' },
  infrastructure: { label: 'Jobs', path: '/admin/jobs' },
};

function areaTarget(item = {}) {
  const kind = String(item.source_kind || '');
  const id = String(item.source_id || '').replace(/^(capo|underboss):/, '');
  if (CRM_SECTION_ROUTES[id]) return CRM_SECTION_ROUTES[id];
  if (CAPO_ROUTES[id]) return CAPO_ROUTES[id];
  if (kind === 'linkedin_post') return CAPO_ROUTES.linkedin_content;
  return null;
}

// The rows the project-context board flags: a source row pointing at a project
// slug that does not exist. Link the row that needs re-tagging, never the slug.
const SOURCE_ROW_PATHS = {
  crm_facts: id => `/crm/source/crm_fact/${encodeURIComponent(id)}`,
  google_tasks: id => `/crm/tasks/${encodeURIComponent(id)}`,
  meeting_intakes: id => `/crm/meeting-intake?intake=${encodeURIComponent(id)}`,
};

// Slugs reaching here can be stale (that is precisely what some checks flag), so
// a project link is only emitted when the project still exists. If the DB cannot
// be read, emit nothing rather than a link that 404s.
let slugCache = { user: null, at: 0, slugs: null };
function knownProjectSlugs(user = 'douglas') {
  const now = Date.now();
  if (slugCache.slugs && slugCache.user === user && now - slugCache.at < 60000) return slugCache.slugs;
  let slugs = null;
  try {
    const rows = require('./db').hub().prepare('SELECT slug FROM projects WHERE user = ?').all(user);
    slugs = new Set(rows.map(row => row.slug));
  } catch (_) {
    slugs = null;
  }
  slugCache = { user, at: now, slugs };
  return slugs;
}

function truncate(value, max = 56) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Link text goes into markdown, so brackets and pipes have to go.
function safeLabel(value, fallback = 'Open') {
  const text = truncate(value).replace(/[[\]()|]/g, '').trim();
  return text || fallback;
}

// `specific` marks a link to an actual record (as opposed to the area fallback);
// only those are safe to match against the prose the model wrote.
function addLink(out, seen, label, path, specific = true) {
  if (!path) return;
  const url = absolute(path);
  if (seen.has(url)) return;
  seen.add(url);
  out.push({ label: safeLabel(label), url, specific });
}

function lookupTitle(table, id) {
  try {
    const row = require('./db').hub().prepare(`SELECT title FROM ${table} WHERE id = ?`).get(id);
    return row?.title || '';
  } catch (_) {
    return '';
  }
}

// One clarification request (or the escalation itself) -> the records it names.
function recordLinks(record, out, seen, user) {
  if (!record || typeof record !== 'object') return;

  if (record.source && record.id && SOURCE_ROW_PATHS[record.source]) {
    const named = record.title
      || (record.source === 'google_tasks' && lookupTitle('google_tasks', record.id))
      || (record.source === 'meeting_intakes' && lookupTitle('meeting_intakes', record.id))
      || '';
    addLink(out, seen, named ? `Re-tag: ${named}` : `Re-tag ${String(record.source).replace(/_/g, ' ')} row`,
      SOURCE_ROW_PATHS[record.source](record.id));
    return;
  }

  if (record.intake_id) {
    addLink(out, seen, `Meeting: ${record.title || 'intake'}`,
      `/crm/meeting-intake?intake=${encodeURIComponent(record.intake_id)}`);
  }
  if (record.meeting_id) {
    addLink(out, seen, `Meeting: ${record.title || record.meeting_title || 'record'}`,
      `/crm/meeting/${encodeURIComponent(record.meeting_id)}`);
  }

  const contactIds = Array.isArray(record.contact_ids)
    ? record.contact_ids
    : (record.contact_id ? [record.contact_id] : []);
  const contactNames = Array.isArray(record.contacts) ? record.contacts : [];
  contactIds.filter(Boolean).forEach((id, index) => {
    addLink(out, seen, contactNames[index] || 'Contact', `/crm/contact/${encodeURIComponent(id)}`);
  });

  if (record.company_id) {
    addLink(out, seen, record.company || 'Company', `/crm/company/${encodeURIComponent(record.company_id)}`);
  }
  if (record.task_id) {
    addLink(out, seen, `Task: ${record.title || record.task || 'open'}`,
      `/crm/tasks/${encodeURIComponent(record.task_id)}`);
  }

  const slugs = Array.isArray(record.shared_projects)
    ? record.shared_projects
    : (record.project_slug ? [record.project_slug] : []);
  const known = slugs.length ? knownProjectSlugs(user) : null;
  slugs.filter(Boolean).forEach(slug => {
    if (!known || !known.has(slug)) return;
    addLink(out, seen, `Project: ${slug}`, `/crm/project/${encodeURIComponent(slug)}`);
  });
}

// Deep links first (the actual records), area link last as the always-there fallback.
function fixLinksForItem(item = {}, { max = MAX_LINKS_PER_ITEM, user = 'douglas' } = {}) {
  const out = [];
  const seen = new Set();
  for (const request of item.clarification_requests || []) recordLinks(request, out, seen, user);
  recordLinks(item, out, seen, user);
  const deep = out.slice(0, Math.max(0, max - 1));
  const area = areaTarget(item);
  if (area) addLink(deep, new Set(deep.map(l => l.url)), area.label, area.path, false);
  return deep.slice(0, max);
}

function renderLinksMarkdown(links = []) {
  if (!links.length) return '';
  return links.map(link => `[${link.label}](${link.url})`).join(' · ');
}

module.exports = {
  hubBaseUrl,
  absolute,
  areaTarget,
  fixLinksForItem,
  renderLinksMarkdown,
  CAPO_ROUTES,
  CRM_SECTION_ROUTES,
};
