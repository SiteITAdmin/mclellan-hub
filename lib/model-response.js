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

function parseModelObject(content, defaults, label = 'AI response') {
  let value = content;
  if (typeof content === 'string') {
    // Some models wrap JSON in markdown fences even with response_format: json_object set.
    const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try {
      value = JSON.parse(stripped);
    } catch (err) {
      // Common model failure: raw control characters inside string values. Repair and retry once.
      try {
        value = JSON.parse(escapeControlCharsInStrings(stripped));
      } catch (_) {
        throw new Error(`${label} was not valid JSON: ${err.message}`);
      }
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return { ...defaults, ...value };
}

module.exports = { parseModelObject, escapeControlCharsInStrings };
