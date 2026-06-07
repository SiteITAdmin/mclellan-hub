const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_VAULT_ROOT = path.join(ROOT, 'data', 'synthadoc', 'mclellan-hub-knowledge');

function vaultRoot() {
  return path.resolve(process.env.OBSIDIAN_VAULT_PATH || process.env.VAULT_PATH || DEFAULT_VAULT_ROOT);
}

function normalizeNotePath(notePath) {
  const raw = String(notePath || '').trim();
  if (!raw) throw new Error('path is required');
  const withExt = raw.endsWith('.md') ? raw : `${raw}.md`;
  const safe = path.normalize(withExt).replace(/^(\.\.(\/|\\|$))+/, '');
  if (path.isAbsolute(safe) || safe.includes('\0')) throw new Error('invalid path');

  const root = vaultRoot();
  const fullPath = path.resolve(root, safe);
  if (!fullPath.startsWith(root + path.sep)) throw new Error('path escapes vault');
  return { root, relativePath: path.relative(root, fullPath), fullPath };
}

function readNote(notePath) {
  const note = normalizeNotePath(notePath);
  if (!fs.existsSync(note.fullPath)) return null;
  const stat = fs.statSync(note.fullPath);
  if (!stat.isFile()) throw new Error('path is not a file');
  return {
    path: note.relativePath,
    content: fs.readFileSync(note.fullPath, 'utf8'),
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

function writeNote({ notePath, content, mode = 'create' }) {
  const note = normalizeNotePath(notePath);
  fs.mkdirSync(path.dirname(note.fullPath), { recursive: true });

  if (mode === 'create' && fs.existsSync(note.fullPath)) {
    throw new Error('note already exists');
  }
  if (mode === 'append') {
    fs.appendFileSync(note.fullPath, `${fs.existsSync(note.fullPath) ? '\n' : ''}${String(content || '').trim()}\n`, 'utf8');
  } else {
    fs.writeFileSync(note.fullPath, String(content || ''), 'utf8');
  }

  const stat = fs.statSync(note.fullPath);
  return { path: note.relativePath, size: stat.size, mtime: stat.mtime.toISOString() };
}

function walkMarkdown(dir, root = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.obsidian') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.synthadoc') continue;
      walkMarkdown(full, root, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const stat = fs.statSync(full);
      out.push({
        path: path.relative(root, full),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    }
  }
  return out;
}

function listNotes({ prefix = '', limit = 100 } = {}) {
  const root = vaultRoot();
  const all = walkMarkdown(root)
    .filter(note => !prefix || note.path.startsWith(prefix))
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  return all.slice(0, Math.min(Math.max(Number(limit) || 100, 1), 500));
}

async function searchNotes({ query, limit = 20 } = {}) {
  const synthadocUrl = process.env.SYNTHADOC_URL;
  if (synthadocUrl) {
    try {
      const res = await fetch(`${synthadocUrl}/context/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: String(query || ''), token_budget: 4000 }),
      });
      if (res.ok) {
        const data = await res.json();
        const cap = Math.min(Math.max(Number(limit) || 20, 1), 100);
        return (data.pages || []).slice(0, cap).map(p => ({
          path: p.source,
          excerpt: p.excerpt,
          size: 0,
          mtime: new Date().toISOString(),
        }));
      }
    } catch (_) {}
  }

  // fallback: naive full-text scan
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const root = vaultRoot();
  const results = [];

  for (const note of walkMarkdown(root)) {
    const full = path.join(root, note.path);
    const content = fs.readFileSync(full, 'utf8');
    const haystack = `${note.path}\n${content}`.toLowerCase();
    if (!terms.every(term => haystack.includes(term))) continue;

    const firstTerm = terms[0];
    const idx = haystack.indexOf(firstTerm);
    const start = Math.max(idx - 120, 0);
    const excerpt = content.slice(start, start + 320).replace(/\s+/g, ' ').trim();
    results.push({ ...note, excerpt });
    if (results.length >= Math.min(Math.max(Number(limit) || 20, 1), 100)) break;
  }

  return results;
}

module.exports = {
  listNotes,
  readNote,
  searchNotes,
  writeNote,
  vaultRoot,
};
