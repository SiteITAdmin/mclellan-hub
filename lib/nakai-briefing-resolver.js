'use strict';

/**
 * Nakai Briefing Resend Resolver
 *
 * Parses a natural-language briefing request from Nakai and resolves it to a
 * stored briefing edition, then resends it via email.
 *
 * Supported request patterns:
 *   "send me briefing 002"
 *   "resend briefing 3"
 *   "send the 21 June briefing"
 *   "can you send me the briefing from 19 June?"
 *   "resend last week's briefing"
 *   "send the previous briefing"
 *   "what briefings do I have?"
 *
 * Entry points:
 *   resolveNakaiBriefingRequest(text)   → { edition, manifest } | { list } | null
 *   resendBriefingFromRequest(text)     → { ok, edition, manifest, skipped } | { ok, list } | { ok: false, reason }
 */

const {
  listStoredBriefings,
  getStoredBriefing,
  sendStoredBriefing,
} = require('../scripts/build-nakai-daily-briefing');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a day+month string like "21 June" or "June 21" into a YYYY-MM-DD slug
 * relative to the current year (or previous year if that date is in the future).
 */
function parseDayMonth(day, monthName) {
  const months = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12',
  };
  const mm = months[monthName.toLowerCase()];
  if (!mm) return null;
  const dd = String(parseInt(day, 10)).padStart(2, '0');
  const now = new Date();
  const year = now.getFullYear();
  const candidate = `${year}-${mm}-${dd}`;
  // If the date is in the future, try the previous year
  return candidate <= now.toLocaleDateString('sv-SE') ? candidate : `${year - 1}-${mm}-${dd}`;
}

/**
 * Find a stored briefing whose date matches a YYYY-MM-DD slug.
 */
function findByDate(briefings, dateSlug) {
  return briefings.find(b => b.date === dateSlug) || null;
}

/**
 * Find a stored briefing by zero-padded or plain edition number.
 */
function findByEdition(briefings, editionRaw) {
  const padded = String(parseInt(editionRaw, 10)).padStart(3, '0');
  return briefings.find(b => b.edition === padded) || null;
}

// ── Request intent detection ──────────────────────────────────────────────────

const MONTH_NAMES = 'january|february|march|april|may|june|july|august|september|october|november|december';

const PATTERNS = [
  // "briefing 002" / "briefing 2" / "edition 3" / "number 003"
  {
    re: /\b(?:briefing|edition|number)\s+(\d{1,3})\b/i,
    resolve: (m, briefings) => findByEdition(briefings, m[1]),
  },
  // "21 June" / "21st June" / "June 21"
  {
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\b`, 'i'),
    resolve: (m, briefings) => findByDate(briefings, parseDayMonth(m[1], m[2])),
  },
  {
    re: new RegExp(`\\b(${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'),
    resolve: (m, briefings) => findByDate(briefings, parseDayMonth(m[2], m[1])),
  },
  // "the previous briefing" / "last briefing" / "previous one"
  {
    re: /\b(?:previous|last|yesterday['']?s?|prior)\s+(?:briefing|one|edition)?\b/i,
    resolve: (_m, briefings) => {
      const sorted = [...briefings].sort((a, b) => b.edition.localeCompare(a.edition));
      return sorted[1] || sorted[0] || null;
    },
  },
  // "the latest" / "most recent" / "today's" — return newest
  {
    re: /\b(?:latest|most\s+recent|newest|today['']?s?|current)\s+(?:briefing|one|edition)?\b/i,
    resolve: (_m, briefings) => {
      const sorted = [...briefings].sort((a, b) => b.edition.localeCompare(a.edition));
      return sorted[0] || null;
    },
  },
];

const LIST_PATTERN = /\b(?:list|what|which|show|available|do\s+i\s+have|have\s+i\s+(?:got|received))\b.*\bbriefing/i;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attempt to resolve a natural-language text request to a stored briefing.
 *
 * Returns one of:
 *   { type: 'briefing', edition, manifest }   — matched a specific briefing
 *   { type: 'list', briefings }               — user asked to list briefings
 *   { type: 'unknown' }                       — could not understand the request
 */
function resolveNakaiBriefingRequest(text) {
  const t = String(text || '');
  const briefings = listStoredBriefings();

  if (LIST_PATTERN.test(t)) {
    return { type: 'list', briefings };
  }

  for (const { re, resolve } of PATTERNS) {
    const m = t.match(re);
    if (m) {
      const found = resolve(m, briefings);
      if (found) {
        const manifest = getStoredBriefing(found.edition);
        return { type: 'briefing', edition: found.edition, manifest };
      }
    }
  }

  return { type: 'unknown' };
}

/**
 * Resolve a natural-language request and, if a briefing is found, resend it.
 *
 * Returns:
 *   { ok: true,  type: 'sent',    edition, manifest }       — sent successfully
 *   { ok: true,  type: 'list',    briefings, summary }      — listed briefings
 *   { ok: false, type: 'unknown', reason }                  — unrecognised request
 *   { ok: false, type: 'error',   reason }                  — send failed
 */
async function resendBriefingFromRequest(text) {
  const resolved = resolveNakaiBriefingRequest(text);

  if (resolved.type === 'list') {
    const lines = resolved.briefings
      .sort((a, b) => a.edition.localeCompare(b.edition))
      .map(b => `  • Briefing ${b.edition} — ${b.label}${b.sentAt ? ' (sent)' : ' (not sent)'}`)
      .join('\n');
    return {
      ok: true,
      type: 'list',
      briefings: resolved.briefings,
      summary: resolved.briefings.length
        ? `Available briefings:\n${lines}`
        : 'No stored briefings found.',
    };
  }

  if (resolved.type === 'unknown') {
    const briefings = listStoredBriefings().sort((a, b) => a.edition.localeCompare(b.edition));
    const hint = briefings.length
      ? `Available: ${briefings.map(b => `Briefing ${b.edition} (${b.label})`).join(', ')}.`
      : 'No stored briefings available.';
    return {
      ok: false,
      type: 'unknown',
      reason: `Could not identify which briefing you wanted. ${hint}`,
    };
  }

  // type === 'briefing'
  try {
    const result = await sendStoredBriefing(resolved.edition, { force: true });
    return {
      ok: true,
      type: 'sent',
      edition: resolved.edition,
      manifest: result.manifest,
    };
  } catch (err) {
    return {
      ok: false,
      type: 'error',
      edition: resolved.edition,
      reason: err.message,
    };
  }
}

module.exports = {
  resolveNakaiBriefingRequest,
  resendBriefingFromRequest,
};
