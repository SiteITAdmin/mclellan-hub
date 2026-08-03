'use strict';

const fetch = require('./fetch');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { TASK_CODES, openRouterHeaders } = require('./openrouter-attribution');
const { logOpenRouterUsage } = require('./openrouter-usage');

const DEFAULT_TTS_MODEL = 'hexgrad/kokoro-82m';
const DEFAULT_TTS_VOICE = 'bf_emma';

// OpenRouter speech models emit 24 kHz, 16-bit, mono PCM.
const PCM_SAMPLE_RATE = 24000;
const PCM_CHANNELS = 1;
const PCM_BITS = 16;

function wrapPcmAsWav(pcm) {
  const blockAlign = PCM_CHANNELS * PCM_BITS / 8;
  const byteRate = PCM_SAMPLE_RATE * blockAlign;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(PCM_CHANNELS, 22);
  h.writeUInt32LE(PCM_SAMPLE_RATE, 24); h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32); h.writeUInt16LE(PCM_BITS, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// The speech endpoint returns raw audio bytes, so there is no usage block —
// cost has to be fetched afterwards from the generation endpoint.
async function logTtsCost({ generationId, user, model, chars, durationMs }) {
  let costUsd = 0;
  let tokensIn = 0;
  if (generationId) {
    try {
      await new Promise(r => setTimeout(r, 2000));
      const res = await fetch(
        `hub-model://v1/generation?id=${encodeURIComponent(generationId)}`,
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
  const res = await fetch('hub-model://v1/audio/speech', {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.DEBRIEF),
    body: JSON.stringify({ model, input, voice, response_format: 'pcm' }),
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

// Synthesizes speech via OpenRouter /audio/speech. Returns a WAV Buffer.
// Model and voice are admin slots (debrief_tts / debrief_tts_voice).
//
// Verified 4-5 Jul 2026: kokoro-82m via OpenRouter only voices the FIRST
// sentence of a multi-sentence input. Concatenating the per-sentence MP3s does
// NOT fix this — CoreAudio (iOS AVAudioPlayer and iOS Safari) stops at the
// first embedded MPEG stream, so only sentence one plays. So each sentence is
// fetched as raw PCM instead, the PCM is concatenated (no per-stream headers
// to trip the decoder), and the whole thing is wrapped in one WAV container —
// which CoreAudio decodes end to end. Requests run in parallel and are
// reassembled in order.
async function synthesizeSpeech({ text, user = 'system' }) {
  const model = getSystemModelId('debrief_tts', 'system', DEFAULT_TTS_MODEL);
  const { PROMPTS } = require('./prompts');
  const voiceDefault = PROMPTS.debrief_tts_voice || DEFAULT_TTS_VOICE;
  const voice = (getSystemPrompt('debrief_tts_voice', 'system', voiceDefault) || voiceDefault).trim();
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
  return wrapPcmAsWav(Buffer.concat(parts.map(p => p.audio)));
}

module.exports = { synthesizeSpeech, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE };
