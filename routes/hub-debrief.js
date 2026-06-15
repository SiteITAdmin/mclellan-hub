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

const meetingUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

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

// LLM interviewer — receives conversation history, returns next acknowledgment + question
router.post('/api/debrief/message', requireAuth, requireSameOrigin, chatLimiter, async (req, res) => {
  const { messages: history, events: clientEvents, sessionId } = req.body;
  if (!Array.isArray(history)) return res.status(400).json({ error: 'messages required' });

  const user = req.hubUser;
  const displayName = { douglas: 'Douglas', nakai: 'Nakai' }[user] || user;

  let events = [];
  try { events = clientEvents?.length ? clientEvents : await fetchTodayCalendarEvents(user); } catch (_) {}

  const calendarCtx = events.length
    ? events.map(ev => `- ${ev.time ? ev.time + ' ' : ''}${ev.summary}`).join('\n')
    : 'No calendar events found for today.';

  const systemPrompt = getSystemPrompt('debrief_interviewer', user, PROMPTS.debrief_interviewer)
    .replace(/\[NAME\]/g, displayName)
    .replace('[CALENDAR]', calendarCtx);

  try {
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
    const done = raw.includes('[DONE]');
    const reply = raw.replace('[DONE]', '').trim();
    res.json({ reply, done });

    // Log session turn in DB
    if (sessionId) {
      const hub = db.hub();
      const isFirst = history.length === 0;
      if (isFirst) {
        hub.prepare(`
          INSERT OR IGNORE INTO debrief_sessions (id, user, started_at, turns, calendar_events)
          VALUES (?, ?, unixepoch(), 1, ?)
        `).run(sessionId, user, JSON.stringify(clientEvents || events));
      } else {
        hub.prepare(`
          UPDATE debrief_sessions SET turns = turns + 1 WHERE id = ?
        `).run(sessionId);
      }
    }
  } catch (err) {
    console.error('[debrief message]', err);
    if (sessionId) {
      try { db.hub().prepare(`UPDATE debrief_sessions SET error = ? WHERE id = ?`).run(err.message, sessionId); } catch (_) {}
    }
    res.status(500).json({ error: err.message });
  }
});

// Save full transcript to Obsidian + async extraction → CRM / projects
router.post('/api/debrief/save', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const { transcript, sessionId } = req.body;
  if (!transcript?.trim()) return res.status(400).json({ error: 'No transcript provided' });

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
        `# Debrief Actions — ${dateIso}`,
        '',
        `_From [[${sourceNotePath.replace(/\.md$/, '')}]]_`,
        '',
        actionLines,
        '',
      ].join('\n'),
      mode: 'create',
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

  if (sessionId) {
    try {
      db.hub().prepare(`UPDATE debrief_sessions SET extraction = ? WHERE id = ?`)
        .run(JSON.stringify(extracted), sessionId);
    } catch (_) {}
  }
}

// ── Meeting debrief page ──────────────────────────────────────────────────────
router.get('/meeting', requireAuth, (req, res) => {
  const hub = db.hub();
  const projects = hub.prepare('SELECT * FROM projects WHERE user = ? ORDER BY name').all(req.hubUser);
  const contacts = hub.prepare('SELECT name FROM contacts WHERE user = ? ORDER BY name').all(req.hubUser);
  res.render('hub/meeting', { user: req.hubUser, projects, contacts });
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
    const transcript = req.file
      ? req.file.buffer.toString('utf8')
      : (req.body.transcript || '');
    if (!transcript.trim()) return res.status(400).json({ error: 'No transcript' });

    const result = await writeMeetingNote({
      user: req.hubUser,
      transcript,
      title: req.body.title,
      attendees: req.body.attendees,
      projectSlug: req.body.projectSlug,
      model: req.body.model,
    });
    res.json(result);
  } catch (err) {
    console.error('[meeting submit]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
