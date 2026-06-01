// Extract uploaded files to markdown.
// Returns { markdown, warnings? }.

const path = require('path');
const mammoth = require('mammoth');
const fetch = require('node-fetch');
const { convertWithMarkitdown } = require('./markitdown');

// Formats handled natively (Node libs). Everything else goes to markitdown.
const NATIVE_EXTS  = ['.docx', '.pdf', '.txt', '.md', '.csv'];
const MARKITDOWN_EXTS = ['.pptx', '.ppt', '.xlsx', '.xls', '.epub', '.html', '.htm'];
const SUPPORTED_EXTS = [...NATIVE_EXTS, ...MARKITDOWN_EXTS];

function extFromFilename(filename) {
  return path.extname(filename || '').toLowerCase();
}

async function extractDocx(buffer) {
  const result = await mammoth.convertToMarkdown({ buffer });
  return { markdown: result.value.trim(), warnings: result.messages.map(m => m.message) };
}

async function extractPdf(buffer) {
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (err) {
    throw new Error('PDF support is not installed. Run npm install, then try the upload again.');
  }

  const pdfPackagePath = require.resolve('pdfjs-dist/package.json');
  const standardFontDataUrl = path.join(path.dirname(pdfPackagePath), 'standard_fonts') + path.sep;

  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      disableWorker: true,
      standardFontDataUrl,
    }).promise;
  } catch (err) {
    throw new Error(`Could not read this PDF: ${err.message || 'unknown parser error'}`);
  }

  const pages = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map(item => item.str || '')
      .join(' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (text) pages.push(text);
  }

  const markdown = pages.join('\n\n').trim();
  if (!markdown) {
    // pdfjs got nothing — try markitdown (handles some scanned/structured PDFs better)
    return convertWithMarkitdown(buffer, 'document.pdf');
  }
  return { markdown };
}

async function extractTxt(buffer) {
  return { markdown: buffer.toString('utf8').trim() };
}

async function fileToMarkdown(filename, buffer) {
  const ext = extFromFilename(filename);
  if (!SUPPORTED_EXTS.includes(ext)) {
    throw new Error(`Unsupported file type: ${ext || 'unknown'}. Supported: ${SUPPORTED_EXTS.join(', ')}`);
  }
  if (ext === '.docx') return extractDocx(buffer);
  if (ext === '.pdf')  return extractPdf(buffer);
  if (MARKITDOWN_EXTS.includes(ext)) return convertWithMarkitdown(buffer, filename);
  return extractTxt(buffer);
}

function withProjectFrontmatter({ project, filename, markdown }) {
  const uploaded = new Date().toISOString();
  return `---
project: ${project.name}
slug: ${project.slug}
filename: ${filename}
uploaded_at: ${uploaded}
---

# ${filename}

${markdown}
`;
}

// Fetch a URL and return { url, title, text } with HTML stripped to readable text.
async function fetchUrl(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; McLellanHub/1.0)' },
    redirect: 'follow',
    timeout: 12000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/html') && !ct.includes('text/plain')) {
    throw new Error(`Not a readable page (${ct.split(';')[0].trim()})`);
  }
  const html = await res.text();
  const titleMatch = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{3,}/g, '\n\n')
    .trim()
    .slice(0, 40000);
  return { url, title, text };
}

module.exports = { fileToMarkdown, withProjectFrontmatter, SUPPORTED_EXTS, fetchUrl };
