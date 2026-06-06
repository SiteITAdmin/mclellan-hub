const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { OAuth2Client } = require('google-auth-library');
const db = require('../lib/db');
const { processCrmCommand, listContacts, buildBriefingText, fetchTodayCalendarEvents } = require('../lib/crm');
const { readNote, searchNotes, writeNote } = require('../lib/obsidian-vault');
const { uuid } = require('../lib/id');
const {
  writeLimiter, requireAuth, requireSameOrigin,
} = require('./hub-shared');

const googleChatClient = new OAuth2Client();
const GOOGLE_CHAT_ADDON_EMAIL_RE = /^service-\d+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/;

function todayIso() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
}

function chatResponse(text) {
  return { text: String(text || '').slice(0, 3500) };
}

function isGoogleWorkspaceAddOnRequest(req) {
  return Boolean(req.body?.chat || String(req.headers['user-agent'] || '').includes('Google-gsuiteaddons'));
}

function googleChatReply(req, text) {
  const message = chatResponse(text);
  if (!isGoogleWorkspaceAddOnRequest(req)) return message;
  return {
    hostAppDataAction: {
      chatDataAction: {
        createMessageAction: { message },
      },
    },
  };
}

function cleanGoogleChatText(raw) {
  return String(raw || '')
    .replace(/<users\/[^>]+>/g, '')
    .replace(/@[^\s]+/g, '')
    .trim()
    .replace(/^\/(crm|hermes)\s*/i, '')
    .trim();
}

function decodeJwtClaims(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

async function verifyGoogleChatRequest(req) {
  const skip = process.env.GOOGLE_CHAT_VERIFY === 'false';
  if (skip) return true;

  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!bearer) {
    console.warn('[google-chat] auth failed: missing bearer token');
    return false;
  }

  const audiences = [
    process.env.GOOGLE_CHAT_AUTH_AUDIENCE,
    process.env.GOOGLE_CHAT_PROJECT_NUMBER,
    'https://dchat.mclellan.scot/api/google-chat/hermes',
    '801490335247',
  ].filter(Boolean);

  const chatIssuer = 'chat@system.gserviceaccount.com';
  const isAllowedGoogleChatEmail = (email) =>
    email === chatIssuer || GOOGLE_CHAT_ADDON_EMAIL_RE.test(String(email || ''));

  try {
    for (const audience of audiences) {
      try {
        const ticket = await googleChatClient.verifyIdToken({ idToken: bearer, audience });
        const payload = ticket.getPayload();
        if (payload?.email_verified && isAllowedGoogleChatEmail(payload.email)) return true;
      } catch (_) {}
    }

    const certResp = await fetch(`https://www.googleapis.com/service_accounts/v1/metadata/x509/${encodeURIComponent(chatIssuer)}`);
    const certs = await certResp.json();
    for (const audience of audiences) {
      try {
        await googleChatClient.verifySignedJwtWithCertsAsync(bearer, certs, audience, [chatIssuer]);
        return true;
      } catch (_) {}
    }

    const claims = decodeJwtClaims(bearer) || {};
    console.warn(`[google-chat] auth failed: token did not verify for audiences ${audiences.join(', ')}; claims=${JSON.stringify({
      iss: claims.iss,
      aud: claims.aud,
      email: claims.email,
      azp: claims.azp,
    })}`);
    return false;
  } catch (err) {
    console.warn('[google-chat] auth failed:', err.message);
    return false;
  }
}

async function postToGoogleChatSpace(spaceName, text) {
  if (!spaceName) return;
  try {
    const fs = require('fs');
    const saPath = require('path').join(__dirname, '..', 'config', 'google-service-account.json');
    if (!fs.existsSync(saPath)) { console.warn('[google-chat] no service account for async post'); return; }
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(fs.readFileSync(saPath, 'utf8')),
      scopes: ['https://www.googleapis.com/auth/chat.bot'],
    });
    const chat = google.chat({ version: 'v1', auth });
    await chat.spaces.messages.create({ parent: spaceName, requestBody: { text } });
    console.log('[google-chat] async post sent to', spaceName);
  } catch (err) {
    console.error('[google-chat] async post failed:', err.message);
  }
}

function helpText() {
  return [
    '"Had a call with Karol - she is pushing for June" saves a CRM note',
    '"briefing" shows today\'s open CRM items',
    '"today" reads today\'s Obsidian daily note',
    '"search Dad physio" searches the vault',
    '"read Daily/2026-05-13.md" reads a vault note',
    '"remember ..." appends to today\'s daily note',
    '"follow up ..." appends a follow-up to today\'s daily note',
    '"linkedin <topic>" generates a scored LinkedIn post + image + adds to content calendar',
  ].join('\n- ');
}

async function handleGoogleChatCommand(user, text, { spaceName = '' } = {}) {
  if (!text) return helpText();
  const lower = text.toLowerCase();

  if (lower === 'help') return helpText();

  if (lower === 'briefing' || lower === 'brief') {
    const events = await fetchTodayCalendarEvents(user);
    return buildBriefingText(user, events) || '_No open items._';
  }

  if (lower === 'today' || lower === 'daily') {
    const note = readNote(`Daily/${todayIso()}.md`);
    return note ? `${note.path}\n\n${note.content.slice(0, 3000)}` : `No daily note for ${todayIso()}.`;
  }

  if (lower.startsWith('search ') || lower.startsWith('find ')) {
    const query = text.replace(/^(search|find)\s+/i, '').trim();
    if (!query) return 'Search for what? Example: search Dad physio';
    const results = searchNotes({ query, limit: 5 });
    if (!results.length) return `No vault matches for: ${query}`;
    return results.map((r, i) => `${i + 1}. ${r.path}\n${(r.excerpt || '').slice(0, 280)}`).join('\n\n');
  }

  if (lower.startsWith('read ')) {
    const notePath = text.slice(5).trim();
    if (!notePath) return 'Read which note? Example: read Daily/2026-05-13.md';
    const note = readNote(notePath);
    return note ? `${note.path}\n\n${note.content.slice(0, 3000)}` : `No such vault note: ${notePath}`;
  }

  if (lower.startsWith('remember ') || lower.startsWith('follow up ')) {
    const isFollowUp = lower.startsWith('follow up ');
    const body = text.slice(isFollowUp ? 10 : 9).trim();
    if (!body) return 'Append what?';
    const section = isFollowUp ? 'Follow-ups' : 'Remembered';
    writeNote({
      notePath: `Daily/${todayIso()}.md`,
      mode: 'append',
      content: `\n## ${section}\n- ${body}\n`,
    });
    try {
      await processCrmCommand(user, isFollowUp ? `follow up: ${body}` : body, 'google-chat');
    } catch (err) {
      console.warn('[google-chat] CRM side-write skipped:', err.message);
    }
    return `Added to Daily/${todayIso()}.md`;
  }

  if (lower.startsWith('linkedin ') || lower.startsWith('content ')) {
    const topic = text.replace(/^(linkedin|content)\s+/i, '').trim();
    if (!topic) return 'What topic? e.g. "linkedin Microsoft Teams new AI feature"';
    const { runPipeline } = require('../lib/linkedin-pipeline');

    setImmediate(async () => {
      try {
        const result = await runPipeline(user, topic, s => console.log('[linkedin]', s));
        const sc = result.score || {};
        const overall = sc.overall_score || '?';
        const verdict = sc.recruiter_value || '';
        const emoji = overall >= 4 ? '🟢' : overall >= 3 ? '🟡' : '🔴';
        const postText = result.refinedDraft || result.draft;
        const lines = [
          `✅ *LinkedIn post ready — ${topic}*`,
          '',
          postText,
          '',
          `${emoji} *${overall}/5* ${verdict}`,
        ];
        const topFix1 = sc.top_fixes?.[0];
        if (topFix1) lines.push(`_Top fix: ${topFix1.problem} → ${topFix1.fix}_`);
        if (sc.recruiter_perspective) lines.push(`_${sc.recruiter_perspective}_`);
        if (result.carouselUrl) lines.push(`📄 Carousel: ${result.carouselUrl}`);
        if (result.sheetUrl) lines.push(`📋 ${result.sheetUrl}`);
        await postToGoogleChatSpace(spaceName, lines.join('\n'));
      } catch (err) {
        console.error('[linkedin] pipeline error:', err);
        await postToGoogleChatSpace(spaceName, `❌ LinkedIn pipeline failed: ${err.message}`);
      }
    });

    return `Working on a LinkedIn post about *${topic}*. I'll post the result here when ready (~30 seconds).`;
  }

  const result = await processCrmCommand(user, text, 'google-chat');
  return result.ok ? result.message : result.message || 'Could not process that note.';
}

// ── CRM endpoints ─────────────────────────────────────────────────────────────
router.get('/api/crm/contacts', requireAuth, (req, res) => {
  const contacts = listContacts(req.hubUser);
  res.json(contacts);
});

router.get('/api/crm/briefing', requireAuth, async (req, res) => {
  try {
    const events = await fetchTodayCalendarEvents(req.hubUser);
    const text = buildBriefingText(req.hubUser, events);
    res.json({ ok: true, text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Direct Google Chat HTTP endpoint. This bypasses Apps Script entirely:
// configure Google Chat API connection settings to HTTP endpoint URL:
// https://dchat.mclellan.scot/api/google-chat/hermes
router.post('/api/google-chat/hermes', writeLimiter, async (req, res) => {
  const authed = await verifyGoogleChatRequest(req);
  if (!authed) return res.status(401).json({ error: 'Unauthorized' });

  const event = req.body?.chat || req.body || {};
  const type = event.type || '';
  const message = event.message || event.messagePayload?.message || {};
  const user = process.env.GOOGLE_CHAT_USER || req.hubUser || 'douglas';

  try {
    if (type === 'ADDED_TO_SPACE' || event.addedToSpacePayload) {
      return res.json(googleChatReply(req, 'McLellan Hermes connected.\n\n- ' + helpText()));
    }

    if (type === 'REMOVED_FROM_SPACE' || event.removedFromSpacePayload) {
      console.log('[google-chat] removed from space', event.space?.name || '');
      return res.json({});
    }

    const spaceName = event.space?.name || '';
    const text = cleanGoogleChatText(message.argumentText || message.text || '');
    const reply = await handleGoogleChatCommand(user, text, { spaceName });
    console.log(`[google-chat] handled ${type || 'event'} addon=${isGoogleWorkspaceAddOnRequest(req)} text_chars=${text.length} reply_chars=${String(reply || '').length}`);
    return res.json(googleChatReply(req, reply));
  } catch (err) {
    console.error('[google-chat]', err);
    return res.json(googleChatReply(req, 'Error: ' + err.message));
  }
});

// Hermes (or any external agent) posts a /crm note here
// Secured by a shared secret: Authorization: Bearer <HERMES_WEBHOOK_SECRET>
router.post('/api/crm/webhook', writeLimiter, async (req, res) => {
  const secret = process.env.HERMES_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Webhook not configured' });
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const { text, source = 'hermes', dedup_key } = req.body;
  const user = req.hubUser || req.body.user;
  if (!text || !user) return res.status(400).json({ error: 'text and user required' });

  // Dedup: reject retries from the same message ID within 5 minutes
  if (dedup_key) {
    const hub = db.hub();
    const dedupCtxKey = `_dedup_${dedup_key.replace(/[^a-z0-9_/-]/gi, '_')}`;
    const existing = hub.prepare('SELECT value FROM crm_context WHERE user = ? AND key = ?').get(user, dedupCtxKey);
    if (existing && (Date.now() - parseInt(existing.value)) < 5 * 60 * 1000) {
      return res.json({ ok: true, message: 'Duplicate ignored' });
    }
    hub.prepare(`INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, ?, ?)
      ON CONFLICT(user, key) DO UPDATE SET value = excluded.value`)
      .run(uuid(), user, dedupCtxKey, Date.now().toString());
  }

  try {
    const result = await processCrmCommand(user, text, source);
    res.json(result);
  } catch (err) {
    console.error('[crm webhook]', err);
    res.status(500).json({ error: err.message });
  }
});

// On-demand briefing push (callable from Google Chat bot or Hermes)
router.post('/api/crm/briefing-push', writeLimiter, async (req, res) => {
  const secret = process.env.HERMES_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Not configured' });
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const user = req.hubUser || req.body.user;
  if (!user) return res.status(400).json({ error: 'user required' });

  try {
    const { sendDailyBriefing } = require('../lib/crm');
    const hub = db.hub();
    const existing = hub.prepare(
      `SELECT id FROM crm_context WHERE user = ? AND key = '_briefing_push_lock' AND CAST(value AS INTEGER) > ?`
    ).get(user, Date.now() - 5 * 60 * 1000);
    if (existing) return res.json({ ok: true, message: 'Briefing already sent recently' });

    hub.prepare(`INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, '_briefing_push_lock', ?)
      ON CONFLICT(user, key) DO UPDATE SET value = excluded.value`)
      .run(uuid(), user, Date.now().toString());

    res.json({ ok: true, message: 'Briefing push started' });
    sendDailyBriefing(user).catch(err => console.error('[crm briefing-push]', err));
  } catch (err) {
    console.error('[crm briefing-push]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── CRM view page ─────────────────────────────────────────────────────────────
router.get('/crm', requireAuth, (req, res) => {
  const contacts = listContacts(req.hubUser);
  res.render('hub/crm', { user: req.hubUser, contacts });
});

router.post('/api/crm/contacts/:id/delete', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  hub.prepare('DELETE FROM crm_facts WHERE contact_id = ?').run(contact.id);
  hub.prepare('DELETE FROM contacts WHERE id = ?').run(contact.id);
  res.json({ ok: true });
});

router.post('/api/crm/facts/:id/delete', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const result = db.hub().prepare('DELETE FROM crm_facts WHERE id = ? AND user = ?').run(req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/api/crm/note', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  try {
    const result = await processCrmCommand(req.hubUser, text.trim(), 'hub-ui');
    res.json(result);
  } catch (err) {
    console.error('[crm note]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
