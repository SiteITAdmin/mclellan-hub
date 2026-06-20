'use strict';

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const DEFAULT_ROOT = path.join(__dirname, '..', 'data', 'artifacts');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugify(value, fallback = 'artifact') {
  return String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || fallback;
}

function markdownToHtml(markdown) {
  return marked.parse(String(markdown || ''), {
    mangle: false,
    headerIds: false,
  });
}

function buildHtmlArtifact({
  title,
  subtitle = '',
  markdown = '',
  generatedAt = new Date(),
  accent = '#2f6f73',
}) {
  const safeTitle = escapeHtml(title || 'McLellan Hub Artifact');
  const safeSubtitle = escapeHtml(subtitle);
  const body = markdownToHtml(markdown);
  const iso = generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
:root {
  --bg: #f7f4ee;
  --panel: #ffffff;
  --ink: #202124;
  --muted: #626a70;
  --line: #d8d2c8;
  --accent: ${accent};
  --accent-soft: #dcebea;
  --code: #143235;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.55; }
body { padding: 32px 18px 48px; }
.shell { max-width: 980px; margin: 0 auto; }
header { border-bottom: 2px solid var(--accent); padding-bottom: 18px; margin-bottom: 24px; }
.kicker { color: var(--accent); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; margin-bottom: 8px; }
h1 { font-size: clamp(30px, 5vw, 52px); line-height: 1.04; margin: 0; letter-spacing: 0; }
.subtitle { color: var(--muted); font-size: 17px; max-width: 760px; margin: 12px 0 0; }
.meta { color: var(--muted); font-size: 12px; margin-top: 12px; }
main { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: clamp(20px, 4vw, 40px); box-shadow: 0 8px 28px rgba(34, 33, 30, 0.06); }
h2 { margin-top: 34px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 24px; }
h2:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
h3 { margin-top: 24px; font-size: 18px; }
p, li { font-size: 15px; }
a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
ul, ol { padding-left: 22px; }
blockquote { margin: 18px 0; padding: 12px 16px; border-left: 4px solid var(--accent); background: var(--accent-soft); }
code { color: var(--code); background: #edf2ef; padding: 2px 5px; border-radius: 5px; }
pre { overflow-x: auto; background: #10282b; color: #e8f3f2; border-radius: 8px; padding: 16px; }
pre code { background: transparent; color: inherit; padding: 0; }
table { width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 14px; }
th, td { border: 1px solid var(--line); padding: 8px 10px; vertical-align: top; }
th { background: #f0ebe2; text-align: left; }
hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0; }
@media print {
  body { background: white; padding: 0; }
  main { box-shadow: none; border: 0; }
  a { color: inherit; }
}
</style>
</head>
<body>
<div class="shell">
<header>
<div class="kicker">McLellan Hub Artifact</div>
<h1>${safeTitle}</h1>
${safeSubtitle ? `<p class="subtitle">${safeSubtitle}</p>` : ''}
<div class="meta">Generated ${escapeHtml(iso)}</div>
</header>
<main>
${body}
</main>
</div>
</body>
</html>
`;
}

function saveHtmlArtifact({ user = 'system', title, subtitle, markdown, rootDir = DEFAULT_ROOT, filename = null }) {
  const dir = path.join(rootDir, slugify(user, 'system'));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const finalName = filename || `${stamp}-${slugify(title)}.html`;
  const html = buildHtmlArtifact({ title, subtitle, markdown });
  const filePath = path.join(dir, finalName);
  fs.writeFileSync(filePath, html, 'utf8');
  return { filePath, html };
}

module.exports = {
  buildHtmlArtifact,
  saveHtmlArtifact,
  markdownToHtml,
  DEFAULT_ROOT,
};
