'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');

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
  try {
    writeFileEnsured(target, content);
    writeBundleIndex(user, isPublic);
    return target;
  } catch (err) {
    if (!isPublic || !['EACCES', 'EPERM', 'EROFS'].includes(err.code)) throw err;
    const privateTarget = path.join(bundleRoot(user, false), safeRelative(relPath));
    writeFileEnsured(privateTarget, content);
    writeBundleIndex(user, false);
    console.warn(`[knowledge-format] public write denied for ${target}; stored private fallback at ${privateTarget}`);
    return privateTarget;
  }
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

// All known observable topics extracted from private briefing metadata over time.
// Extend this list as new topics recur across briefings.
const NAKAI_OBSERVABLE_TOPICS = [
  'FCA (Financial Conduct Authority)',
  'Central Bank of Ireland',
  'BNPL (Buy Now, Pay Later) / Deferred Payment Credit',
  'Global fintech payments platforms and embedded finance providers',
  'Financial crime, AML, and scam controls',
  'EU AI Act and financial-services technology regulation',
  'Consumer Duty and customer harm frameworks',
  'Merchant acquiring and payment facilitation risk',
  'Ireland fintech regulatory environment',
];

// Patterns used to detect new topics from a fresh briefing's markdown.
const NAKAI_TOPIC_PATTERNS = [
  ['FCA', /\bFCA\b/i],
  ['Central Bank of Ireland', /Central Bank of Ireland/i],
  ['BNPL', /\bBNPL\b|Buy Now Pay Later|Deferred Payment Credit/i],
  ['Global payments platforms', /\bBlock\b|Cash App|\bSquare\b|Afterpay|Clearpay|Stripe|Adyen|PayPal|Klarna/i],
  ['financial crime', /financial crime|AML|anti-money-laundering/i],
];

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
  const title = post.display_title || post.topic;
  const slug = `${date.slice(0, 10)}-${slugify(title, post.id)}`;
  const body = [
    `# ${title}`,
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
    title,
    description: postText.replace(/\s+/g, ' ').slice(0, 240),
    resource: post.post_url || (user === 'douglas' ? 'https://www.linkedin.com/in/douglasmclellan' : `${baseUrl(user)}/`),
    sourceId: `linkedin:${post.id}`,
    tags: ['linkedin', 'published', post.content_type, user],
    timestamp: date,
    body,
  });
}

// Published LinkedIn thinking for AI-facing surfaces (portfolio chat, job analyser).
// Links prefer the canonical LinkedIn post URL; older posts published before
// post_url existed fall back to the public knowledge bundle page.
function publishedThinking(user) {
  const posts = db.hub().prepare(
    `SELECT id, topic, display_title, content_type, refined_draft, draft, post_url, published_at, created_at
     FROM linkedin_posts WHERE user = ? AND status = 'published'
     ORDER BY COALESCE(published_at, created_at) DESC`
  ).all(user);
  return posts.map(post => {
    const date = new Date((post.published_at || post.created_at || Math.floor(Date.now() / 1000)) * 1000)
      .toISOString().slice(0, 10);
    const text = (post.refined_draft || post.draft || '').trim();
    const title = post.display_title || post.topic;
    return {
      title,
      date,
      category: post.content_type || '',
      summary: text.replace(/\s+/g, ' ').slice(0, 240),
      url: post.post_url || `${baseUrl(user)}/knowledge/${user}/linkedin/${date}-${slugify(title, post.id)}.md`,
    };
  });
}

module.exports = {
  capturePortfolioAbout,
  captureLinkedInPost,
  publishedThinking,
  writeKnowledgeDocument,
  removeKnowledgeBySourceId,
  writeBundleIndex,
  slugify,
};
