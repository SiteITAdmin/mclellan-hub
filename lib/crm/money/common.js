'use strict';

// Shared pieces of Personal money: categories, merchant names, euro formatting.
// Money is a Personal-only tool. Nothing here reads Work sources, and nothing
// written here is ever offered to the knowledge pipeline as a source or fact.

const SPACE = 'personal';

// Order matters: it is the order of the category pickers and the chart legend.
const CATEGORIES = Object.freeze([
  'Groceries', 'Eating out', 'Coffee', 'Transport', 'Fuel', 'Home & utilities', 'Subscriptions',
  'Health', 'Shopping', 'Entertainment', 'Travel', 'Insurance', 'Fees & interest', 'Cash', 'Gifts & charity', 'Other',
]);
// 'spend' counts toward spending totals; income and transfers (own accounts, card payments) never do.
const KINDS = Object.freeze(['spend', 'income', 'transfer']);

// "POS 1234 TESCO STORES 5821 DUBLIN IE 12/11" -> "tesco stores". Used to match
// the same merchant across screenshots, rules, subscriptions and mail.
function normMerchant(text) {
  return String(text || '').toLowerCase()
    .replace(/\b\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?\b/g, ' ')
    .replace(/\b(pos|crd|card|visa|mastercard|debit|purchase|payment|contactless|apple pay|google pay|direct debit|d\/d|sepa|dd|ref|trf)\b/g, ' ')
    .replace(/[*#_/\\|]+/g, ' ')
    .replace(/\b[a-z]*\d[a-z\d]*\b/g, ' ')
    .replace(/\b(dublin|cork|galway|limerick|ie|ireland|ltd|limited|dac|plc|inc|www|com)\b/g, ' ')
    .replace(/[^a-z& ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function eur(cents, { sign = false } = {}) {
  const n = Math.round(Number(cents) || 0), abs = Math.abs(n);
  const body = `€${Math.floor(abs / 100).toLocaleString('en-IE')}.${String(abs % 100).padStart(2, '0')}`;
  return n < 0 ? `-${body}` : sign && n > 0 ? `+${body}` : body;
}

// YYYY-MM-DD in Dublin, today or for an epoch.
function dublinDay(epoch = Math.floor(Date.now() / 1000)) {
  return new Date(epoch * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/Dublin' });
}

function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

const validDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;

// Counted in spending totals.
const SPEND_SQL = "kind = 'spend' AND status != 'ignored' AND amount_cents < 0";

module.exports = { SPACE, CATEGORIES, KINDS, normMerchant, eur, dublinDay, addDays, validDay, SPEND_SQL };
