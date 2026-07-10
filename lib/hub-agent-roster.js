'use strict';

const CAPOS = [
  {
    key: 'email',
    title: 'Email Capo',
    reportsTo: 'crm_underboss',
    soldiers: ['email_process job', 'email classifier', 'Gmail label learner', 'email summaries'],
    associates: ['Gmail received email', 'Gmail sent email'],
  },
  {
    key: 'agentmail',
    title: 'AgentMail Capo',
    reportsTo: 'crm_underboss',
    soldiers: ['agentmail_process job', 'trusted sender classifier', 'AgentMail summaries'],
    associates: ['mclellanhub@agentmail.to inbound mail'],
  },
  {
    key: 'crm',
    title: 'CRM Capo',
    reportsTo: 'crm_underboss',
    soldiers: ['crm_knowledge_engine', 'contacts', 'companies', 'projects', 'meeting intake'],
    associates: ['manual CRM notes', 'meeting transcripts', 'contact edits'],
  },
  {
    key: 'tasks',
    title: 'Tasks Capo',
    reportsTo: 'crm_underboss',
    soldiers: ['Google Tasks sync', 'task action projection', 'task route run'],
    associates: ['open Google Tasks', 'completed Google Tasks', 'source-projected actions'],
  },
  {
    key: 'documents_projects',
    title: 'Documents / Projects Capo',
    reportsTo: 'crm_underboss',
    soldiers: ['document ingestion', 'task extraction', 'project documents', 'heavy-file packages'],
    associates: ['uploaded project documents', 'chat uploads', 'Workday interview files'],
  },
  {
    key: 'knowledge',
    title: 'Knowledge Layer Capo',
    reportsTo: 'crm_underboss',
    soldiers: ['knowledge_atoms', 'knowledge_receipts', 'synthesis_state', 'knowledge_lint'],
    associates: ['all source kinds eligible for synthesis'],
  },
  {
    key: 'mycelium',
    title: 'Mycelium Capo',
    reportsTo: 'crm_underboss',
    soldiers: ['mycelium_run job', 'connectivity report', 'relationship/task linkers'],
    associates: ['orphaned nodes', 'new documents', 'scheduled flights', 'meetings'],
  },
  {
    key: 'reminders',
    title: 'Reminders Capo',
    reportsTo: 'crm_underboss',
    soldiers: ['reminder_sweep', 'reminder_fire', 'crm_nudges'],
    associates: ['due tasks', 'CRM follow-ups', 'manual reminders', 'Google Chat replies'],
  },
  {
    key: 'flights',
    title: 'Flight Tracker Capo',
    reportsTo: 'operations_underboss',
    soldiers: ['flight_refresh', 'flight_backfill', 'AeroDataBox lookup', 'Ryanair parser'],
    associates: ['Ryanair booking emails', 'manual/imported flight rows'],
  },
  {
    key: 'linkedin_content',
    title: 'LinkedIn Content Capo',
    reportsTo: 'content_underboss',
    soldiers: ['linkedin-pipeline', 'research planner', 'drafter', 'scorer', 'carousel renderer', 'publish capture'],
    associates: ['topics', 'primary source URLs', 'content research suggestions'],
  },
  {
    key: 'briefings',
    title: 'Briefings Capo',
    reportsTo: 'operations_underboss',
    soldiers: ['morning CRM brief', 'Nakai daily briefing', 'newsletter briefings', 'project reports'],
    associates: ['calendar events', 'regulatory items', 'RSS/intel items', 'project evidence'],
  },
  {
    key: 'rss_watchlist',
    title: 'RSS / Watchlist Capo',
    reportsTo: 'operations_underboss',
    soldiers: ['RSS ingest', 'watchlist_poll', 'creator/watchlist extraction'],
    associates: ['RSS feeds', 'watchlist URLs', 'creator sources'],
  },
  {
    key: 'wiki',
    title: 'Wiki / Synthadoc Capo',
    reportsTo: 'operations_underboss',
    soldiers: ['wiki routes', 'Synthadoc ingest', 'vault API', 'wiki search'],
    associates: ['wiki markdown files', 'vault documents', 'generated notes'],
  },
  {
    key: 'model_governance',
    title: 'Model Governance Capo',
    reportsTo: 'consigliere',
    soldiers: ['model_config', 'request_logs', 'OpenRouter policy checks', 'style_profile_run'],
    associates: ['OpenRouter models', 'system prompt leak profiles', 'admin model slots'],
  },
  {
    key: 'token_burn',
    title: 'Token Burn Capo',
    reportsTo: 'consigliere',
    soldiers: ['generate-daily-burn', 'sync-openrouter-activity', 'token burn dashboard', 'Token Burn Auditor'],
    associates: ['Codex session logs', 'Claude Code logs', 'OpenRouter management API', 'Hub request logs'],
  },
  {
    key: 'system_report',
    title: 'System Report Capo',
    reportsTo: 'consigliere',
    soldiers: ['system report generator', 'module health checks', 'AgentMail report delivery'],
    associates: ['journal logs', 'processing failures', 'agent receipts'],
  },
  {
    key: 'infrastructure',
    title: 'Infrastructure Capo',
    reportsTo: 'consigliere',
    soldiers: ['job queue', 'SQLite', 'Puppeteer/Chrome', 'Nginx', 'SSH/deploy path'],
    associates: ['Node runtime', 'Google OAuth tokens', 'VPS services'],
  },
];

const UNDERBOSSES = [
  {
    key: 'crm_underboss',
    title: 'CRM Underboss',
    reportsTo: 'consigliere',
    capos: ['email', 'agentmail', 'crm', 'tasks', 'documents_projects', 'knowledge', 'mycelium', 'reminders'],
  },
  {
    key: 'operations_underboss',
    title: 'Operations Underboss',
    reportsTo: 'consigliere',
    capos: ['flights', 'briefings', 'rss_watchlist', 'wiki'],
  },
  {
    key: 'content_underboss',
    title: 'Content Underboss',
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

