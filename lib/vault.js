const path = require('path');
const fs = require('fs');

const VAULT_ROOT = process.env.VAULT_PATH ||
  path.resolve(__dirname, '../data/synthadoc/mclellan-hub-knowledge');
const WIKI_DIR   = path.join(VAULT_ROOT, 'wiki');
const RAW_DCHAT  = path.join(VAULT_ROOT, 'raw_sources', 'dchat-projects');

// ── Frontmatter helpers ───────────────────────────────────────────────────────
function splitFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: null, body: text };
  return { frontmatter: m[1], body: m[2].trimStart() };
}

function extractField(frontmatter, key) {
  if (!frontmatter) return null;
  const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
}

// ── Wiki page I/O ─────────────────────────────────────────────────────────────
function listWikiPages() {
  if (!fs.existsSync(WIKI_DIR)) return [];
  return fs.readdirSync(WIKI_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const slug = f.replace(/\.md$/, '');
      const raw  = fs.readFileSync(path.join(WIKI_DIR, f), 'utf8');
      const { frontmatter, body } = splitFrontmatter(raw);
      const title = extractField(frontmatter, 'title') || slug;
      const existingLinks = [...body.matchAll(/\[\[([^\]|]+)/g)].map(m => m[1].trim());
      const sources = [...raw.matchAll(/- file: (.+)/g)].map(m => m[1].trim());
      return { slug, title, body, frontmatter, raw, existingLinks, sources };
    });
}

function readWikiPage(slug) {
  const fp = path.join(WIKI_DIR, `${slug}.md`);
  if (!fs.existsSync(fp)) return null;
  const raw = fs.readFileSync(fp, 'utf8');
  const { frontmatter, body } = splitFrontmatter(raw);
  return { slug, frontmatter, body, raw };
}

function writeWikiPage(slug, frontmatter, body) {
  if (!fs.existsSync(WIKI_DIR)) fs.mkdirSync(WIKI_DIR, { recursive: true });
  const content = frontmatter
    ? `---\n${frontmatter}\n---\n\n${body.trimStart()}`
    : body;
  fs.writeFileSync(path.join(WIKI_DIR, `${slug}.md`), content, 'utf8');
}

// ── Raw source discovery ──────────────────────────────────────────────────────
// Returns dchat raw source files not yet referenced by any wiki page source
function listUnprocessedRaw() {
  const processed = new Set();
  if (fs.existsSync(WIKI_DIR)) {
    for (const f of fs.readdirSync(WIKI_DIR)) {
      if (!f.endsWith('.md')) continue;
      const text = fs.readFileSync(path.join(WIKI_DIR, f), 'utf8');
      for (const [, src] of text.matchAll(/- file: (.+)/g))
        processed.add(path.basename(src.trim()));
    }
  }
  const results = [];
  if (!fs.existsSync(RAW_DCHAT)) return results;
  for (const proj of fs.readdirSync(RAW_DCHAT)) {
    const projDir = path.join(RAW_DCHAT, proj);
    if (!fs.statSync(projDir).isDirectory()) continue;
    for (const f of fs.readdirSync(projDir)) {
      if (!f.endsWith('.md')) continue;
      if (!processed.has(f))
        results.push({ project: proj, filename: f, filePath: path.join(projDir, f) });
    }
  }
  return results;
}

// ── Index maintenance ─────────────────────────────────────────────────────────
function rebuildIndex(pages) {
  const lines = ['# Index\n'];
  for (const p of pages.filter(p => p.slug !== 'index' && p.slug !== 'dashboard'))
    lines.push(`- [[${p.slug}]] — ${p.title}`);
  const indexPath = path.join(WIKI_DIR, 'index.md');
  const existing  = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
  const { frontmatter } = splitFrontmatter(existing);
  writeWikiPage('index', frontmatter, lines.join('\n'));
}

module.exports = {
  VAULT_ROOT, WIKI_DIR, RAW_DCHAT,
  splitFrontmatter, extractField,
  listWikiPages, readWikiPage, writeWikiPage,
  listUnprocessedRaw, rebuildIndex,
};
