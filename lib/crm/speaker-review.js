'use strict';
const { createHash } = require('crypto');

// Deliberately bounded: unsupported evidence must be reviewed rather than guessed.
function review(payload, transcript) {
  let turns = [];
  if (Object.hasOwn(payload.data || {}, 'content')) {
    const content = payload.data.content;
    if (Array.isArray(content)) turns = content.map(x => {
      if (!x || typeof x.text !== 'string' || !x.text.trim()) return null;
      if (x.speakerIndex !== undefined && (!Number.isInteger(x.speakerIndex) || x.speakerIndex < 0)) return null;
      if (x.speaker !== undefined && (typeof x.speaker !== 'string' || !x.speaker.trim())) return null;
      const key = x.speakerIndex !== undefined ? `index:${x.speakerIndex}` : typeof x.speaker === 'string' ? `label:${x.speaker}` : null;
      return key ? { key, label: x.speaker || `Speaker ${x.speakerIndex}`, text: x.text } : null;
    });
  } else if (typeof transcript === 'string') {
    for (const line of transcript.split('\n')) {
      if (!line.trim()) continue;
      const match = /^([\p{L}\p{N}][\p{L}\p{N} ._'’-]{0,79}):[ \t]+(\S.*)$/u.exec(line);
      if (match) turns.push({ key: `label:${match[1]}`, label: match[1], text: match[2] });
      else if (turns.length) turns[turns.length - 1].text += '\n' + line;
      else return blocked();
    }
  }
  if (!turns.length || turns.some(x => !x)) return blocked();
  const speakers = [...new Set(turns.map(x => x.key))].map(key => ({ key, label: turns.find(x => x.key === key).label, previews: turns.filter(x => x.key === key).slice(0, 3).map(x => x.text.slice(0, 400)) }));
  if (speakers.length > 50) return blocked();
  return { speakers, turns, revision: createHash('sha256').update(JSON.stringify([payload, turns])).digest('hex') };
}
function blocked() { return { speakers: [], turns: [], revision: '', reason: 'No supported, complete speaker attribution. Keep held or Ignore; a labelled transcript is required.' }; }
function release(review, form) {
  const fail = () => { const e = new Error('Name every speaker using the current review form before release'); e.status = 400; throw e; };
  if (!review.speakers.length || !form || form.revision !== review.revision || !Array.isArray(form.names) || form.names.length !== review.speakers.length) fail();
  const names = form.names.map(name => {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || /[\r\n\u2028\u2029\x00-\x1f:]/.test(name) || /^(speaker|unknown|unidentified)(\s*\d+)?$/i.test(name.trim())) fail();
    return name.trim();
  });
  const mapping = review.speakers.map((s, i) => ({ key: s.key, name: names[i] }));
  const byKey = new Map(mapping.map(x => [x.key, x.name]));
  const parts = [];
  for (const turn of review.turns) {
    const prefix = `${byKey.get(turn.key)}: `;
    let remaining = turn.text.replace(/\r\n?|[\u2028\u2029]/g, '\n');
    // Each independently read source repeats attribution, including cut turns.
    while (remaining.length) {
      let end = Math.min(3500, remaining.length);
      if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
      const fragment = prefix + remaining.slice(0, end).replace(/\n/g, '\n    ');
      const last = parts.length - 1;
      if (last >= 0 && parts[last].length + 2 + fragment.length <= 20000) parts[last] += '\n\n' + fragment;
      else parts.push(fragment);
      remaining = remaining.slice(end);
    }
  }
  return { mapping, parts, text: parts.join('\n\n') };
}
module.exports = { review, release };
