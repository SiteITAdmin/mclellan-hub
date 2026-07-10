'use strict';

const CAPOS = [
  {
    key: 'email',
    title: 'Email Capo',
    purpose: 'Every relevant Gmail message is faithfully ingested once, turned into source evidence, and handed to knowledge/action synthesis or left as a visible failure with a repair path.',
    reportsTo: 'crm_underboss',
    soldiers: ['email_process job', 'email classifier', 'Gmail label learner', 'email summaries'],
    associates: ['Gmail received email', 'Gmail sent email'],
  },
  {
    key: 'agentmail',
    title: 'AgentMail Capo',
    purpose: 'Every trusted AgentMail message is faithfully ingested and converted into source-backed knowledge and actions, or visibly rejected with evidence and a repair path.',
    reportsTo: 'crm_underboss',
    soldiers: ['agentmail_process job', 'trusted sender classifier', 'AgentMail summaries'],
    associates: ['mclellanhub@agentmail.to inbound mail'],
  },
  {
    key: 'crm',
    title: 'CRM Capo',
    purpose: 'Every eligible CRM source is triaged; valuable evidence becomes provenance-backed compiled knowledge; actionable commitments become tasks; incomplete or failed source journeys are repaired.',
    reportsTo: 'crm_underboss',
    soldiers: ['crm_knowledge_engine', 'contacts', 'companies', 'projects', 'meeting intake'],
    associates: ['manual CRM notes', 'meeting transcripts', 'contact edits'],
  },
  {
    key: 'tasks',
    title: 'Tasks Capo',
    purpose: 'Every source-backed action that Douglas should take becomes one correctly linked task, and completion flows back into compiled knowledge without silent duplication.',
    reportsTo: 'crm_underboss',
    soldiers: ['Google Tasks sync', 'task action projection', 'task route run'],
    associates: ['open Google Tasks', 'completed Google Tasks', 'source-projected actions'],
  },
  {
    key: 'documents_projects',
    title: 'Documents / Projects Capo',
    purpose: 'Every useful uploaded document is preserved as evidence, reviewed for knowledge and actions, and reflected in the relevant project without relying on manual links.',
    reportsTo: 'crm_underboss',
    soldiers: ['document ingestion', 'task extraction', 'project documents', 'heavy-file packages'],
    associates: ['uploaded project documents', 'chat uploads', 'Workday interview files'],
  },
  {
    key: 'knowledge',
    title: 'Knowledge Layer Capo',
    purpose: 'Continuously compile raw evidence into provenance-backed atoms and events, keeping contradictions, uncertainty, staleness, and supersession visible.',
    reportsTo: 'crm_underboss',
    soldiers: ['knowledge_atoms', 'knowledge_receipts', 'synthesis_state', 'knowledge_lint'],
    associates: ['all source kinds eligible for synthesis'],
  },
  {
    key: 'mycelium',
    title: 'Mycelium Capo',
    purpose: 'Grow evidence-supported connections between isolated knowledge and actions while avoiding invented or merely adjacent relationships.',
    reportsTo: 'crm_underboss',
    soldiers: ['mycelium_run job', 'connectivity report', 'relationship/task linkers'],
    associates: ['orphaned nodes', 'new documents', 'scheduled flights', 'meetings'],
  },
  {
    key: 'reminders',
    title: 'Reminders Capo',
    purpose: 'Every time-sensitive commitment reaches Douglas until it is resolved, deferred, silenced, or honestly marked stale.',
    reportsTo: 'crm_underboss',
    soldiers: ['reminder_sweep', 'reminder_fire', 'crm_nudges'],
    associates: ['due tasks', 'CRM follow-ups', 'manual reminders', 'Google Chat replies'],
  },
  {
    key: 'flights',
    title: 'Flight Tracker Capo',
    purpose: 'Carry every recorded flight from booking or import through scheduled tracking to verified departure and arrival outcomes.',
    reportsTo: 'operations_underboss',
    soldiers: ['flight_refresh', 'flight_backfill', 'AeroDataBox lookup', 'Ryanair parser'],
    associates: ['Ryanair booking emails', 'manual/imported flight rows'],
  },
  {
    key: 'linkedin_content',
    title: 'LinkedIn Content Capo',
    purpose: 'Carry every selected topic to a sourced, quality-approved post package with a valid carousel PDF ready for Douglas, a published/captured post, or a visible repair in progress.',
    reportsTo: 'content_underboss',
    soldiers: ['linkedin-pipeline', 'research planner', 'drafter', 'scorer', 'carousel renderer', 'publish capture'],
    associates: ['topics', 'primary source URLs', 'content research suggestions'],
  },
  {
    key: 'briefings',
    title: 'Briefings Capo',
    purpose: 'Turn the right current evidence into each promised briefing and deliver it on time, with missing artifacts or sends treated as unfinished work.',
    reportsTo: 'operations_underboss',
    soldiers: ['morning CRM brief', 'Nakai daily briefing', 'newsletter briefings', 'project reports'],
    associates: ['calendar events', 'regulatory items', 'RSS/intel items', 'project evidence'],
  },
  {
    key: 'rss_watchlist',
    title: 'RSS / Watchlist Capo',
    purpose: 'Observe each configured source on schedule, preserve new evidence faithfully, and route useful intelligence into synthesis without silent polling gaps.',
    reportsTo: 'operations_underboss',
    soldiers: ['RSS ingest', 'watchlist_poll', 'creator/watchlist extraction'],
    associates: ['RSS feeds', 'watchlist URLs', 'creator sources'],
  },
  {
    key: 'wiki',
    title: 'Wiki / Synthadoc Capo',
    purpose: 'Keep source-backed project and entity knowledge discoverable as durable documents and searchable views over the compiled knowledge layer.',
    reportsTo: 'operations_underboss',
    soldiers: ['wiki routes', 'Synthadoc ingest', 'vault API', 'wiki search'],
    associates: ['wiki markdown files', 'vault documents', 'generated notes'],
  },
  {
    key: 'model_governance',
    title: 'Model Governance Capo',
    purpose: 'Keep every model slot observable, policy-compliant, and fit for its task, surfacing degradation before it corrupts downstream outcomes.',
    reportsTo: 'consigliere',
    soldiers: ['model_config', 'request_logs', 'OpenRouter policy checks', 'style_profile_run'],
    associates: ['OpenRouter models', 'system prompt leak profiles', 'admin model slots'],
  },
  {
    key: 'token_burn',
    title: 'Token Burn Capo',
    purpose: 'Maintain a truthful, current account of model and agent usage so cost, attribution, and missing telemetry are visible.',
    reportsTo: 'consigliere',
    soldiers: ['generate-daily-burn', 'sync-openrouter-activity', 'token burn dashboard', 'Token Burn Auditor'],
    associates: ['Codex session logs', 'Claude Code logs', 'OpenRouter management API', 'Hub request logs'],
  },
  {
    key: 'system_report',
    title: 'System Report Capo',
    purpose: 'Deliver an honest daily account of what the Hub achieved, failed to achieve, repaired, and still needs from Douglas.',
    reportsTo: 'consigliere',
    soldiers: ['system report generator', 'module health checks', 'AgentMail report delivery'],
    associates: ['journal logs', 'processing failures', 'agent receipts'],
  },
  {
    key: 'infrastructure',
    title: 'Infrastructure Capo',
    purpose: 'Keep the runtime foundations available and correct so domain journeys can execute, with failures visible to remediation and repair.',
    reportsTo: 'consigliere',
    soldiers: ['job queue', 'SQLite', 'Puppeteer/Chrome', 'Nginx', 'SSH/deploy path'],
    associates: ['Node runtime', 'Google OAuth tokens', 'VPS services'],
  },
];

const UNDERBOSSES = [
  {
    key: 'crm_underboss',
    title: 'CRM Underboss',
    purpose: 'Ensure raw relationship evidence completes the journey through ingestion, synthesis, action projection, connection, and follow-through across the CRM family.',
    reportsTo: 'consigliere',
    capos: ['email', 'agentmail', 'crm', 'tasks', 'documents_projects', 'knowledge', 'mycelium', 'reminders'],
  },
  {
    key: 'operations_underboss',
    title: 'Operations Underboss',
    purpose: 'Ensure operational journeys such as travel, briefings, monitoring, and wiki publication reach their intended outcomes.',
    reportsTo: 'consigliere',
    capos: ['flights', 'briefings', 'rss_watchlist', 'wiki'],
  },
  {
    key: 'content_underboss',
    title: 'Content Underboss',
    purpose: 'Ensure selected content ideas become complete, quality-approved publication packages without bypassing Douglas.',
    reportsTo: 'consigliere',
    capos: ['linkedin_content'],
  },
];

function capoByKey(key) {
  return CAPOS.find(capo => capo.key === key) || null;
}

function underbossByKey(key) {
  return UNDERBOSSES.find(underboss => underboss.key === key) || null;
}

module.exports = {
  CAPOS,
  UNDERBOSSES,
  capoByKey,
  underbossByKey,
};
