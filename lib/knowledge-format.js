'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { briefingPeriodLabel, briefingProvenanceText, briefingTitle } = require('./newsletter-pipeline');

const ROOT = path.join(__dirname, '..');
const PUBLIC_ROOT = path.join(ROOT, 'public', 'knowledge');
const PRIVATE_ROOT = path.join(ROOT, 'data', 'knowledge');

const USER_NAMES = {
  douglas: 'Douglas McLellan',
  nakai: 'Nakai McLellan',
};

function userName(user) {
  return USER_NAMES[user] || user;
}

function baseUrl(user) {
  return user === 'nakai' ? 'https://nakai.mclellan.scot' : 'https://douglas.mclellan.scot';
}

function nowIso() {
  return new Date().toISOString();
}

function slugify(value, fallback = 'item') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

function yamlScalar(value) {
  const text = String(value || '');
  if (!text) return '""';
  return JSON.stringify(text);
}

function yamlList(values) {
  const clean = [...new Set((values || []).map(v => String(v || '').trim()).filter(Boolean))];
  return `[${clean.map(yamlScalar).join(', ')}]`;
}

function frontmatter(fields) {
  const lines = ['---'];
  lines.push(`type: ${yamlScalar(fields.type || 'knowledge')}`);
  lines.push(`title: ${yamlScalar(fields.title || 'Untitled')}`);
  if (fields.description) lines.push(`description: ${yamlScalar(fields.description)}`);
  if (fields.resource) lines.push(`resource: ${yamlScalar(fields.resource)}`);
  if (fields.source_id) lines.push(`source_id: ${yamlScalar(fields.source_id)}`);
  lines.push(`tags: ${yamlList(fields.tags || [])}`);
  lines.push(`timestamp: ${yamlScalar(fields.timestamp || nowIso())}`);
  if (fields.author) lines.push(`author: ${yamlScalar(fields.author)}`);
  if (fields.visibility) lines.push(`visibility: ${yamlScalar(fields.visibility)}`);
  lines.push('---');
  return lines.join('\n');
}

function bundleRoot(user, isPublic = true) {
  return path.join(isPublic ? PUBLIC_ROOT : PRIVATE_ROOT, user);
}

function safeRelative(relPath) {
  const clean = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('..')) throw new Error(`Unsafe knowledge path: ${relPath}`);
  return clean.endsWith('.md') ? clean : `${clean}.md`;
}

function writeFileEnsured(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeKnowledgeDocument({ user, public: isPublic = true, relPath, type, title, description, resource, sourceId, tags, timestamp, body }) {
  const root = bundleRoot(user, isPublic);
  const target = path.join(root, safeRelative(relPath));
  const content = `${frontmatter({
    type,
    title,
    description,
    resource,
    source_id: sourceId,
    tags,
    timestamp,
    author: userName(user),
    visibility: isPublic ? 'public' : 'private',
  })}\n\n${String(body || '').trim()}\n`;
  writeFileEnsured(target, content);
  writeBundleIndex(user, isPublic);
  return target;
}

function removeKnowledgeBySourceId({ user, public: isPublic = true, sourceId }) {
  if (!sourceId) return 0;
  const root = bundleRoot(user, isPublic);
  let removed = 0;
  for (const file of listMarkdownFiles(root)) {
    const content = fs.readFileSync(file, 'utf8');
    if (new RegExp(`^source_id:\\s*${yamlScalar(sourceId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(content)) {
      fs.unlinkSync(file);
      removed++;
    }
  }
  if (removed) writeBundleIndex(user, isPublic);
  return removed;
}

function readTitleFromMarkdown(content, fallback) {
  const fmTitle = String(content || '').match(/^title:\s*["']?(.+?)["']?\s*$/m);
  if (fmTitle) return fmTitle[1].replace(/^["']|["']$/g, '');
  const heading = String(content || '').match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : fallback;
}

function listMarkdownFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md') out.push(full);
    }
  }
  walk(root);
  return out.sort();
}

function writeBundleIndex(user, isPublic = true) {
  const root = bundleRoot(user, isPublic);
  fs.mkdirSync(root, { recursive: true });
  const files = listMarkdownFiles(root);
  const links = files.map(file => {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const title = readTitleFromMarkdown(fs.readFileSync(file, 'utf8'), rel);
    return `- [${title}](${rel})`;
  });
  const title = `${userName(user)} Knowledge Bundle`;
  const content = `${frontmatter({
    type: 'index',
    title,
    description: `Machine-readable knowledge bundle for ${userName(user)}.`,
    resource: isPublic ? `${baseUrl(user)}/knowledge/${user}/index.md` : '',
    tags: ['knowledge', 'okf', user],
    author: userName(user),
    visibility: isPublic ? 'public' : 'private',
  })}\n\n# ${title}\n\n${links.length ? links.join('\n') : 'No knowledge documents yet.'}\n`;
  writeFileEnsured(path.join(root, 'index.md'), content);
}

function rowsToObject(rows) {
  return (rows || []).reduce((acc, row) => {
    acc[row.section] = row.content;
    return acc;
  }, {});
}

function nakaiPublicExpertiseTags() {
  return [
    'internal-audit',
    'fintech',
    'financial-services',
    'payments',
    'financial-crime',
    'aml',
    'regulatory-intelligence',
    'risk',
    'audit',
    'block',
    'cash-app',
    'square',
    'afterpay',
    'clearpay',
    'bnpl',
    'eu-regulation',
    'uk-regulation',
  ];
}

function captureNakaiPublicBriefingSignal({ dateSlug, markdown }) {
  const text = String(markdown || '');
  const mentioned = [
    ['FCA', /\bFCA\b/i],
    ['Central Bank of Ireland', /Central Bank of Ireland/i],
    ['BNPL', /\bBNPL\b|Buy Now Pay Later|Deferred Payment Credit/i],
    ['Block', /\bBlock\b/i],
    ['Cash App', /Cash App/i],
    ['Square', /\bSquare\b/i],
    ['Afterpay/Clearpay', /Afterpay|Clearpay/i],
    ['financial crime', /financial crime|AML|anti-money-laundering/i],
    ['virtual assets', /virtual asset|stablecoin|wallet|bitcoin|crypto/i],
  ].filter(([, pattern]) => pattern.test(text)).map(([label]) => label);

  const body = [
    `# Nakai McLellan - Fintech Internal Audit Intelligence Signal (${dateSlug})`,
    '',
    'Nakai McLellan maintains a private daily intelligence briefing practice focused on fintech, payments, internal audit, risk, and regulatory developments affecting firms operating in the EU and UK financial-services environment.',
    '',
    'The underlying briefing content is private and is not published as a public page. This public knowledge artifact records only non-sensitive subject-matter signals so search engines and LLM retrieval systems can understand the public profile context.',
    '',
    '## Public Expertise Signals',
    '- Internal audit in fintech and regulated financial services',
    '- Payments, merchant acquiring, consumer finance, and BNPL risk',
    '- Financial crime, AML, scams, customer harm, and control monitoring',
    '- EU, UK, and Ireland regulatory intelligence for fintech operating models',
    '- Practical read-across from regulator publications to product, audit, and risk work',
    '',
    mentioned.length ? '## Topics Observed In Private Briefing Metadata' : null,
    ...(mentioned.length ? mentioned.map(item => `- ${item}`) : []),
    '',
    '## Canonical Profile',
    `- ${baseUrl('nakai')}/`,
  ].filter(Boolean).join('\n');

  return writeKnowledgeDocument({
    user: 'nakai',
    public: true,
    relPath: `briefing-signals/${dateSlug}.md`,
    type: 'expertise_signal',
    title: `Nakai McLellan - Fintech Internal Audit Intelligence Signal (${dateSlug})`,
    description: 'Public machine-readable signal connecting Nakai McLellan with fintech internal audit, payments risk, regulatory intelligence, and financial-services controls.',
    resource: `${baseUrl('nakai')}/`,
    sourceId: `nakai-public-briefing-signal:${dateSlug}`,
    tags: [...nakaiPublicExpertiseTags(), 'private-briefing-signal', 'nakai'],
    timestamp: nowIso(),
    body,
  });
}

function capturePortfolioAbout(user) {
  const pdb = db.portfolio(user);
  const profile = pdb.prepare('SELECT * FROM profile WHERE id = 1').get() || {};
  const cvRows = pdb.prepare('SELECT * FROM cv_context ORDER BY section').all();
  const cv = rowsToObject(cvRows);
  const experiences = pdb.prepare('SELECT * FROM experiences WHERE is_cv_context = 1 ORDER BY display_order ASC').all()
    .filter(exp => user !== 'douglas' || !String(exp.company || '').toLowerCase().includes('bank of scotland'));
  const skills = pdb.prepare("SELECT * FROM skills WHERE level != 'gap' ORDER BY CASE level WHEN 'strong' THEN 0 ELSE 1 END, display_order").all();

  const name = profile.full_name || userName(user);
  const role = cv.role_label || profile.current_title || '';
  const summary = cv.summary || profile.elevator_pitch || '';
  const tags = ['about', 'portfolio', user];
  if (user === 'douglas') tags.push('ai', 'microsoft-365', 'healthcare-it');
  if (user === 'nakai') tags.push(...nakaiPublicExpertiseTags());

  const body = [
    `# ${name}`,
    '',
    role,
    '',
    summary,
    '',
    '## Profile',
    profile.location ? `- Location: ${profile.location}` : null,
    profile.availability_status ? `- Availability: ${profile.availability_status}` : null,
    profile.remote_preference ? `- Work preference: ${profile.remote_preference}` : null,
    cv.linkedin_url ? `- LinkedIn: ${cv.linkedin_url}` : null,
    '',
    '## Selected Experience',
    ...(experiences.length ? experiences.map(exp => `- ${exp.role}, ${exp.company}${exp.start_date || exp.end_date ? ` (${exp.start_date || '?'} - ${exp.end_date || 'Present'})` : ''}${exp.description ? `: ${exp.description}` : ''}`) : ['- Experience available on request.']),
    '',
    '## Skills',
    ...(skills.length ? skills.slice(0, 30).map(skill => `- ${skill.name}${skill.category ? ` (${skill.category})` : ''}`) : ['- Skills available on request.']),
    '',
    '## Source',
    `Canonical profile: ${baseUrl(user)}/`,
  ].filter(line => line !== null && line !== undefined).join('\n');

  return writeKnowledgeDocument({
    user,
    public: true,
    relPath: 'about/me.md',
    type: 'person',
    title: name,
    description: summary || role || `Public profile for ${name}.`,
    resource: `${baseUrl(user)}/`,
    tags,
    timestamp: nowIso(),
    body,
  });
}

function captureLinkedInPost(user, postId) {
  const post = db.hub().prepare('SELECT * FROM linkedin_posts WHERE id = ? AND user = ?').get(postId, user);
  if (!post || post.status !== 'published') return null;
  const date = new Date((post.published_at || post.created_at || Math.floor(Date.now() / 1000)) * 1000).toISOString();
  const postText = (post.refined_draft || post.draft || '').trim();
  const research = String(post.research || '').trim();
  const slug = `${date.slice(0, 10)}-${slugify(post.topic, post.id)}`;
  const body = [
    `# ${post.topic}`,
    '',
    `Published: ${date.slice(0, 10)}`,
    post.content_type ? `Category: ${post.content_type}` : null,
    '',
    '## Post',
    '',
    postText,
    research ? '\n## Research\n' : null,
    research ? research.slice(0, 6000) : null,
  ].filter(Boolean).join('\n');

  return writeKnowledgeDocument({
    user,
    public: true,
    relPath: `linkedin/${slug}.md`,
    type: 'linkedin_post',
    title: post.topic,
    description: postText.replace(/\s+/g, ' ').slice(0, 240),
    resource: user === 'douglas' ? 'https://www.linkedin.com/in/douglasmclellan' : `${baseUrl(user)}/`,
    sourceId: `linkedin:${post.id}`,
    tags: ['linkedin', 'published', post.content_type, user],
    timestamp: date,
    body,
  });
}

function captureNewsletterBriefing(user, briefingId) {
  const briefing = db.hub().prepare(`
    SELECT b.*, f.name AS linked_format_name
    FROM nl_briefings b LEFT JOIN nl_formats f ON f.id = b.format_id
    WHERE b.id = ? AND b.user = ?
  `).get(briefingId, user);
  if (!briefing || !briefing.published_at) return null;

  const title = briefingTitle(briefing);
  const published = new Date(briefing.published_at * 1000).toISOString();
  const slugBase = briefing.date_from && briefing.date_to
    ? `${briefing.date_from}-to-${briefing.date_to}`
    : String(briefing.week_key || briefing.id).toLowerCase();
  const provenance = briefingProvenanceText(briefing);
  const body = [
    `# ${title}`,
    '',
    `Period: ${briefingPeriodLabel(briefing)}`,
    `Published: ${published.slice(0, 10)}`,
    provenance ? `Provenance: ${provenance}` : null,
    '',
    String(briefing.text_content || '').trim(),
  ].filter(Boolean).join('\n');

  return writeKnowledgeDocument({
    user,
    public: user === 'douglas',
    relPath: `briefings/${slugify(slugBase, briefing.id)}.md`,
    type: 'intelligence_briefing',
    title,
    description: provenance || `Published intelligence briefing for ${briefingPeriodLabel(briefing)}.`,
    resource: user === 'douglas' ? `${baseUrl(user)}/feed.xml` : '',
    sourceId: `newsletter-briefing:${briefing.id}`,
    tags: ['briefing', 'intelligence', 'published', user],
    timestamp: published,
    body,
  });
}

function captureNakaiDailyBriefing({ markdown, dateSlug, htmlPath, pdfPath }) {
  const title = `Nakai Daily Briefing - ${dateSlug}`;
  const body = [
    `# ${title}`,
    '',
    'Private daily briefing generated for Nakai. This artifact is kept in the local knowledge bundle and is not exposed through the public portfolio site.',
    '',
    String(markdown || '').trim(),
    '',
    '## Local Artifacts',
    htmlPath ? `- HTML: ${htmlPath}` : null,
    pdfPath ? `- PDF: ${pdfPath}` : null,
  ].filter(Boolean).join('\n');

  const privatePath = writeKnowledgeDocument({
    user: 'nakai',
    public: false,
    relPath: `daily-briefings/${dateSlug}.md`,
    type: 'private_daily_briefing',
    title,
    description: 'Private regulatory and product intelligence briefing for Nakai.',
    sourceId: `nakai-daily-briefing:${dateSlug}`,
    tags: ['daily-briefing', 'intelligence', 'regulation', 'block', 'private', 'nakai'],
    timestamp: nowIso(),
    body,
  });
  const publicSignalPath = captureNakaiPublicBriefingSignal({ dateSlug, markdown });
  return { privatePath, publicSignalPath };
}

module.exports = {
  PUBLIC_ROOT,
  PRIVATE_ROOT,
  capturePortfolioAbout,
  captureLinkedInPost,
  captureNewsletterBriefing,
  captureNakaiDailyBriefing,
  captureNakaiPublicBriefingSignal,
  removeKnowledgeBySourceId,
  writeBundleIndex,
};
