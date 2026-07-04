'use strict';

const fetch = require('./fetch');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { TASK_CODES, openRouterHeaders } = require('./openrouter-attribution');
const { logOpenRouterUsage } = require('./openrouter-usage');

const DEFAULT_TTS_MODEL = 'hexgrad/kokoro-82m';
const DEFAULT_TTS_VOICE = 'bf_emma';

// The speech endpoint returns raw audio bytes, so there is no usage block —
// cost has to be fetched afterwards from the generation endpoint.
async function logTtsCost({ generationId, user, model, chars, durationMs }) {
  let costUsd = 0;
  let tokensIn = 0;
  if (generationId) {
    try {
      await new Promise(r => setTimeout(r, 2000));
      const res = await fetch(
        `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`,
        { headers: openRouterHeaders(TASK_CODES.DEBRIEF), timeout: 10000 },
      );
      if (res.ok) {
        const data = (await res.json())?.data;
        costUsd = Number(data?.total_cost || 0);
        tokensIn = Number(data?.tokens_prompt || 0);
      }
    } catch (_) {}
  }
  logOpenRouterUsage({
    user,
    feature: 'debrief-tts',
    modelKey: 'debrief_tts',
    modelId: model,
    tokensIn: tokensIn || chars,
    costUsd,
    durationMs,
    taskCode: TASK_CODES.DEBRIEF,
  });
}

async function speechRequest({ model, voice, input, user, started }) {
  const res = await fetch('https://openrouter.ai/api/v1/audio/speech', {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.DEBRIEF),
    body: JSON.stringify({ model, input, voice, response_format: 'mp3' }),
    timeout: 30000,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logOpenRouterUsage({
      user,
      feature: 'debrief-tts',
      modelKey: 'debrief_tts',
      modelId: model,
      durationMs: Date.now() - started,
      status: 'error',
      errorMsg: `TTS ${res.status}: ${body.slice(0, 200)}`,
      taskCode: TASK_CODES.DEBRIEF,
    });
    throw new Error(`TTS failed (${res.status})`);
  }
  return {
    audio: Buffer.from(await res.arrayBuffer()),
    generationId: res.headers.get('x-generation-id'),
  };
}

// Synthesizes speech via OpenRouter /audio/speech. Returns an MP3 Buffer.
// Model and voice are admin slots (debrief_tts / debrief_tts_voice).
// Verified 4 Jul 2026: kokoro-82m via OpenRouter only speaks the FIRST
// sentence of a multi-sentence input, so requests go per-sentence (parallel)
// and the MP3 frames are concatenated — same bitrate/samplerate, players
// handle the joined stream fine. Single-sentence inputs are one request.
async function synthesizeSpeech({ text, user = 'system' }) {
  const model = getSystemModelId('debrief_tts', 'system', DEFAULT_TTS_MODEL);
  const voice = (getSystemPrompt('debrief_tts_voice', 'system', DEFAULT_TTS_VOICE) || DEFAULT_TTS_VOICE).trim();
  const started = Date.now();

  const sentences = (text.match(/[^.!?\n]+[.!?]*\s*/g) || [text])
    .map(s => s.trim()).filter(Boolean);

  const parts = await Promise.all(
    sentences.map(input => speechRequest({ model, voice, input, user, started })),
  );

  setImmediate(() => {
    logTtsCost({
      generationId: parts[0]?.generationId,
      user, model,
      chars: text.length,
      durationMs: Date.now() - started,
    }).catch(() => {});
  });
  return Buffer.concat(parts.map(p => p.audio));
}

module.exports = { synthesizeSpeech, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE };
