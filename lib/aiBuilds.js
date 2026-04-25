const AI_ASSISTED_APP_BUILDS_TITLE = 'AI-Assisted App Builds';

const AI_ASSISTED_APP_BUILDS_INTRO =
  'These projects were vibe-coded through AI-assisted development: rapid conversational prototyping, iterative implementation, and continuous refinement based on real operational needs. The value was not in treating AI as a shortcut, but in using it as an accelerator while retaining human judgement over architecture, security, usability, and operational fit. Security was central throughout: authentication is handled through the user\'s existing trusted identity layer, including Microsoft Teams/Entra ID, Microsoft accounts, SharePoint/Microsoft 365, and Google OAuth. Secrets and production data are kept outside the repositories, and access is shaped around clear user roles and data boundaries. Each project has also evolved through feedback and real-world use, with successive iterations adding reporting, admin tools, AI features, role controls, notifications, and workflow refinements.';

const AI_ASSISTED_APP_BUILDS_PROJECTS = [
  {
    name: 'Bowling Load Tracker',
    url: 'https://github.com/SiteITAdmin/bowling-load-tracker',
    stack: 'Node.js, Express, PostgreSQL, Azure App Service, Entra ID, Microsoft Graph, Microsoft Teams',
    summary:
      'A secure Azure-hosted workload monitoring platform for Cricket Ireland bowlers. The system lets players log sessions, gives coaches visibility over assigned players, and uses ACWR calculations to flag workload spikes before they become injury risks.',
    bullets: [
      'Designed and delivered a secure bowling workload monitoring application for Cricket Ireland, enabling players, coaches, and administrators to track bowling sessions and monitor injury risk through Acute:Chronic Workload Ratio analysis.',
      'Built a Node.js/Express application with PostgreSQL persistence, Azure App Service hosting, Microsoft Entra ID authentication, Microsoft Graph role resolution, and Microsoft Teams personal app integration.',
      'Implemented role-based dashboards for players, coaches, and administrators, including coach-player assignments, CSV import/export, configurable thresholds, weekly targets, trend charts, and Teams channel notifications.',
      'Created operational documentation covering Azure infrastructure, Entra configuration, deployment, security model, database schema, troubleshooting, and maintenance processes.',
    ],
  },
  {
    name: 'McLellan Hub',
    url: 'https://github.com/SiteITAdmin/mclellan-hub',
    stack: 'Node.js, Express, EJS, SQLite, Google OAuth, AI provider integrations',
    summary:
      'A private AI workspace and portfolio platform that combines multi-model chat, project memory, document analysis, source-linked research, export workflows, and recruiter-facing portfolio AI.',
    bullets: [
      'Built a self-hosted AI workspace combining private multi-model chat, project memory, document upload, source-linked research, portfolio content management, and public AI-assisted CV experiences.',
      'Developed a Node.js/Express and EJS platform using SQLite, Google OAuth, subdomain routing, model configuration, request logging, document extraction, answer export to Word/PDF/Google Docs, and recruiter-facing AI chat.',
      'Implemented practical AI governance features including prompt-injection guards, rate limiting, private project context, searchable recall, per-user model routing, and logging of model usage, cost, tokens, and response quality.',
      'Extended the platform into public portfolio sites with AI chat, CV context management, job description fit analysis, executive-summary PDF generation, and admin-managed candidate profile data.',
    ],
  },
  {
    name: 'MRVR',
    url: 'https://github.com/SiteITAdmin/MRVR',
    stack: 'SharePoint Framework, React, TypeScript, Fluent UI, SharePoint REST API',
    summary:
      'A SharePoint Framework reporting tool for Cricket Ireland match referees. It captures venue reports, stores structured answers in SharePoint, retrieves previous reports for the same venue, and carries forward unresolved venue notes so operational knowledge is not lost between fixtures.',
    bullets: [
      'Built a SharePoint Framework web part for Cricket Ireland match referees to capture structured venue reports and preserve operational knowledge across fixtures.',
      'Developed a React/TypeScript SPFx solution using Fluent UI and SharePoint REST APIs to save structured report data, readable summaries, and match metadata into a SharePoint list.',
      'Implemented venue history lookup, live summary preview, required-field validation, and carry-forward notes so unresolved venue issues are surfaced automatically to future officials.',
      'Structured the report form around real match operations, including match details, ground staff, match manager, scorers, venue facilities, and post-match observations.',
    ],
  },
];

function getAiAssistedBuildsText() {
  const projectText = AI_ASSISTED_APP_BUILDS_PROJECTS.map((project) => {
    const bullets = project.bullets.map((bullet) => `- ${bullet}`).join('\n');
    return `## ${project.name}\n${project.summary}\n\nStack: ${project.stack}\n\n${bullets}`;
  }).join('\n\n');

  return `${AI_ASSISTED_APP_BUILDS_TITLE}\n\n${AI_ASSISTED_APP_BUILDS_INTRO}\n\n${projectText}`;
}

module.exports = {
  AI_ASSISTED_APP_BUILDS_TITLE,
  AI_ASSISTED_APP_BUILDS_INTRO,
  AI_ASSISTED_APP_BUILDS_PROJECTS,
  getAiAssistedBuildsText,
};
