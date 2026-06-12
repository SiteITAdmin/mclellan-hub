'use strict';

function parseModelObject(content, defaults, label = 'AI response') {
  let value = content;
  if (typeof content === 'string') {
    try {
      value = JSON.parse(content);
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
