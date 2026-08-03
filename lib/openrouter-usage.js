'use strict';

// Compatibility shim. OpenRouter usage logging is retired; new rows write
// through model-usage with subscription/local endpoints. Historical
// request_logs rows with endpoint='openrouter' are preserved for audit.

module.exports = require('./model-usage');
