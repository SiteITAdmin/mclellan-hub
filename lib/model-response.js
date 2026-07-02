'use strict';

function parseModelObject(content, defaults, label = 'AI response') {
  let value = content;
  if (typeof content === 'string') {
    // Some models wrap JSON in markdown fences even with response_format: json_object set.
    const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try {
      value = JSON.parse(stripped);
    } catch (err) {
      throw new Error(`${label} was not valid JSON: ${err.message}`);
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return { ...defaults, ...value };
}

module.exports = { parseModelObject };
