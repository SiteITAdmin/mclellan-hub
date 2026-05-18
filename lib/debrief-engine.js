'use strict';

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { vaultRoot } = require('./obsidian-vault');

const MISTRAL_KEY  = process.env.MISTRAL_API_KEY;
const STT_URL      = 'https://api.mistral.ai/v1/audio/transcriptions';
const TTS_URL      = 'https://api.mistral.ai/v1/audio/speech';
const CHAT_URL     = 'https://api.mistral.ai/v1/chat/completions';

const STT_MODEL    = 'voxtral-mini-2507';
const TTS_MODEL    = 'voxtral-mini-tts-latest';
const TTS_VOICE    = 'gb_oliver_neutral';
const CHAT_MODEL   = 'mistral-small-latest';

const END_PHRASE   = /that(?:'s|'ll| will| would) do(?: for now)?|that'?s enough|done for now|finish(ed)? (the |this )?(debrief|session)/i;

function requireKey() {
  if (!MISTRAL_KEY) throw new Error('MISTRAL_API_KEY not set');
}

// ── STT ───────────────────────────────────────────────────────────────────────
async function transcribeAudio(audioBuffer, mimeType = 'audio/webm') {
  requireKey();
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType }), 'audio.webm');
  form.append('model', STT_MODEL);
  const resp = await globalThis.fetch(STT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MISTRAL_KEY}` },
    body: form,
  });
  if (!resp.ok) throw new Error(`STT ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.text || '';
}

// ── TTS ───────────────────────────────────────────────────────────────────────
async function textToSpeech(text) {
  requireKey();
  const resp = await fetch(TTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MISTRAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, input: text, voice: TTS_VOICE }),
  });
  if (!resp.ok) throw new Error(`TTS ${resp.status}: ${await resp.text()}`);
  return Buffer.from(await resp.arrayBuffer());
}

// ── Chat ──────────────────────────────────────────────────────────────────────
const SYSTEM = `You are a calm, thoughtful personal debrief assistant. Help the user reflect on their day through focused conversation. Ask one clear question at a time — maximum two sentences, since your words will be spoken aloud. Build naturally on what they share. Occasionally offer a brief observation or idea rather than always asking a question. Never summarise back what they just said.`;

async function generateQuestion(history) {
  requireKey();
  const resp = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MISTRAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [{ role: 'system', content: SYSTEM }, ...history],
      temperature: 0.7,
      max_tokens: 80,
    }),
  });
  if (!resp.ok) throw new Error(`Chat ${resp.status}: ${await resp.text()}`);
  return (await resp.json()).choices[0].message.content.trim();
}

function openingPrompt(userName = 'Douglas', calendarEvents = []) {
  const h = new Date().getHours();
  const time = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  const eventLine = calendarEvents.length
    ? `Their calendar today includes: ${calendarEvents.map(e => e.summary || e.title).join(', ')}.`
    : '';
  return `You are opening a personal voice debrief session for ${userName} this ${time}. ${eventLine} Greet them warmly by first name, mention a calendar event if there is one, and ask one open question to get them talking. Keep it to 2 sentences maximum — this will be spoken aloud.`;
}

// ── Process & save ────────────────────────────────────────────────────────────
async function processAndSave({ mode, transcript, exchanges }) {
  requireKey();

  const isMeeting  = mode === 'meeting';
  const isDump     = mode === 'dump';
  const raw = isDump || isMeeting
    ? transcript
    : exchanges.map(e => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n');

  const extractPrompt = isMeeting
    ? `Extract the following from this meeting debrief. Return ONLY valid JSON:
{
  "summary": "2-3 sentence summary of the meeting",
  "attendees": ["names of people or organisations mentioned"],
  "tags": ["3-7 lowercase topic tags"],
  "decisions": ["key decisions made — empty array if none"],
  "action_items": ["action items, include owner name if mentioned — empty array if none"],
  "key_points": ["3-5 key points"]
}

Debrief:
${raw.slice(0, 3000)}`
    : `Extract the following from this personal debrief. Return ONLY valid JSON:
{
  "summary": "2-3 sentence summary",
  "tags": ["3-7 lowercase topic tags"],
  "action_items": ["any action items mentioned — empty array if none"],
  "key_points": ["3-5 key points as short strings"]
}

Debrief:
${raw.slice(0, 3000)}`;

  let meta = { summary: '', tags: [], action_items: [], key_points: [] };
  try {
    const resp = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${MISTRAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: extractPrompt }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
    });
    if (resp.ok) {
      const d = await resp.json();
      meta = JSON.parse(d.choices[0].message.content);
    }
  } catch {}

  const now = new Date();
  const dateStr  = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const fileDate = now.toISOString().slice(0, 10);
  const fileTime = now.toTimeString().slice(0, 5).replace(':', '-');

  let baseTag, saveDir;
  if (isMeeting) {
    baseTag = 'meeting';
    saveDir = path.join(vaultRoot(), 'Meetings');
  } else if (isDump) {
    baseTag = 'voice-dump';
    saveDir = path.join(vaultRoot(), 'Journal');
  } else {
    baseTag = 'reflection';
    saveDir = path.join(vaultRoot(), 'Journal');
  }

  const tags = [...new Set([baseTag, ...(meta.tags || [])])];

  let md = `---\ndate: ${fileDate}\ntags:\n${tags.map(t => `  - ${t}`).join('\n')}\nmode: ${mode}\n---\n\n`;

  if (isMeeting) {
    md += `# Meeting Debrief — ${dateStr}\n\n`;
    if (meta.summary)                md += `## Summary\n\n${meta.summary}\n\n`;
    if (meta.attendees?.length)      md += `## Attendees\n\n${meta.attendees.map(a => `- ${a}`).join('\n')}\n\n`;
    if (meta.decisions?.length)      md += `## Decisions\n\n${meta.decisions.map(d => `- ${d}`).join('\n')}\n\n`;
    if (meta.action_items?.length)   md += `## Action Items\n\n${meta.action_items.map(a => `- [ ] ${a}`).join('\n')}\n\n`;
    if (meta.key_points?.length)     md += `## Notes\n\n${meta.key_points.map(p => `- ${p}`).join('\n')}\n\n`;
    md += `## Transcript\n\n${transcript}\n`;
  } else {
    md += `# Debrief — ${dateStr}\n\n`;
    if (meta.summary)                md += `## Summary\n\n${meta.summary}\n\n`;
    if (meta.key_points?.length)     md += `## Key Points\n\n${meta.key_points.map(p => `- ${p}`).join('\n')}\n\n`;
    if (meta.action_items?.length)   md += `## Action Items\n\n${meta.action_items.map(a => `- [ ] ${a}`).join('\n')}\n\n`;

    if (isDump) {
      md += `## Transcript\n\n${transcript}\n`;
    } else {
      md += `## Conversation\n\n`;
      for (const e of exchanges) {
        md += `**Q:** ${e.question}\n\n**A:** ${e.answer}\n\n---\n\n`;
      }
    }
  }

  fs.mkdirSync(saveDir, { recursive: true });
  const filename = `${fileDate}-${fileTime}-debrief-${mode}.md`;
  fs.writeFileSync(path.join(saveDir, filename), md, 'utf8');

  return { filename, tags, summary: meta.summary };
}

function isEndPhrase(text) {
  return END_PHRASE.test(text || '');
}

module.exports = { transcribeAudio, textToSpeech, generateQuestion, openingPrompt, processAndSave, isEndPhrase };
