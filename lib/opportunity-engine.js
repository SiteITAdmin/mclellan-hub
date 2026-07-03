'use strict';

/**
 * Opportunity signals.
 *
 * These are source-backed, short-lived observations such as retail offers or
 * local-only discounts. They are not actions by themselves. The suggestion
 * engine decides whether current context makes any signal worth surfacing.
 */

const fetch = require('./fetch');
const db = require('./db');
const { uuid } = require('./id');
const { upsertAtom } = require('./atoms');
const { getSystemModelId } = require('./settings');
const { TASK_CODES, openRouterHeaders, taskCodeForFeature } = require('./openrouter-attribution');
const { logUsageFromResponse } = require('./openrouter-usage');
const { parseModelObject } = require('./model-response');

const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OFFER_LABELS = new Set(['commerce/offers']);
const OFFER_HINT_RE = /\b(offer|offers|saving|savings|discount|deal|deals|voucher|coupon|membership|member price|valid until|ends|expires|£|gbp|€|eur)\b/i;
const RETAIL_HINT_RE = /\b(co-?op|coop|tesco|sainsbury|lidl|aldi|boots|superdrug|m&s|marks and spencer|retail|shop|store|supermarket)\b/i;
const MAX_BODY_CHARS = 5000;

function now() { return Math.floor(Date.now() / 1000); }

function dublinTodayIso() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
}

function normalize(value) {
  return String(value || '').trim();
}

function normalizeLower(value) {
  return normalize(value).toLowerCase();
}

function cleanIsoDate(value) {
  const text = normalize(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function isOfferLabel(label) {
  return OFFER_LABELS.has(normalizeLower(label));
}

function looksLikeOpportunityEmail(email, sourceLabel = '') {
  if (isOfferLabel(sourceLabel)) return true;
  const haystack = [
    email.fromName,
    email.fromEmail,
    email.subject,
    String(email.bodyText || '').slice(0, 800),
  ].filter(Boolean).join('\n');
  return OFFER_HINT_RE.test(haystack) && RETAIL_HINT_RE.test(haystack);
}

async function llmJson(user, feature, prompt, defaults) {
  const model = getSystemModelId('opportunity_extractor', 'system', 'google/gemini-2.5-flash');
  const taskCode = taskCodeForFeature(feature, TASK_CODES.SUGGESTIONS);
  const started = Date.now();
  const resp = await fetch(OR_URL, {
    method: 'POST',
    headers: openRouterHeaders(taskCode),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });
  if (!resp.ok) throw new Error(`OpenRouter ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  logUsageFromResponse({
    user,
    feature,
    modelKey: 'opportunity_extractor',
    fallbackModelId: model,
    data,
    taskCode,
    durationMs: Date.now() - started,
  });
  return parseModelObject(
    data.choices?.[0]?.message?.content,
    defaults,
    'Opportunity extractor response'
  );
}

function signalValue(signal) {
  const bits = [
    signal.summary,
    signal.geography ? `Geography: ${signal.geography}` : '',
    signal.currency ? `Currency: ${signal.currency}` : '',
    signal.valid_until ? `Valid until: ${signal.valid_until}` : '',
  ].filter(Boolean);
  return bits.join(' | ').slice(0, 1000);
}

function rowToSignal(row) {
  let details = {};
  try { details = JSON.parse(row.details_json || '{}'); } catch (_) {}
  return { ...row, details };
}

function upsertOpportunityAtom(user, signal) {
  return upsertAtom(user, {
    subjectKind: 'opportunity',
    subjectId: null,
    subjectLabel: signal.title,
    predicate: signal.signal_type || 'opportunity',
    value: signalValue(signal),
    sourceRef: { kind: 'opportunity_signal', id: signal.id },
    confidence: 0.75,
    status: signal.status || 'active',
    derivedBy: 'opportunity_extractor',
  });
}

function storeOpportunitySignal(user, email, rawOffer, { sourceLabel = '' } = {}) {
  const title = normalize(rawOffer.title || rawOffer.headline);
  const summary = normalize(rawOffer.summary || rawOffer.description || rawOffer.offer);
  if (!title || !summary) return null;

  const signalType = normalize(rawOffer.signal_type || rawOffer.type || 'retail_offer').slice(0, 80);
  const actor = normalize(rawOffer.actor || rawOffer.retailer || rawOffer.merchant || email.fromName).slice(0, 160);
  const geography = normalize(rawOffer.geography || rawOffer.location || rawOffer.country).slice(0, 160);
  const currency = normalize(rawOffer.currency).toUpperCase().slice(0, 12) || null;
  const validFrom = cleanIsoDate(rawOffer.valid_from || rawOffer.starts);
  const validUntil = cleanIsoDate(rawOffer.valid_until || rawOffer.ends || rawOffer.expires);
  const details = {
    items: Array.isArray(rawOffer.items) ? rawOffer.items.slice(0, 12) : [],
    conditions: normalize(rawOffer.conditions || rawOffer.terms).slice(0, 800),
    source_subject: normalize(email.subject).slice(0, 240),
    source_from: normalize(`${email.fromName || ''} <${email.fromEmail || ''}>`).slice(0, 240),
  };
  const hub = db.hub();
  const id = uuid();
  hub.prepare(`
    INSERT OR IGNORE INTO opportunity_signals
      (id, user, signal_type, source_kind, source_id, source_label, title, summary,
       actor, geography, currency, valid_from, valid_until, details_json, observed_at)
    VALUES (?, ?, ?, 'gmail', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, user, signalType, email.id, sourceLabel || null, title.slice(0, 240), summary.slice(0, 1200),
    actor || null, geography || null, currency, validFrom, validUntil, JSON.stringify(details),
    email.receivedAt || now()
  );

  const row = hub.prepare(`
    SELECT * FROM opportunity_signals
    WHERE user = ? AND source_kind = 'gmail' AND source_id = ?
      AND signal_type = ? AND title = ?
    LIMIT 1
  `).get(user, email.id, signalType, title.slice(0, 240));
  if (row) upsertOpportunityAtom(user, row);
  return row ? rowToSignal(row) : null;
}

async function extractOpportunitySignals(user, email, { sourceLabel = '' } = {}) {
  if (!looksLikeOpportunityEmail(email, sourceLabel)) return 0;
  const hub = db.hub();
  const already = hub.prepare(`
    SELECT 1 FROM opportunity_signals
    WHERE user = ? AND source_kind = 'gmail' AND source_id = ?
    LIMIT 1
  `).get(user, email.id);
  if (already) return 0;

  const prompt = `Extract short-lived opportunity signals from this email for Douglas McLellan's personal Hub.

Return ONLY JSON:
{"opportunities":[{"signal_type":"retail_offer","title":"short specific title","summary":"one sentence, grounded in the email","actor":"retailer or sender","geography":"country/region/city where usable, or null","currency":"GBP|EUR|USD|null","valid_from":"YYYY-MM-DD or null","valid_until":"YYYY-MM-DD or null","items":["optional item names"],"conditions":"important limits, or null"}]}

Rules:
- Extract only concrete offers, discounts, coupons, member prices, local opportunities, or time-limited benefits explicitly evidenced by the email.
- For UK retailers and sterling prices, geography should be "UK" or the more specific region if stated.
- Do not extract generic marketing with no usable offer.
- Do not invent dates, prices, geography, or eligibility.
- Empty array is valid if there is no usable opportunity.

Email:
From: ${email.fromName || ''} <${email.fromEmail || ''}>
Subject: ${email.subject || ''}
Hub label: ${sourceLabel || '(none)'}
Received date: ${email.receivedAt ? new Date(email.receivedAt * 1000).toISOString().slice(0, 10) : dublinTodayIso()}

Body:
${String(email.bodyText || '').slice(0, MAX_BODY_CHARS)}`;

  const parsed = await llmJson(user, 'opportunity-extract', prompt, { opportunities: [] });
  const offers = Array.isArray(parsed.opportunities) ? parsed.opportunities : [];
  let inserted = 0;
  for (const offer of offers.slice(0, 8)) {
    const row = storeOpportunitySignal(user, email, offer, { sourceLabel });
    if (row) inserted++;
  }
  return inserted;
}

function expireOpportunitySignals(user) {
  const today = dublinTodayIso();
  return db.hub().prepare(`
    UPDATE opportunity_signals
    SET status = 'expired'
    WHERE user = ?
      AND status = 'active'
      AND valid_until IS NOT NULL
      AND valid_until < ?
  `).run(user, today).changes;
}

function activeOpportunitySignals(user, { maxAgeDays = 45, limit = 80 } = {}) {
  expireOpportunitySignals(user);
  const rows = db.hub().prepare(`
    SELECT * FROM opportunity_signals
    WHERE user = ?
      AND status = 'active'
      AND observed_at >= unixepoch() - (? * 86400)
      AND (valid_until IS NULL OR valid_until >= ?)
    ORDER BY COALESCE(valid_until, '9999-12-31') ASC, observed_at DESC
    LIMIT ?
  `).all(user, maxAgeDays, dublinTodayIso(), limit);
  return rows.map(rowToSignal);
}

module.exports = {
  activeOpportunitySignals,
  expireOpportunitySignals,
  extractOpportunitySignals,
  looksLikeOpportunityEmail,
  storeOpportunitySignal,
};
