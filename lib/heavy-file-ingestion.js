'use strict';

const fs = require('fs');
const path = require('path');
const { fileToMarkdown } = require('./extract');

const DEFAULT_ROOT = path.join(__dirname, '..', 'data', 'ingested');
const MAX_CHARS_PER_CHUNK = 6000;

function safeName(value, fallback = 'source') {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || fallback;
}

function stripProjectFrontmatter(markdown) {
  return String(markdown || '')
    .replace(/^---[\s\S]*?---\n+/, '')
    .replace(/^# .+\n+/, '')
    .trim();
}

function chunkMarkdown(markdown, maxChars = MAX_CHARS_PER_CHUNK) {
  const text = String(markdown || '').trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + maxChars, text.length);
    if (end < text.length) {
      const slice = text.slice(cursor, end);
      const breakAt = Math.max(
        slice.lastIndexOf('\n## '),
        slice.lastIndexOf('\n\n'),
        slice.lastIndexOf('. ')
      );
      if (breakAt > maxChars * 0.5) end = cursor + breakAt + 1;
    }
    chunks.push(text.slice(cursor, end).trim());
    cursor = end;
  }
  return chunks.filter(Boolean);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function buildIngestionPackage({
  id,
  user,
  filename,
  mimetype,
  sizeBytes,
  buffer = null,
  markdown = null,
  project = null,
  rootDir = DEFAULT_ROOT,
}) {
  if (!id) throw new Error('id is required for ingestion package');
  if (!filename) throw new Error('filename is required for ingestion package');

  const startedAt = new Date().toISOString();
  const packageDir = path.join(rootDir, safeName(user || 'system'), `${safeName(id)}-${safeName(filename)}`);
  const artifactsDir = path.join(packageDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  let extracted = { markdown: markdown || '' };
  if (!markdown && buffer) extracted = await fileToMarkdown(filename, buffer);
  const cleanMarkdown = stripProjectFrontmatter(extracted.markdown || markdown || '');

  const sourceMarkdownPath = path.join(artifactsDir, 'source.md');
  fs.writeFileSync(sourceMarkdownPath, `${cleanMarkdown}\n`, 'utf8');

  const chunks = chunkMarkdown(cleanMarkdown);
  const chunkFiles = [];
  if (chunks.length > 1) {
    const chunkDir = path.join(artifactsDir, 'chunks');
    fs.mkdirSync(chunkDir, { recursive: true });
    chunks.forEach((chunk, index) => {
      const name = `chunk-${String(index + 1).padStart(3, '0')}.md`;
      fs.writeFileSync(path.join(chunkDir, name), `${chunk}\n`, 'utf8');
      chunkFiles.push(`artifacts/chunks/${name}`);
    });
  }

  const index = {
    schema: 'mclellan.ingestion-package.v1',
    id,
    user: user || null,
    filename,
    mimetype: mimetype || null,
    sizeBytes: sizeBytes || null,
    project: project ? { id: project.id || null, slug: project.slug || null, name: project.name || null } : null,
    createdAt: startedAt,
    artifacts: [
      {
        kind: 'markdown',
        path: 'artifacts/source.md',
        chars: cleanMarkdown.length,
        summary: 'Canonical lightweight text artifact used by synthesis and retrieval.',
      },
      ...chunkFiles.map((file, index) => ({
        kind: 'markdown-chunk',
        path: file,
        index,
        summary: 'Chunked readable artifact for large-source review.',
      })),
    ],
    warnings: extracted.warnings || [],
    isImage: !!extracted.isImage,
  };
  writeJson(path.join(packageDir, 'index.json'), index);

  return {
    id,
    packageDir,
    indexPath: path.join(packageDir, 'index.json'),
    markdown: cleanMarkdown,
    warnings: index.warnings,
    isImage: index.isImage,
    artifactCount: index.artifacts.length,
  };
}

module.exports = {
  buildIngestionPackage,
  chunkMarkdown,
  stripProjectFrontmatter,
  DEFAULT_ROOT,
};
