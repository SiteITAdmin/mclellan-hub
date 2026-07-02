'use strict';

// Escape raw control characters that appear INSIDE JSON string literals.
// Models routinely emit multi-paragraph field values with literal newlines/tabs
// rather than \n/\t, which is invalid JSON and makes JSON.parse throw
// "Bad control character in string literal". We walk the text tracking string
// context (respecting backslash escapes) and escape only control chars that sit
// inside a string — structural whitespace between tokens is left untouched.
function escapeControlCharsInStrings(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString && ch < ' ') {
      if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
      continue;
    }
    out += ch;
  }
  return out;
}

// Repair unescaped double quotes inside string values, e.g.
//   {"text": "He said "no" to that"}
// The stray quote closes the string early and JSON.parse throws
// "Expected ',' or '}' after property value" (or the array/key variants) at the
// first token after the premature close. We use the position in the parse error
// to find the quote that ended the string, escape it, and retry — each pass
// fixes one quote, so a value with several needs a few iterations.
function parseRepairingUnescapedQuotes(text) {
  const isEscaped = (s, idx) => {
    let backslashes = 0;
    while (idx - 1 - backslashes >= 0 && s[idx - 1 - backslashes] === '\\') backslashes++;
    return backslashes % 2 === 1;
  };
  let current = text;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return JSON.parse(current);
    } catch (err) {
      const match = /in JSON at position (\d+)/.exec(err.message);
      if (!match) throw err;
      const errPos = Number(match[1]);
      // The quote that prematurely closed the string is the nearest unescaped
      // double quote at or before the error position.
      let q = Math.min(errPos, current.length - 1);
      while (q >= 0 && (current[q] !== '"' || isEscaped(current, q))) q--;
      if (q < 0) throw err;
      current = current.slice(0, q) + '\\"' + current.slice(q + 1);
    }
  }
  throw new Error('Gave up repairing unescaped quotes after 200 passes');
}

function parseModelObject(content, defaults, label = 'AI response') {
  let value = content;
  if (typeof content === 'string') {
    // Some models wrap JSON in markdown fences even with response_format: json_object set.
    const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try {
      value = JSON.parse(stripped);
    } catch (err) {
      // Common model failures, repaired in order: raw control characters inside
      // string values, then unescaped double quotes inside string values.
      try {
        value = JSON.parse(escapeControlCharsInStrings(stripped));
      } catch (_) {
        try {
          value = parseRepairingUnescapedQuotes(escapeControlCharsInStrings(stripped));
        } catch (_2) {
          throw new Error(`${label} was not valid JSON: ${err.message}`);
        }
      }
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return { ...defaults, ...value };
}

module.exports = { parseModelObject, escapeControlCharsInStrings };
