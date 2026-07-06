const express = require('express');
const router = express.Router();
const multer = require('multer');
const fetch = require('../lib/fetch');
const db = require('../lib/db');
const { fetchTodayCalendarEvents } = require('../lib/crm');
const { writeNote } = require('../lib/obsidian-vault');
const { writeMeetingNote } = require('../lib/meeting');
const { uuid } = require('../lib/id');
const { getSystemModelId, getSystemPrompt } = require('../lib/settings');
const { TASK_CODES, openRouterHeaders } = require('../lib/openrouter-attribution');
const { logUsageFromResponse } = require('../lib/openrouter-usage');
const { PROMPTS } = require('../lib/prompts');
const { createTask } = require('../lib/google-tasks');
const {
  chatLimiter, uploadLimiter, writeLimiter,
  requireAuth, requireSameOrigin, audioUpload,
} = require('./hub-shared');
const { buildDebriefContext } = require('../lib/debrief-context');
const { synthesizeSpeech } = require('../lib/tts');
const { transcribeAudioBuffer } = require('../lib/workday-ingest');

const meetingUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// ── Debrief auth: session (web) or bearer token (iOS app) ─────────────────────
// The native app can't hold the Google-OAuth session cookie the website uses,
// so it authenticates with a bearer token. To avoid minting a new production
// secret, it accepts the existing WORKDAY_MOBILE_TOKEN / WORKDAY_WEBHOOK_SECRET
// (already set in prod and already used for the Workday mobile endpoints); a
// dedicated DEBRIEF_MOBILE_TOKEN is honoured too if one is ever configured.
// Token requests skip the same-origin check (no cookie, so no CSRF surface);
// browser/session requests keep it.
function requireDebriefAuth(req, res, next) {
  const tokens = [
    process.env.DEBRIEF_MOBILE_TOKEN,
    process.env.WORKDAY_MOBILE_TOKEN,
    process.env.WORKDAY_WEBHOOK_SECRET,
  ].filter(Boolean);
  const auth = req.headers.authorization || '';
  if (tokens.some(t => auth === `Bearer ${t}`)) {
    req.hubUser = 'douglas';
    return next();
  }
  return requireSameOrigin(req, res, () => requireAuth(req, res, next));
}

// Per-session interview context, built once at /start. Sessions are short;
// on a cache miss (server restart mid-drive) the context is rebuilt.
const contextCache = new Map();
const CONTEXT_TTL_MS = 4 * 60 * 60 * 1000;

async function getSessionContext(user, sessionId) {
  const cached = contextCache.get(sessionId);
  if (cached && Date.now() - cached.ts < CONTEXT_TTL_MS) return cached;
  for (const [id, entry] of contextCache) {
    if (Date.now() - entry.ts >= CONTEXT_TTL_MS) contextCache.delete(id);
  }
  const built = { ...(await buildDebriefContext(user)), ts: Date.now() };
  contextCache.set(sessionId, built);
  return built;
}

async function interviewerReply({ user, history, contextText }) {
  const displayName = { douglas: 'Douglas', nakai: 'Nakai' }[user] || user;
  const systemPrompt = getSystemPrompt('debrief_interviewer', user, PROMPTS.debrief_interviewer)
    .replace(/\[NAME\]/g, displayName)
    .replace('[CONTEXT]', contextText)
    .replace('[CALENDAR]', contextText);

  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.DEBRIEF),
    body: JSON.stringify({
      model: getSystemModelId('debrief_interviewer', user, 'anthropic/claude-haiku-4-5'),
      messages: [{ role: 'system', content: systemPrompt }, ...history],
      temperature: 0.4,
      max_tokens: 180,
    }),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}`);
  const data = await r.json();
  logUsageFromResponse({
    user,
    feature: 'debrief-interviewer',
    modelKey: 'debrief_interviewer',
    fallbackModelId: getSystemModelId('debrief_interviewer', user, 'anthropic/claude-haiku-4-5'),
    data,
    taskCode: TASK_CODES.DEBRIEF,
  });
  const raw = data.choices[0].message.content.trim();
  return { reply: raw.replace('[DONE]', '').trim(), done: raw.includes('[DONE]') };
}

// Common Whisper outputs on silent/near-silent audio.
const HALLUCINATION_PHRASES = new Set([
  'thank you', 'thanks', 'thank you.', 'thanks for watching', 'thanks for watching!',
  'you', 'bye', 'bye.', '.', 'thank you for watching', 'thank you very much',
  'please subscribe', 'okay', 'ok',
]);

function isLikelyHallucination(text) {
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return HALLUCINATION_PHRASES.has(norm);
}

function renderDebriefTranscript(history) {
  return history
    .map(m => {
      const content = String(m.content || '').trim();
      if (!content) return null;
      const label = m.role === 'assistant' ? 'Interviewer' : 'You';
      return `**${label}:** ${content}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

function parseHistory(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function ttsOrNull(text, user) {
  try {
    return (await synthesizeSpeech({ text, user })).toString('base64');
  } catch (err) {
    console.error('[debrief tts]', err.message);
    return null; // clients show the text and keep going
  }
}

// ── Daily Debrief ─────────────────────────────────────────────────────────────
router.get('/debrief', requireAuth, async (req, res) => {
  const user = req.hubUser;
  const displayName = { douglas: 'Douglas', nakai: 'Nakai' }[user] || user;
  const tz = 'Europe/London';
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz,
  });
  let events = [];
  try { events = await fetchTodayCalendarEvents(user); } catch (_) {}
  res.render('hub/debrief', { user, displayName, events, today });
});

// Opens a debrief: builds the day context, asks the opening question, speaks it.
router.post('/api/debrief/start', requireDebriefAuth, chatLimiter, async (req, res) => {
  const user = req.hubUser;
  const sessionId = uuid();
  try {
    const ctx = await getSessionContext(user, sessionId);
    const { reply, done } = await interviewerReply({ user, history: [], contextText: ctx.contextText });
    const audio = await ttsOrNull(reply, user);

    db.hub().prepare(`
      INSERT OR IGNORE INTO debrief_sessions (id, user, started_at, turns, calendar_events)
      VALUES (?, ?, unixepoch(), 1, ?)
    `).run(sessionId, user, JSON.stringify(ctx.events));

    res.json({ sessionId, reply, done, audio });
  } catch (err) {
    console.error('[debrief start]', err);
    res.status(500).json({ error: err.message });
  }
});

// One interview turn: audio (or text) in → transcript + spoken reply out.
// Stateless: the client sends the running history each time.
router.post('/api/debrief/turn', requireDebriefAuth, chatLimiter, audioUpload.single('audio'), async (req, res) => {
  const user = req.hubUser;
  const { sessionId } = req.body;
  const history = parseHistory(req.body.history);
  if (!Array.isArray(history)) return res.status(400).json({ error: 'history must be a JSON array' });

  try {
    let transcript = (req.body.text || '').trim();
    const recording = req.file ? {
      audioBytes: req.file.buffer.length,
      mime: req.file.mimetype || 'application/octet-stream',
      filename: req.file.originalname || 'debrief-turn.m4a',
      transcriptionStatus: 'pending',
    } : null;
    if (req.file) {
      transcript = (await transcribeAudioBuffer({
        buffer: req.file.buffer,
        filename: req.file.originalname || 'debrief-turn.m4a',
        mimetype: req.file.mimetype || 'audio/mp4',
        model: getSystemModelId('debrief_transcriber', 'system', 'openai/whisper-large-v3'),
        provider: 'openrouter',
      }).catch(err => {
        console.error('[debrief stt]', err.message);
        return '';
      })).trim();
      recording.transcriptionStatus = transcript ? 'text' : 'empty';
    }

    // Whisper emits stock phrases ("Thank you", "Thanks for watching") when
    // handed near-silent audio. Treat a bare one of these as nothing heard,
    // so the interviewer re-asks instead of banking a hallucinated answer.
    if (req.file && isLikelyHallucination(transcript)) {
      transcript = '';
      recording.transcriptionStatus = 'filtered-hallucination';
    }

    if (!transcript) {
      const reply = "Sorry, I didn't catch that — could you say it again?";
      if (sessionId && recording) {
        try {
          db.hub().prepare(`
            UPDATE debrief_sessions
            SET error = ?
            WHERE id = ?
          `).run(`No transcribed answer; audioBytes=${recording.audioBytes}; mime=${recording.mime}; status=${recording.transcriptionStatus}`, sessionId);
        } catch (_) {}
      }
      return res.json({ transcript: '', reply, done: false, audio: await ttsOrNull(reply, user), recording });
    }

    const ctx = await getSessionContext(user, sessionId || uuid());
    const { reply, done } = await interviewerReply({
      user,
      history: [...history, { role: 'user', content: transcript }],
      contextText: ctx.contextText,
    });
    const audio = await ttsOrNull(reply, user);

    if (sessionId) {
      const persistedTranscript = renderDebriefTranscript([
        ...history,
        { role: 'user', content: transcript },
        { role: 'assistant', content: reply },
      ]);
      try {
        db.hub().prepare(`
          UPDATE debrief_sessions
          SET turns = turns + 1, transcript = ?
          WHERE id = ?
        `).run(persistedTranscript, sessionId);
      } catch (_) {}
    }
    if (recording) recording.transcriptionStatus = 'text';
    res.json({ transcript, reply, done, audio, recording });
  } catch (err) {
    console.error('[debrief turn]', err);
    if (sessionId) {
      try { db.hub().prepare(`UPDATE debrief_sessions SET error = ? WHERE id = ?`).run(err.message, sessionId); } catch (_) {}
    }
    res.status(500).json({ error: err.message });
  }
});

// Save full transcript to Obsidian + async extraction → CRM / projects
router.post('/api/debrief/save', requireDebriefAuth, writeLimiter, async (req, res) => {
  const { transcript, sessionId } = req.body;
  if (!transcript?.trim()) return res.status(400).json({ error: 'No transcript provided' });
  if (!/\*\*You:\*\*\s*\S/.test(transcript)) return res.status(400).json({ error: 'No recorded answers to save' });

  const user = req.hubUser;
  const tz = 'Europe/London';
  const now = new Date();
  const todayIso = now.toLocaleDateString('sv-SE', { timeZone: tz });
  const timeHHMM = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  const timeSlug = timeHHMM.replace(':', '-');
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz });
  const notePath = `Debrief/${todayIso}-${timeSlug}.md`;

  try {
    await writeNote({
      notePath,
      content: [
        '---',
        `title: Debrief ${todayIso}`,
        `date: ${todayIso}`,
        `time: ${timeHHMM}`,
        `user: ${user}`,
        `type: debrief`,
        '---',
        '',
        `# Daily Debrief — ${dateStr}`,
        '',
        transcript.trim(),
        '',
      ].join('\n'),
      mode: 'create',
    });
    // Update session log with transcript + note path
    if (sessionId) {
      try {
        db.hub().prepare(`
          UPDATE debrief_sessions SET transcript = ?, note_path = ?, ended_at = unixepoch() WHERE id = ?
        `).run(transcript.trim(), notePath, sessionId);
      } catch (_) {}
    }

    res.json({ ok: true, notePath });

    // Async extraction — fire and forget after response sent
    setImmediate(() => {
      runDebriefExtraction(user, transcript, todayIso, notePath, sessionId)
        .catch(err => console.error('[debrief extraction]', err.message));
    });
  } catch (err) {
    console.error('[debrief save]', err);
    if (sessionId) {
      try { db.hub().prepare(`UPDATE debrief_sessions SET error = ? WHERE id = ?`).run(err.message, sessionId); } catch (_) {}
    }
    res.status(500).json({ error: err.message });
  }
});

async function runDebriefExtraction(user, transcript, dateIso, sourceNotePath, sessionId) {
  const hub = db.hub();
  const contacts = hub.prepare('SELECT id, name, aliases FROM contacts WHERE user = ?').all(user);
  const projects = hub.prepare('SELECT id, name, slug FROM projects WHERE user = ?').all(user);

  const knownPeople = contacts.flatMap(c => {
    const aliases = (() => { try { return JSON.parse(c.aliases || '[]'); } catch { return []; } })();
    return [c.name, ...aliases].filter(Boolean).map(n => ({ contactId: c.id, displayName: c.name, term: n }));
  });
  const knownProjects = projects.map(p => ({ id: p.id, name: p.name, slug: p.slug }));

  const extractorBase = getSystemPrompt('debrief_extractor', user, PROMPTS.debrief_extractor)
    .replace('[PEOPLE]', knownPeople.map(p => p.term).join(', ') || 'none')
    .replace('[PROJECTS]', knownProjects.map(p => p.name).join(', ') || 'none');

  const prompt = `${extractorBase}\n\nTranscript:\n${transcript.trim()}`;

  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.DEBRIEF),
    body: JSON.stringify({
      model: getSystemModelId('debrief_extractor', user, 'deepseek/deepseek-v3.2'),
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0,
    }),
  });

  if (!r.ok) throw new Error(`Extraction LLM ${r.status}`);
  const data = await r.json();
  logUsageFromResponse({
    user,
    feature: 'debrief-extractor',
    modelKey: 'debrief_extractor',
    fallbackModelId: getSystemModelId('debrief_extractor', user, 'deepseek/deepseek-v3.2'),
    data,
    taskCode: TASK_CODES.DEBRIEF,
  });
  const extracted = JSON.parse(data.choices[0].message.content);

  if (sessionId) {
    try {
      db.hub().prepare(`UPDATE debrief_sessions SET extraction = ? WHERE id = ?`)
        .run(JSON.stringify(extracted), sessionId);
    } catch (_) {}
  }

  // Log people mentions in CRM
  for (const personName of (extracted.people || [])) {
    const match = knownPeople.find(p => p.term.toLowerCase() === personName.toLowerCase());
    if (match) {
      hub.prepare(`
        INSERT INTO crm_facts (id, user, contact_id, fact, status, source)
        VALUES (?, ?, ?, ?, 'active', 'debrief')
      `).run(uuid(), user, match.contactId, `Mentioned in debrief on ${dateIso}`);
    }
  }

  // Append debrief reference to matching project notes
  for (const projName of (extracted.projects || [])) {
    const match = knownProjects.find(p => p.name.toLowerCase() === projName.toLowerCase());
    if (match) {
      const projSlug = match.slug || match.name.replace(/\s+/g, '-').toLowerCase();
      await writeNote({
        notePath: `Projects/${projSlug}.md`,
        content: `\n- Mentioned in debrief on ${dateIso}: [[${sourceNotePath.replace(/\.md$/, '')}]]`,
        mode: 'append',
      });
    }
  }

  // Save action items to a debrief actions note and Google Tasks
  if (extracted.actions?.length) {
    const actionLines = extracted.actions.map(a => `- [ ] ${a}`).join('\n');
    await writeNote({
      notePath: `Debrief/Actions-${dateIso}.md`,
      content: [
        `## From [[${sourceNotePath.replace(/\.md$/, '')}]]`,
        '',
        actionLines,
        '',
      ].join('\n'),
      mode: 'append',
    });

    for (const action of extracted.actions) {
      createTask(user, {
        title: action,
        notes: `From debrief on ${dateIso}`,
        source: 'debrief',
        sourceId: `${sessionId || dateIso}:${action.slice(0, 60)}`,
      }).catch(err => console.warn('[tasks] debrief task create failed:', err.message));
    }
  }

  console.log(`[debrief extraction] ${user}: people=${extracted.people?.length || 0} projects=${extracted.projects?.length || 0} actions=${extracted.actions?.length || 0}`);
}

// ── Meeting debrief page ──────────────────────────────────────────────────────
router.get('/meeting', requireAuth, async (req, res, next) => {
  // Live context for the debrief prompts: today's calendar + overdue
  // follow-ups, so the page primes what matters instead of generic cards.
  try {
    const hub = require('../lib/db').hub();
    let todayEvents = [];
    try { todayEvents = await fetchTodayCalendarEvents(req.hubUser); } catch (_) {}
    const todayIso = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
    const overdueFollowUps = hub.prepare(`
      SELECT f.fact, f.due_date, c.name AS contact_name
      FROM crm_facts f JOIN contacts c ON c.id = f.contact_id
      WHERE f.user = ? AND f.status = 'follow_up' AND f.due_date IS NOT NULL AND f.due_date <= ?
      ORDER BY f.due_date LIMIT 5
    `).all(req.hubUser, todayIso);
    res.locals.debriefContext = { todayEvents, overdueFollowUps };
  } catch (err) {
    res.locals.debriefContext = { todayEvents: [], overdueFollowUps: [] };
  }
  next();
}, (req, res) => {
  const hub = db.hub();
  const projects = hub.prepare('SELECT * FROM projects WHERE user = ? ORDER BY name').all(req.hubUser);
  const contacts = hub.prepare('SELECT name FROM contacts WHERE user = ? ORDER BY name').all(req.hubUser);
  res.render('hub/meeting', { user: req.hubUser, projects, contacts, debriefContext: res.locals.debriefContext });
});

router.post('/api/meeting/transcribe', requireAuth, requireSameOrigin, uploadLimiter, audioUpload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file' });
  try {
    const { transcribeAudio } = require('../lib/workday-ingest');
    const transcript = await transcribeAudio(req.file.buffer, req.file.originalname || 'audio.m4a', req.file.mimetype || 'audio/mp4');
    res.json({ ok: true, transcript });
  } catch (err) {
    console.error('[meeting transcribe]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/meeting/submit', requireAuth, requireSameOrigin, uploadLimiter, meetingUpload.single('transcript'), async (req, res) => {
  try {
    // The form sends myThoughts (voice/typed debrief) and optionally a
    // transcript file; writeMeetingNote takes (user, options). The old
    // handler passed one object with mismatched keys, so every no-file
    // submit failed with "No transcript" — found during the 6 Jul CRM
    // review build and fixed here.
    const uploadedTranscript = req.file ? req.file.buffer.toString('utf8') : '';
    const myThoughts = String(req.body.myThoughts || req.body.transcript || '').trim();
    if (!uploadedTranscript.trim() && !myThoughts) {
      return res.status(400).json({ error: 'No transcript — record, type, or upload one first' });
    }
    const attendees = (() => {
      try {
        const parsed = JSON.parse(req.body.attendees || '[]');
        return Array.isArray(parsed) ? parsed.map(a => String(a).trim()).filter(Boolean) : [];
      } catch { return []; }
    })();
    const dateStr = String(req.body.meeting_date || '').trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? new Date(dateStr + 'T12:00:00Z') : new Date();
    const meetingTime = /^\d{2}:\d{2}$/.test(String(req.body.meeting_time || '')) ? req.body.meeting_time : '';
    const durationMins = parseInt(req.body.duration_mins, 10);
    const channel = ['video call', 'in person', 'phone', 'chat', 'async'].includes(String(req.body.channel || '')) ? req.body.channel : '';

    const result = await writeMeetingNote(req.hubUser, {
      title: String(req.body.title || '').trim() || 'Meeting debrief',
      attendees,
      projectSlug: String(req.body.project || req.body.projectSlug || '').trim() || null,
      myThoughts,
      uploadedTranscript,
      date,
      meetingTime,
      durationMins: Number.isFinite(durationMins) ? durationMins : null,
      channel,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[meeting submit]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
