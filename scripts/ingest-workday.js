#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function usage() {
  console.log(`Usage:
  node scripts/ingest-workday.js --transcript path/to/transcript.txt [--title "Drive home"] [--user douglas]
  node scripts/ingest-workday.js --audio path/to/audio.m4a [--title "Drive home"] [--user douglas]

Options:
  --transcript <path>  Text transcript to ingest.
  --audio <path>       Audio file to transcribe, then ingest.
  --title <text>       Note title. Defaults to "Workday interview YYYY-MM-DD".
  --user <name>        Hub user. Defaults to douglas.
  --model <key>        Hub model key for narrative cleanup. Defaults to WORKDAY_NARRATIVE_MODEL or free.
  --project <slug>     Project slug. Defaults to workday.
  --no-synthadoc       Save to dchat/vault without queueing Synthadoc ingest.
  --help               Show this help.
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--no-synthadoc') args.synthadoc = '0';
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      args[key] = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function guessMime(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.webm') return 'audio/webm';
  if (ext === '.ogg') return 'audio/ogg';
  return 'application/octet-stream';
}

(async () => {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      usage();
      return;
    }
    if (!args.transcript && !args.audio) {
      usage();
      process.exitCode = 1;
      return;
    }
    if (args.transcript && args.audio) {
      throw new Error('Use either --transcript or --audio, not both.');
    }

    try { require('dotenv').config(); } catch (_) {}
    const { ingestWorkdayInterview } = require('../lib/workday-ingest');

    let transcript = '';
    let audioBuffer = null;
    let audioFilename = null;
    let audioMimetype = null;

    if (args.transcript) {
      transcript = fs.readFileSync(path.resolve(args.transcript), 'utf8');
    }
    if (args.audio) {
      audioFilename = path.resolve(args.audio);
      audioBuffer = fs.readFileSync(audioFilename);
      audioMimetype = guessMime(audioFilename);
    }

    const result = await ingestWorkdayInterview({
      user: args.user || 'douglas',
      transcript,
      audioBuffer,
      audioFilename,
      audioMimetype,
      title: args.title,
      source: args.audio ? 'cli-audio' : 'cli-transcript',
      projectSlug: args.project || 'workday',
      model: args.model,
      synthadoc: args.synthadoc !== '0',
    });

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`ingest-workday: ${err.message}`);
    process.exitCode = 1;
  }
})();
