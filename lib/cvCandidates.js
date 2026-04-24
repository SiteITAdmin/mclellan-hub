const { uuid } = require('./id');

const TERM_PATTERNS = [
  ['Microsoft Purview', /\b(?:Microsoft|MS)\s+Purview\b/gi],
  ['Microsoft 365', /\b(?:Microsoft|M)\s*365\b/gi],
  ['Entra ID', /\b(?:Entra ID|Azure AD)\b/gi],
  ['Power Automate', /\bPower\s+Automate\b/gi],
  ['Power Apps', /\bPower\s+Apps?\b/gi],
  ['Power BI', /\bPower\s+BI\b/gi],
  ['SharePoint', /\bSharePoint\b/gi],
  ['OneDrive', /\bOneDrive\b/gi],
  ['Microsoft Teams', /\b(?:Microsoft\s+)?Teams\b/gi],
  ['Exchange Online', /\bExchange\s+Online\b/gi],
  ['Defender for Office 365', /\bDefender\s+for\s+Office\s+365\b/gi],
  ['Microsoft Defender', /\bMicrosoft\s+Defender\b/gi],
  ['Intune', /\bIntune\b/gi],
  ['Microsoft Sentinel', /\b(?:Microsoft\s+)?Sentinel\b/gi],
  ['DMARC', /\bDMARC\b/g],
  ['DKIM', /\bDKIM\b/g],
  ['SPF', /\bSPF\b/g],
  ['Conditional Access', /\bConditional\s+Access\b/gi],
  ['Data Loss Prevention', /\bData\s+Loss\s+Prevention\b/gi],
  ['Information Protection', /\bInformation\s+Protection\b/gi],
  ['eDiscovery', /\beDiscovery\b/gi],
  ['Compliance Manager', /\bCompliance\s+Manager\b/gi],
  ['Defender for Cloud Apps', /\bDefender\s+for\s+Cloud\s+Apps\b/gi],
  ['AWS', /\bAWS\b/g],
  ['Kubernetes', /\bKubernetes\b/gi],
  ['Okta', /\bOkta\b/gi],
  ['Google Workspace', /\bGoogle\s+Workspace\b/gi],
  ['Jira', /\bJira\b/gi],
  ['Confluence', /\bConfluence\b/gi],
  ['Slack', /\bSlack\b/gi],
  ['DOMO', /\bDOMO\b/g],
];

const GENERIC_ALLOWLIST = new Set([
  'purview', 'microsoft', 'entra', 'sharepoint', 'onedrive', 'teams',
  'power', 'automate', 'apps', 'defender', 'intune', 'sentinel',
  'dmarc', 'dkim', 'spf', 'compliance', 'ediscovery', 'governance',
  'identity', 'security', 'powershell', 'azure', 'workspace', 'okta',
  'aws', 'kubernetes', 'domo', 'jira', 'confluence', 'slack',
]);

const GENERIC_STOPWORDS = new Set([
  'Douglas', 'McLellan', 'Beacon', 'Cricket', 'Ireland', 'Hospital',
  'Executive', 'Summary', 'Candidate', 'Analysis', 'Role', 'Description',
  'LinkedIn', 'Portfolio', 'Present', 'Project', 'Technology',
]);

function normalizeTerm(term) {
  return String(term || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function clipSnippet(text, matchIndex, matchLength) {
  const start = Math.max(0, matchIndex - 80);
  const end = Math.min(text.length, matchIndex + matchLength + 80);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function extractCandidatesFromText(text) {
  const found = new Map();
  const body = String(text || '');

  for (const [label, regex] of TERM_PATTERNS) {
    regex.lastIndex = 0;
    const match = regex.exec(body);
    if (!match) continue;
    found.set(normalizeTerm(label), {
      term: label,
      snippet: clipSnippet(body, match.index, match[0].length),
    });
  }

  const genericRegex = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}|[A-Z]{2,}(?:\s+[A-Z][a-z]+){0,2}|[A-Z][a-z]+\s+[A-Z]{2,}(?:\s+[A-Z][a-z]+)?)\b/g;
  let match;
  while ((match = genericRegex.exec(body))) {
    const raw = match[1].trim();
    if (raw.length < 3 || GENERIC_STOPWORDS.has(raw)) continue;
    const normalized = normalizeTerm(raw);
    const tokens = normalized.split(' ');
    if (!tokens.some(t => GENERIC_ALLOWLIST.has(t) || /[0-9]/.test(t) || t.length >= 4 && /^[a-z]+$/.test(t) === false)) {
      continue;
    }
    if (!found.has(normalized)) {
      found.set(normalized, {
        term: raw,
        snippet: clipSnippet(body, match.index, raw.length),
      });
    }
  }

  return [...found.values()];
}

function scanCvContextCandidates({ hub, portfolio, user }) {
  const sources = hub.prepare(`
    SELECT m.content AS content, m.ts AS ts, 'message' AS source_kind
      FROM messages m
      JOIN projects p ON p.id = m.project_id
     WHERE p.user = ? AND p.is_cv_context = 1
    UNION ALL
    SELECT d.markdown AS content, d.uploaded_at AS ts, 'document' AS source_kind
      FROM documents d
      JOIN projects p ON p.id = d.project_id
     WHERE p.user = ? AND p.is_cv_context = 1
    ORDER BY ts DESC
  `).all(user, user);

  const aggregate = new Map();

  for (const source of sources) {
    const candidates = extractCandidatesFromText(source.content);
    for (const candidate of candidates) {
      const key = normalizeTerm(candidate.term);
      const entry = aggregate.get(key) || {
        term: candidate.term,
        normalized: key,
        occurrences: 0,
        lastSeen: 0,
        snippets: [],
      };
      entry.occurrences += 1;
      entry.lastSeen = Math.max(entry.lastSeen, source.ts || 0);
      if (candidate.snippet && entry.snippets.length < 4 && !entry.snippets.includes(candidate.snippet)) {
        entry.snippets.push(candidate.snippet);
      }
      aggregate.set(key, entry);
    }
  }

  const existing = portfolio.prepare(
    'SELECT * FROM skill_candidates WHERE user = ?'
  ).all(user);
  const existingMap = new Map(existing.map(row => [row.normalized_term, row]));

  const upsert = portfolio.prepare(`
    INSERT INTO skill_candidates
      (id, user, term, normalized_term, occurrences, evidence, last_seen_at, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', unixepoch(), unixepoch())
    ON CONFLICT(user, normalized_term) DO UPDATE SET
      term = excluded.term,
      occurrences = excluded.occurrences,
      evidence = excluded.evidence,
      last_seen_at = excluded.last_seen_at,
      updated_at = unixepoch()
  `);

  for (const candidate of aggregate.values()) {
    if (candidate.occurrences < 2) continue;
    const prev = existingMap.get(candidate.normalized);
    const evidence = candidate.snippets.join('\n\n');
    upsert.run(
      prev?.id || uuid(),
      user,
      candidate.term,
      candidate.normalized,
      candidate.occurrences,
      evidence,
      candidate.lastSeen || Math.floor(Date.now() / 1000)
    );
  }
}

module.exports = {
  scanCvContextCandidates,
};
