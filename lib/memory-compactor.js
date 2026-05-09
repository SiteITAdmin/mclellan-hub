// Rolls project conversation history into a persistent markdown document.
// When a project's message count exceeds context_depth, the oldest overflow
// messages are appended to "_Project Memory.md" (stored as a project document),
// then marked compacted so they're excluded from future context queries.
//
// Because project documents are always injected into the system prompt, the
// model retains full history — effectively unlimited memory.

const db = require('./db');
const { uuid } = require('./id');

const MEMORY_FILENAME = '_Project Memory.md';

function formatMessageBlock(m) {
  const date = new Date(m.ts * 1000).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
  const time = new Date(m.ts * 1000).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit',
  });

  // Email injections (from email-processor)
  if (m.model === 'email') {
    return `#### ${date} · ${time}\n${m.content}`;
  }

  const label = m.role === 'user' ? '**You**' : '**Assistant**';
  // Truncate very long messages to keep the doc readable
  const body = m.content.length > 1500
    ? m.content.slice(0, 1500) + '\n\n*[truncated — see original conversation]*'
    : m.content;

  return `#### ${date} · ${time} · ${label}\n\n${body}`;
}

function compactProject(projectId, user, contextDepth) {
  const hub = db.hub();

  // Count how many uncompacted messages sit outside the active window
  const total = hub.prepare(
    "SELECT COUNT(*) AS cnt FROM messages WHERE project_id = ? AND compacted = 0"
  ).get(projectId).cnt;

  if (total <= contextDepth) return 0; // nothing to do

  const overflow = total - contextDepth;

  const toCompact = hub.prepare(
    "SELECT * FROM messages WHERE project_id = ? AND compacted = 0 ORDER BY ts ASC LIMIT ?"
  ).all(projectId, overflow);

  if (!toCompact.length) return 0;

  // Build the new content block
  const newBlock = toCompact.map(formatMessageBlock).join('\n\n---\n\n');

  // Upsert into the memory document
  const existing = hub.prepare(
    "SELECT id, markdown FROM documents WHERE project_id = ? AND filename = ?"
  ).get(projectId, MEMORY_FILENAME);

  if (existing) {
    const updated = existing.markdown.trimEnd() + '\n\n---\n\n' + newBlock;
    hub.prepare(
      "UPDATE documents SET markdown = ?, size_bytes = ?, uploaded_at = unixepoch() WHERE id = ?"
    ).run(updated, Buffer.byteLength(updated), existing.id);
  } else {
    const header = [
      '---',
      'auto_generated: true',
      '---',
      '',
      '# Project Memory',
      '',
      `*Automatically maintained. Contains conversation history that has scrolled past the active context window (${contextDepth} messages). Always included as project context.*`,
      '',
      '---',
      '',
      newBlock,
    ].join('\n');
    hub.prepare(
      `INSERT INTO documents (id, user, project_id, filename, mimetype, size_bytes, markdown)
       VALUES (?, ?, ?, ?, 'text/markdown', ?, ?)`
    ).run(uuid(), user, projectId, MEMORY_FILENAME, Buffer.byteLength(header), header);
  }

  // Mark compacted
  const placeholders = toCompact.map(() => '?').join(',');
  hub.prepare(
    `UPDATE messages SET compacted = 1 WHERE id IN (${placeholders})`
  ).run(...toCompact.map(m => m.id));

  console.log(`[memory] compacted ${toCompact.length} message(s) → ${MEMORY_FILENAME} for project ${projectId}`);
  return toCompact.length;
}

module.exports = { compactProject, MEMORY_FILENAME };
