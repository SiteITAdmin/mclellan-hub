const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fetch = require('./fetch');
const db = require('./db');
const { uuid } = require('./id');
const { routeMessage } = require('./router');
const { logUsageFromResponse } = require('./openrouter-usage');
const { getSystemModelKey, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, '..');
const VAULT_ROOT = path.join(ROOT, 'data', 'synthadoc', 'mclellan-hub-knowledge');
const WORKDAY_RAW_DIR = path.join(VAULT_ROOT, 'raw_sources', 'workday');

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'workday-note';
}

function yamlEscape(value) {
  return JSON.stringify(String(value || ''));
}

function formatLocalDate(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'Europe/Dublin' });
}

function formatLocalStamp(date = new Date()) {
  const d = new Date(date);
  const datePart = d.toLocaleDateString('en-CA', { timeZone: 'Europe/Dublin' });
  const timePart = d.toLocaleTimeString('en-GB', {
    timeZone: 'Europe/Dublin',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).replace(':', '');
  return `${datePart}-${timePart}`;
}

function ensureWorkdayProject(hub, user, slug = 'workday', name = 'Workday Journal') {
  let project = hub.prepare('SELECT * FROM projects WHERE user = ? AND slug = ?').get(user, slug);
  if (project) return project;

  const id = uuid();
  hub.prepare(
    'INSERT INTO projects (id, user, name, slug, context_depth, is_cv_context) VALUES (?, ?, ?, ?, ?, 0)'
  ).run(id, user, name, slug, 40);
  return hub.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

function fallbackNarrative({ transcript, title, capturedAt }) {
  return [
    `# ${title}`,
    '',
    `Captured: ${capturedAt.toISOString()}`,
    '',
    '## Narrative',
    '',
    transcript.trim(),
    '',
    '## Follow-ups',
    '',
    '- Review this note and turn any decisions, actions, or useful facts into project tasks or CRM facts.',
  ].join('\n');
}

async function buildNarrative({ transcript, title, capturedAt, user, model }) {
  const trimmed = transcript.trim();
  if (!trimmed) throw new Error('Transcript is empty');

  const prompt = [
    'Turn this spoken workday interview transcript into a useful private knowledge note.',
    '',
    'Keep it faithful to the speaker. Do not invent facts.',
    'Write in first person where it naturally reads as a diary/narrative.',
    'Use these sections: Narrative, Decisions, People, Projects, Actions, Open Questions, Raw Transcript.',
    'If a section has nothing useful, write "None captured."',
    'Preserve names, organisations, dates, systems, blockers, and emotional context when present.',
    '',
    `Title: ${title}`,
    `Captured at: ${capturedAt.toISOString()}`,
    '',
    'Transcript:',
    trimmed,
  ].join('\n');

  try {
    const result = await routeMessage({
      model: model || getSystemModelKey('workday_narrative', user, process.env.WORKDAY_NARRATIVE_MODEL || 'free'),
      user,
      noSearch: true,
      messages: [
        { role: 'system', content: getSystemPrompt('workday_narrative', user, PROMPTS.workday_narrative) },
        { role: 'user', content: prompt },
      ],
      onChunk: () => {},
    });
    return result.content.trim();
  } catch (err) {
    console.warn('[workday] narrative model failed, storing transcript fallback:', err.message);
    return fallbackNarrative({ transcript, title, capturedAt });
  }
}

function buildMarkdown({ user, title, capturedAt, source, narrative, transcript }) {
  return [
    '---',
    `type: "workday-interview"`,
    `user: ${yamlEscape(user)}`,
    `title: ${yamlEscape(title)}`,
    `captured_at: ${yamlEscape(capturedAt.toISOString())}`,
    `source: ${yamlEscape(source || 'manual')}`,
    'tags:',
    '  - workday',
    '  - interview',
    '---',
    '',
    narrative.trim(),
    '',
    '---',
    '',
    '## Transcript',
    '',
    transcript.trim(),
    '',
  ].join('\n');
}

function writeVaultSource({ title, capturedAt, markdown }) {
  fs.mkdirSync(WORKDAY_RAW_DIR, { recursive: true });
  const filename = `${formatLocalStamp(capturedAt)}-${slugify(title)}.md`;
  const fullPath = path.join(WORKDAY_RAW_DIR, filename);
  fs.writeFileSync(fullPath, markdown, 'utf8');
  return fullPath;
}

function storeProjectDocument({ hub, user, project, title, capturedAt, markdown, source }) {
  const filename = `${formatLocalDate(capturedAt)} - ${title}.md`;
  const docId = uuid();
  hub.prepare(`
    INSERT INTO documents (id, user, project_id, filename, mimetype, size_bytes, markdown)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    docId,
    user,
    project.id,
    filename,
    'text/markdown',
    Buffer.byteLength(markdown, 'utf8'),
    markdown
  );

  hub.prepare(`
    INSERT INTO messages (id, conversation_id, project_id, role, content, user, model)
    VALUES (?, NULL, ?, 'user', ?, ?, ?)
  `).run(
    uuid(),
    project.id,
    `Ingested workday interview: ${title}\n\nSource: ${source || 'manual'}\nCaptured: ${capturedAt.toISOString()}`,
    user,
    'workday-ingest'
  );

  return { id: docId, filename };
}

async function enqueueSynthadocIngest(sourcePath) {
  const synthadocUrl = process.env.SYNTHADOC_URL;
  if (synthadocUrl) {
    try {
      const res = await fetch(`${synthadocUrl}/jobs/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: sourcePath }),
      });
      if (res.ok) {
        const data = await res.json();
        return { ok: true, job_id: data.job_id };
      }
      return { ok: false, error: `Synthadoc API returned ${res.status}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // CLI fallback for local dev without Synthadoc server
  const bin = process.env.SYNTHADOC_BIN || path.join(ROOT, '.tools', 'synthadoc-venv', 'bin', 'synthadoc');
  const pythonPath = [
    path.join(ROOT, '.tools', 'synthadoc'),
    process.env.PYTHONPATH,
  ].filter(Boolean).join(path.delimiter);

  try {
    const { stdout, stderr } = await execFileAsync(
      bin,
      ['ingest', sourcePath, '-w', 'mclellan-hub-knowledge'],
      {
        cwd: ROOT,
        timeout: 15000,
        env: { ...process.env, PYTHONPATH: pythonPath },
      }
    );
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      stdout: err.stdout ? String(err.stdout).trim() : '',
      stderr: err.stderr ? String(err.stderr).trim() : '',
    };
  }
}

async function transcribeAudioBuffer({ buffer, filename, mimetype }) {
  const openAiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_TRANSCRIPTION_API_KEY;
  if (openAiKey) {
    return transcribeWithOpenAI({ buffer, filename, mimetype, apiKey: openAiKey });
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (openRouterKey) {
    return transcribeWithOpenRouter({ buffer, filename, mimetype, apiKey: openRouterKey });
  }

  throw new Error('Audio transcription needs OPENAI_API_KEY, OPENAI_TRANSCRIPTION_API_KEY, or OPENROUTER_API_KEY in the server environment.');
}

async function transcribeWithOpenAI({ buffer, filename, mimetype, apiKey }) {
  const boundary = `----mclellan-workday-${Date.now().toString(16)}`;
  const parts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${process.env.WORKDAY_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe'}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(filename || 'workday-audio.webm')}"\r\nContent-Type: ${mimetype || 'application/octet-stream'}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat(parts),
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${body.slice(0, 500)}`);

  let json;
  try { json = JSON.parse(body); } catch (_) { json = {}; }
  const text = json.text || body;
  if (!text.trim()) throw new Error('Transcription returned no text.');
  return text.trim();
}

function audioFormat(filename, mimetype) {
  const ext = path.extname(filename || '').replace(/^\./, '').toLowerCase();
  if (['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm', 'ogg', 'flac', 'aac'].includes(ext)) return ext;
  if (mimetype?.includes('webm')) return 'webm';
  if (mimetype?.includes('mp4')) return 'm4a';
  if (mimetype?.includes('mpeg')) return 'mp3';
  if (mimetype?.includes('wav')) return 'wav';
  if (mimetype?.includes('ogg')) return 'ogg';
  return 'm4a';
}

async function transcribeWithOpenRouter({ buffer, filename, mimetype, apiKey }) {
  const model = process.env.WORKDAY_TRANSCRIPTION_MODEL || 'openai/whisper-large-v3';
  const started = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://dchat.mclellan.scot',
      'X-Title': 'McLellan Hub Workday Ingest',
    },
    body: JSON.stringify({
      model,
      language: 'en',
      input_audio: {
        data: buffer.toString('base64'),
        format: audioFormat(filename, mimetype),
      },
    }),
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`OpenRouter transcription failed (${res.status}): ${body.slice(0, 500)}`);

  let json;
  try { json = JSON.parse(body); } catch (_) { json = {}; }
  logUsageFromResponse({
    user: 'system',
    feature: 'workday-transcription',
    modelKey: 'workday-transcription',
    fallbackModelId: model,
    data: json,
    durationMs: Date.now() - started,
  });
  const text = json.text || body;
  if (!text.trim()) throw new Error('Transcription returned no text.');
  return text.trim();
}

async function ingestWorkdayInterview({
  user = 'douglas',
  transcript,
  audioBuffer,
  audioFilename,
  audioMimetype,
  title,
  source = 'manual',
  projectSlug = 'workday',
  projectName = 'Workday Journal',
  model,
  capturedAt = new Date(),
  synthadoc = true,
} = {}) {
  let finalTranscript = String(transcript || '').trim();
  if (!finalTranscript && audioBuffer) {
    finalTranscript = await transcribeAudioBuffer({
      buffer: audioBuffer,
      filename: audioFilename,
      mimetype: audioMimetype,
    });
    source = source === 'manual' ? 'audio' : source;
  }
  if (!finalTranscript) throw new Error('Provide transcript text or an audio file.');

  const hub = db.hub();
  const project = ensureWorkdayProject(hub, user, projectSlug, projectName);
  const capturedDate = capturedAt instanceof Date ? capturedAt : new Date(capturedAt);
  const noteTitle = String(title || `Workday interview ${formatLocalDate(capturedDate)}`).trim();
  const narrative = await buildNarrative({
    transcript: finalTranscript,
    title: noteTitle,
    capturedAt: capturedDate,
    user,
    model,
  });
  const markdown = buildMarkdown({
    user,
    title: noteTitle,
    capturedAt: capturedDate,
    source,
    narrative,
    transcript: finalTranscript,
  });
  const vaultPath = writeVaultSource({ title: noteTitle, capturedAt: capturedDate, markdown });
  const document = storeProjectDocument({
    hub,
    user,
    project,
    title: noteTitle,
    capturedAt: capturedDate,
    markdown,
    source,
  });
  const synthadocIngest = synthadoc ? await enqueueSynthadocIngest(vaultPath) : { ok: false, skipped: true };

  return {
    ok: true,
    user,
    project: { id: project.id, slug: project.slug, name: project.name },
    document,
    vaultPath,
    synthadocIngest,
    transcriptChars: finalTranscript.length,
  };
}

module.exports = {
  ingestWorkdayInterview,
  transcribeAudioBuffer,
  ensureWorkdayProject,
  enqueueSynthadocIngest,
};
