const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { briefingPeriodLabel, briefingProvenanceText } = require('../lib/newsletter-pipeline');
const { routeMessage } = require('../lib/router');
const { uuid } = require('../lib/id');
const { getSystemModelKey, getSystemPrompt } = require('../lib/settings');
const { PROMPTS } = require('../lib/prompts');
const PDFDocument = require('pdfkit');
const {
  AI_ASSISTED_APP_BUILDS_INTRO,
  AI_ASSISTED_APP_BUILDS_PROJECTS,
  getAiAssistedBuildsText,
} = require('../lib/aiBuilds');
const { VERIFIED_DOUGLAS_EMPLOYMENT } = require('../lib/verifiedEmployment');
const {
  buildPromptInjectionGuard,
  createRateLimiter,
  requireSameOrigin,
  wrapUntrustedBlock,
} = require('../lib/security');

const publicAiLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyPrefix: 'portfolio-ai',
  message: 'Too many AI requests from this connection, please try again shortly.',
});
const contactLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyPrefix: 'portfolio-contact',
  message: 'Too many contact attempts from this connection, please try again later.',
});
const PORTFOLIO_CHAT_GUARD = buildPromptInjectionGuard('the public portfolio chat');
const JD_ANALYSER_GUARD = buildPromptInjectionGuard('the public recruiter-facing job description analyser');
const NAKAI_LINKEDIN_MESSAGE_URL = 'https://www.linkedin.com/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AACoAAA39lEcBJ03ZBpjopopuTRqOb7MPhcYh1i0&recipient=ACoAAA39lEcBJ03ZBpjopopuTRqOb7MPhcYh1i0&screenContext=NON_SELF_PROFILE_VIEW&interop=msgOverlay&lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B9jQrKoazSu6GcMh2jmrkWg%3D%3D';
let nodemailer;

function shouldShowAiBuilds(user) {
  return user === 'douglas';
}

function ensureAiBuildsCv(cv, user) {
  if (shouldShowAiBuilds(user) && !cv.ai_assisted_app_builds) {
    cv.ai_assisted_app_builds = getAiAssistedBuildsText();
  }
  return cv;
}

function getAiBuildsCvBlock(cvRows, user) {
  if (!shouldShowAiBuilds(user)) return '';
  const hasDbRow = cvRows.some((row) => row.section === 'ai_assisted_app_builds' && row.content);
  return hasDbRow ? '' : getAiAssistedBuildsText();
}

// ── Pull chat-capable models from hub DB ─────────────────────────────────────
function getChatModels(user) {
  try {
    const rows = db.hub().prepare(
      `SELECT key, label, tier FROM model_config
        WHERE enabled = 1 AND tier != 'image'
          AND (user IS NULL OR user = ?)
        ORDER BY tier, display_order, key`
    ).all(user);
    return rows.length ? rows : [{ key: 'deepseek-v3', label: 'DeepSeek V3', tier: 'everyday' }];
  } catch {
    return [{ key: 'deepseek-v3', label: 'DeepSeek V3', tier: 'everyday' }];
  }
}

function getExecutiveSummaryText({ user, profile, cv, experiences }) {
  const fullName = profile.full_name || (user === 'douglas' ? 'Douglas McLellan' : 'Nakai McLellan');
  const title = cv.role_label || profile.current_title || '';
  const summary = cv.summary || profile.elevator_pitch || '';
  const location = profile.location || '';
  const availability = profile.availability_status || '';
  const remote = profile.remote_preference || '';
  const linkedin = cv.linkedin_url || '';
  const email = profile.email || (user === 'douglas' ? 'douglas@mclellan.scot' : '');
  const topExperience = experiences.slice(0, 5).map(exp =>
    `- ${exp.role}, ${exp.company} (${exp.start_date || '?'} – ${exp.end_date || 'Present'})${exp.description ? ': ' + exp.description : ''}`
  ).join('\n');
  const aiBuilds = shouldShowAiBuilds(user)
    ? AI_ASSISTED_APP_BUILDS_PROJECTS.map(project => `- ${project.name}: ${project.summary}`).join('\n')
    : '';

  return [
    `# ${fullName}`,
    title ? title : null,
    '',
    summary || null,
    '',
    '## Contact',
    email ? `- Email: ${email}` : null,
    location ? `- Location: ${location}` : null,
    availability ? `- Availability: ${availability}` : null,
    remote ? `- Work preference: ${remote}` : null,
    linkedin ? `- LinkedIn: ${linkedin}` : null,
    '',
    '## Selected Experience',
    topExperience || '- Experience available on request.',
    aiBuilds ? '\n## AI-Assisted App Builds' : null,
    aiBuilds || null,
  ].filter(Boolean).join('\n');
}

function getPortfolioBaseUrl(user) {
  return user === 'douglas'
    ? 'https://douglas.mclellan.scot'
    : 'https://nakai.mclellan.scot';
}

function cleanCvText(text) {
  return String(text || '')
    .replace(/\bcyberscreuity\b/gi, 'cybersecurity')
    .replace(/\banalitics\b/gi, 'analytics')
    .replace(/\bmanagment\b/gi, 'management')
    .replace(/\baccross\b/gi, 'across')
    .replace(/\bsecuirty\b/gi, 'security')
    .replace(/\bdeprivide\b/gi, 'deprived')
    .replace(/\begistration\b/gi, 'registration')
    .replace(/—/g, ' - ')
    .replace(/–/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function getDouglasProfileSummary(profile, cv) {
  return [
    'Sole IT administrator for Cricket Ireland across four years - full Microsoft 365 responsibility without a team across approximately 50 staff, 40-50 players, and 25 match officials.',
    'Inherited a tenant with no MFA, no DMARC, no Conditional Access, and no Intune; handed it over secure, documented, and formally structured across ten operational areas.',
    'Now administering Microsoft 365 at Beacon Hospital and building AI-assisted tools alongside: a secure Azure-hosted bowling workload platform, a SharePoint SPFx venue reporting tool, and a personal AI workspace.',
    'All capability is self-taught and demonstrated through operational delivery, GitHub repositories, and named employer references.',
  ].join(' ');
}

function getDouglasExperiences() {
  return VERIFIED_DOUGLAS_EMPLOYMENT.map(item => ({ ...item }));
}

function getPublishedThinkingBlock(user) {
  let posts;
  try {
    posts = require('../lib/knowledge-format').publishedThinking(user);
  } catch (err) {
    console.warn('[portfolio] published thinking unavailable:', err.message);
    return '';
  }
  if (!posts.length) return '';
  return [
    '## Published thinking (opinion and analysis — NOT work experience)',
    'These are published LinkedIn articles. They are the candidate\'s ideas, analysis, and opinions — never present them as employment, roles, or hands-on work experience.',
    'When a question is about a topic the candidate has written on but not worked in at that level (e.g. EU policy, AI regulation), answer in two parts: first state plainly, in a work capacity, that they have not worked at that level; then point to the relevant piece below with its link as where their thinking on it can be found.',
    'Always include the link when referencing a piece.',
    '',
    ...posts.map(p => `- **${p.title}** (${p.date}${p.category ? ', ' + p.category : ''}): ${p.summary} — ${p.url}`),
  ].join('\n');
}

function getPortfolioExperiences(pdb, user) {
  const rows = pdb.prepare(
    'SELECT role, company, start_date, end_date, description FROM experiences WHERE is_cv_context = 1 ORDER BY display_order ASC'
  ).all();
  const experiences = user === 'douglas' && !rows.length ? getDouglasExperiences() : rows;
  return experiences.filter(exp => shouldShowCvRole(user, exp));
}

function getCoreStrengths(user, skills, candidates) {
  const approvedTopics = new Set((candidates || [])
    .filter(c => ['promoted_jd', 'chat_only'].includes(c.status))
    .map(c => String(c.term || '').toLowerCase()));
  const preferred = user === 'douglas'
    ? [
      'Microsoft 365 Administration',
      'Identity & Access (Entra ID)',
      'SharePoint & Teams',
      'Power Platform (Apps / Automate)',
      'MS Purview',
      'Intune',
      'Email Security & DMARC',
      'Vendor & MSP Management',
      'Business Systems Implementation',
      'Change Management',
      'Team Leadership',
      'Power BI / DOMO',
      'VoIP & Unified Comms',
      'AI Tool Development',
    ]
    : [];
  const byName = new Map((skills || []).map(s => [String(s.name || '').toLowerCase(), s.name]));
  const picked = preferred.filter(name => byName.has(name.toLowerCase()) || approvedTopics.has(name.toLowerCase()));
  const fallback = (skills || [])
    .filter(s => s.level !== 'gap')
    .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
    .map(s => s.name)
    .slice(0, 10);
  const strategic = user === 'douglas'
    ? ['Business Systems Implementation', 'Change Management']
    : [];
  return [...new Set([...(picked.length ? picked : fallback), ...strategic])].filter(Boolean);
}

function getDouglasImpactHighlights() {
  return [
    'Administered the Cricket Ireland M365 tenant as sole administrator for four years across approximately 50 staff, 40-50 players, and 25 match officials: Entra ID with RBAC, MFA, and Conditional Access; Intune across a mixed corporate Android and personal iPhone estate; Exchange Online, SharePoint, Teams, OneDrive, and enterprise application permission governance.',
    'Inherited a live tenant with no MFA, no DMARC, no Conditional Access, and no Intune. Implemented all four, tightened application consent policies, applied Purview information protection controls, and consolidated wasted license and AWS expenditure.',
    'Administered Sport80, NV Play, BrightHR, WordPress, Vodafone ROI/NI, and Nostra MSP. Built Power Platform automation for player registration and the Match Referee Venue Report (MRVR) SharePoint SPFx application.',
    'Managed match-day technology at 6-8 international fixtures per season, including the 7,500-capacity temporary stadium at Malahide Castle: Starlink, DLS 6 scoring, broadcasting, and live streaming in venues with no permanent IT infrastructure.',
    'Delivered a ten-area structured handover covering identity, devices, security, systems, match-day, hardware, Power Platform, support, vendors, and documentation - designed to be re-executed without the author present.',
  ];
}

function getExperienceBullets(user, exp) {
  if (user !== 'douglas') return [cleanCvText(exp.description)].filter(Boolean);
  const role = String(exp.role || '').toLowerCase();
  const company = String(exp.company || '').toLowerCase();
  if (company.includes('beacon')) {
    return [
      'Support the hospital\'s Microsoft 365 transition, focusing on secure administration, SharePoint, Teams, OneDrive and Entra ID.',
      'Provide practical user support and rollout assistance in a healthcare environment where reliability, data handling and adoption matter.',
    ];
  }
  if (company.includes('cricket') && role.includes('manager')) {
    return [
      'Sole M365 administrator for approximately 50 staff, 40-50 players, and 25 match officials: Entra ID with RBAC, MFA, and Conditional Access; Intune device management across a mixed corporate Android and personal iPhone estate; Exchange Online, SharePoint, Teams, OneDrive, and enterprise application permission governance.',
      'Inherited a live tenant with no MFA, no DMARC, no Conditional Access, and no Intune. Implemented all four, tightened application consent policies, applied Purview information protection controls, and consolidated wasted license and AWS expenditure.',
      'Administered Sport80, NV Play, BrightHR, WordPress, Vodafone ROI/NI, and Nostra MSP. Built Power Platform automation for player registration and the Match Referee Venue Report (MRVR) SharePoint SPFx application.',
      'Managed match-day technology at 6-8 international fixtures per season including the 7,500-capacity Malahide Castle stadium: Starlink, DLS 6 scoring, broadcasting, and live streaming.',
    ];
  }
  if (company.includes('cricket') && role.includes('systems')) {
    return [
      'Supported co-managed IT operations across devices, identity, file services, collaboration tools and user support.',
      'Planned and delivered migration of priority workloads from AWS-hosted operational storage into Microsoft 365.',
    ];
  }
  if (company.includes('liffey') && role.includes('ict')) {
    return [
      'Led ICT operations across five Dublin sites, combining infrastructure, user support, vendor management and organisational delivery.',
      'Moved the organisation from Windows Server 2012 file services to SharePoint and OneDrive, improving remote access and resilience.',
      'Supported business-system change across HR, finance/accounts, telephony and collaboration tools, including implementation, training and handover.',
      'Implemented VoIP/softphone services and secure remote-working support during COVID-19.',
    ];
  }
  return [cleanCvText(exp.description)].filter(Boolean);
}

function shouldShowCvRole(user, exp) {
  if (user !== 'douglas') return true;
  return !String(exp.company || '').toLowerCase().includes('bank of scotland');
}

function getDetailedExperiences(user, experiences) {
  const visible = (experiences || []).filter(exp => shouldShowCvRole(user, exp));
  return user === 'douglas' ? visible.slice(0, 5) : visible;
}

function getEarlierExperiences(user, experiences) {
  if (user !== 'douglas') return [];
  return (experiences || []).filter(exp => shouldShowCvRole(user, exp)).slice(5);
}

function addPageIfNeeded(doc, needed = 80) {
  if (doc.y + needed > 770) {
    doc.addPage();
    doc.y = 48;
  }
}

function drawSection(doc, title) {
  addPageIfNeeded(doc, 48);
  doc.moveDown(0.65);
  doc.fillColor('#4648d4').font('Helvetica-Bold').fontSize(10).text(title.toUpperCase(), { characterSpacing: 0.4 });
  doc.moveDown(0.25);
  const y = doc.y;
  doc.save().moveTo(48, y).lineTo(547, y).lineWidth(0.8).strokeColor('#d8d4e8').stroke().restore();
  doc.moveDown(0.55);
}

function drawBullet(doc, text, options = {}) {
  if (!text) return;
  addPageIfNeeded(doc, options.space || 34);
  const x = options.x || 48;
  const y = doc.y;
  doc.fillColor(options.color || '#1b1b23').font('Helvetica').fontSize(options.size || 9.2);
  doc.text('•', x, y, { width: 10 });
  doc.text(cleanCvText(text), x + 13, y, { width: options.width || 486, lineGap: 1.5 });
  doc.x = 48;
  doc.moveDown(0.18);
}

function drawSkillChips(doc, skills) {
  const line = skills.join(', ');
  doc.x = 48;
  doc.fillColor('#1b1b23').font('Helvetica').fontSize(9.2).text(line, { width: 499, lineGap: 2 });
  doc.x = 48;
}

async function buildExecutiveSummaryPdf({ user, profile, cv, experiences, skills = [], candidates = [] }) {
  const fullName = profile.full_name || (user === 'douglas' ? 'Douglas McLellan' : 'Nakai McLellan');
  const title = cv.role_label || profile.current_title || '';
  const summary = user === 'douglas'
    ? cleanCvText(getDouglasProfileSummary(profile, cv))
    : cleanCvText(cv.summary || profile.elevator_pitch || '');
  const website = getPortfolioBaseUrl(user);
  const email = profile.email || (user === 'douglas' ? 'douglas@mclellan.scot' : '');
  const phone = getPublicPhone(user, profile);
  const location = profile.location || '';
  const linkedin = cv.linkedin_url || '';
  const coreStrengths = getCoreStrengths(user, skills, candidates);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4', info: { Title: `${fullName} CV` } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fillColor('#1b1b23').font('Helvetica-Bold').fontSize(23).text(fullName);
    if (title) {
      doc.moveDown(0.15);
      doc.fillColor('#4a4760').font('Helvetica').fontSize(11.5).text(cleanCvText(title));
    }

    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9.2).fillColor('#5f5b74');
    const contactBits = [email, phone, website].filter(Boolean).join('  |  ');
    if (contactBits) doc.text(contactBits);
    if (location || linkedin) {
      doc.moveDown(0.15);
      doc.text([location, linkedin].filter(Boolean).join('  |  '));
    }
    if (profile.availability_status || profile.remote_preference) {
      doc.moveDown(0.15);
      doc.text([profile.availability_status, profile.remote_preference].filter(Boolean).join('  |  '));
    }

    drawSection(doc, 'Professional Profile');
    if (summary) {
      doc.fillColor('#1b1b23').font('Helvetica').fontSize(9.7).text(summary, { width: 499, lineGap: 2.2 });
    }

    if (coreStrengths.length) {
      drawSection(doc, 'Core Strengths');
      drawSkillChips(doc, coreStrengths);
    }

    if (user === 'douglas') {
      drawSection(doc, 'Selected Impact');
      getDouglasImpactHighlights().forEach(item => drawBullet(doc, item));
    }

    drawSection(doc, 'Professional Experience');
    const detailedExperiences = getDetailedExperiences(user, experiences);
    const earlierExperiences = getEarlierExperiences(user, experiences);
    detailedExperiences.forEach((exp, idx) => {
      addPageIfNeeded(doc, 76);
      doc.x = 48;
      const dates = `${exp.start_date || '?'} - ${exp.end_date || 'Present'}`;
      doc.fillColor('#1b1b23').font('Helvetica-Bold').fontSize(10.2)
        .text(`${exp.role} | ${exp.company}`);
      doc.fillColor('#5f5b74').font('Helvetica').fontSize(8.8)
        .text(dates);
      doc.moveDown(0.15);
      getExperienceBullets(user, exp).slice(0, idx < 4 ? 4 : 2).forEach(item => drawBullet(doc, item, { size: 8.9, width: 474, space: 28 }));
      if (idx < detailedExperiences.length - 1) doc.moveDown(0.35);
    });

    if (earlierExperiences.length) {
      drawSection(doc, 'Earlier Career');
      earlierExperiences.forEach(exp => {
        addPageIfNeeded(doc, 24);
        doc.x = 48;
        doc.fillColor('#1b1b23').font('Helvetica-Bold').fontSize(9.2)
          .text(`${exp.role} | ${exp.company}`, { continued: false });
        doc.fillColor('#5f5b74').font('Helvetica').fontSize(8.4)
          .text(`${exp.start_date || '?'} - ${exp.end_date || 'Present'}`);
        doc.moveDown(0.2);
      });
    }

    if (shouldShowAiBuilds(user)) {
      drawSection(doc, 'AI-Assisted Application Builds');
      AI_ASSISTED_APP_BUILDS_PROJECTS.forEach(project => {
        addPageIfNeeded(doc, 60);
        doc.fillColor('#1b1b23').font('Helvetica-Bold').fontSize(9.5).text(project.name);
        doc.moveDown(0.12);
        doc.fillColor('#1b1b23').font('Helvetica').fontSize(8.8).text(cleanCvText(project.summary), { width: 499, lineGap: 1.4 });
        doc.fillColor('#5f5b74').font('Helvetica').fontSize(8).text(project.stack, { width: 499 });
        doc.moveDown(0.45);
      });
    }

    if (cv.education) {
      drawSection(doc, 'Education');
      doc.fillColor('#1b1b23').font('Helvetica').fontSize(9).text(cleanCvText(cv.education), { width: 499 });
    }

    addPageIfNeeded(doc, 34);
    doc.moveDown(0.7);
    doc.fillColor('#5f5b74').font('Helvetica').fontSize(8.2)
      .text(`Portfolio: ${website}`, 48, doc.y, { width: 499, align: 'right' });

    doc.end();
  });
}

function getAnalyserContactBlock(resultContent, { user, email, phone }) {
  if (user === 'nakai') {
    return [
      '',
      '### Contact Nakai',
      `- [Contact Nakai about this or other opportunities via LinkedIn](${NAKAI_LINKEDIN_MESSAGE_URL})`,
    ].join('\n');
  }

  const lower = String(resultContent || '').toLowerCase();
  let lead = `If this specific brief is not the right fit, you can still reach out to Douglas about related opportunities.`;
  if (lower.includes('strong outreach')) {
    lead = `This looks like a strong match. If you want to explore the role with Douglas, please get in touch directly.`;
  } else if (lower.includes('worth a conversation')) {
    lead = `This looks worth a conversation. If you would like to test mutual fit, please reach out to Douglas directly.`;
  }

  const contactLines = [
    '',
    '### Contact Douglas',
    lead,
    email ? `- Email: ${email}` : null,
    phone ? `- Phone: ${phone}` : `- Phone: available on request`,
  ].filter(Boolean);

  return contactLines.join('\n');
}

function getPublicPhone(user, profile) {
  return profile.phone_public || (user === 'douglas' ? '+353 (0) 896003148' : '');
}

function cleanContactField(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function getGmailTransport() {
  const user = process.env.GMAIL_SMTP_USER;
  const pass = String(process.env.GMAIL_SMTP_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!user || !pass) return null;
  try {
    if (!nodemailer) nodemailer = require('nodemailer');
  } catch (err) {
    console.error('[nakai-contact] nodemailer is not installed', err);
    return null;
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

// ── RSS feed ─────────────────────────────────────────────────────────────────

router.get('/feed.xml', (req, res) => {
  if (req.portfolioUser !== 'douglas') return res.status(404).end();
  const hub = db.hub();

  const briefings = hub.prepare(`
    SELECT b.id, b.week_key, b.date_from, b.date_to,
           COALESCE(b.format_name, f.name) AS format_name,
           b.text_content, b.topic_count, b.provenance_json, b.created_at, b.published_at
    FROM nl_briefings b
    LEFT JOIN nl_formats f ON f.id = b.format_id
    WHERE b.user = 'douglas' AND b.published_at IS NOT NULL
    ORDER BY published_at DESC LIMIT 20
  `).all();

  const linkedinPosts = hub.prepare(`
    SELECT id, topic, refined_draft, draft, created_at
    FROM linkedin_posts WHERE user = 'douglas' AND status = 'published'
    ORDER BY created_at DESC LIMIT 20
  `).all();

  const escXml = s => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

  const toRfc822 = ts => new Date(ts * 1000).toUTCString();

  const items = [
    ...briefings.map(b => ({
      title: `${b.format_name || 'Intelligence Briefing'} — ${briefingPeriodLabel(b)}`,
      link: 'https://douglas.mclellan.scot/llms.txt',
      guid: `urn:mclellan:briefing:${b.id}`,
      description: [
        briefingProvenanceText(b),
        (b.text_content || '').slice(0, 500).replace(/[#*`]/g, '').trim() + '…',
      ].filter(Boolean).join(' '),
      pubDate: toRfc822(b.published_at),
      category: 'Intelligence Briefing',
      ts: b.published_at,
    })),
    ...linkedinPosts.map(p => ({
      title: escXml(p.topic),
      link: `https://douglas.mclellan.scot/`,
      guid: `urn:mclellan:linkedin:${p.id}`,
      description: ((p.refined_draft || p.draft || '').slice(0, 500).replace(/[#*`]/g, '').trim()) + '…',
      pubDate: toRfc822(p.created_at),
      category: 'LinkedIn',
      ts: p.created_at,
    })),
  ].sort((a, b) => b.ts - a.ts);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Douglas McLellan — Intelligence &amp; Analysis</title>
    <link>https://douglas.mclellan.scot</link>
    <description>Weekly intelligence briefings and analysis on AI, Microsoft 365, healthcare IT, and technology strategy by Douglas McLellan.</description>
    <language>en-GB</language>
    <atom:link href="https://douglas.mclellan.scot/feed.xml" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items.map(item => `    <item>
      <title>${escXml(item.title)}</title>
      <link>${escXml(item.link)}</link>
      <description>${escXml(item.description)}</description>
      <pubDate>${item.pubDate}</pubDate>
      <category>${escXml(item.category)}</category>
      <guid isPermaLink="false">${escXml(item.guid)}</guid>
    </item>`).join('\n')}
  </channel>
</rss>`;

  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.send(xml);
});

// ── llms.txt ─────────────────────────────────────────────────────────────────

router.get('/llms.txt', (req, res) => {
  if (req.portfolioUser === 'nakai') {
    const lines = [
      '# Nakai McLellan',
      '',
      '> Internal audit, fintech risk, financial-services controls, and regulatory intelligence profile.',
      '',
      '## About',
      '',
      '- Focus: internal audit, fintech, payments, financial crime, risk, and regulatory intelligence',
      '- Domain context: regulated financial services, EU/UK/Ireland fintech operations, payments and BNPL control environments',
      '- Contact: https://nakai.mclellan.scot',
      '',
      '## Machine-Readable Knowledge',
      '',
      '- OKF-style bundle index: https://nakai.mclellan.scot/knowledge/nakai/index.md',
      '- About Nakai: https://nakai.mclellan.scot/knowledge/nakai/about/me.md',
      '- Public expertise signals from private daily briefing practice are linked from the bundle index. The private briefing content is not published.',
    ];
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(lines.join('\n'));
  }
  if (req.portfolioUser !== 'douglas') return res.status(404).end();
  const hub = db.hub();

  const briefings = hub.prepare(`
    SELECT b.week_key, b.date_from, b.date_to,
           COALESCE(b.format_name, f.name) AS format_name,
           b.text_content, b.topic_count, b.provenance_json, b.published_at
    FROM nl_briefings b
    LEFT JOIN nl_formats f ON f.id = b.format_id
    WHERE b.user = 'douglas' AND b.published_at IS NOT NULL
    ORDER BY published_at DESC LIMIT 10
  `).all();

  const linkedinPosts = hub.prepare(`
    SELECT topic, display_title, refined_draft, draft, created_at, post_url
    FROM linkedin_posts WHERE user = 'douglas' AND status = 'published'
    ORDER BY created_at DESC
  `).all();

  const lines = [
    '# Douglas McLellan',
    '',
    '> Senior technology professional specialising in AI strategy, Microsoft 365, identity governance, and healthcare IT. Based in Ireland.',
    '',
    '## About',
    '',
    '- Role: IT Manager / AI Strategist, Beacon Hospital Private Clinic',
    '- Focus: Microsoft 365 administration, AI governance, EU AI Act compliance, Zero Trust identity',
    '- Location: Ireland',
    '- Contact: https://douglas.mclellan.scot',
    '',
    '## Machine-Readable Knowledge',
    '',
    '- OKF-style bundle index: https://douglas.mclellan.scot/knowledge/douglas/index.md',
    '- About Douglas: https://douglas.mclellan.scot/knowledge/douglas/about/me.md',
    '- Published LinkedIn analysis and briefings are linked from the bundle index as they are published.',
    '',
    '## Intelligence Briefings',
    '',
    'Weekly curated analysis of AI, Microsoft 365, healthcare IT, and technology policy.',
    '',
  ];

  for (const b of briefings) {
    const date = new Date(b.published_at * 1000).toISOString().slice(0, 10);
    lines.push(`### ${b.format_name || 'Intelligence Briefing'} — ${briefingPeriodLabel(b)} (${date})`);
    lines.push('');
    const provenance = briefingProvenanceText(b);
    if (provenance) {
      lines.push(`> ${provenance}`);
      lines.push('');
    }
    lines.push((b.text_content || '').replace(/^#{1,6} /gm, '#### ').trim());
    lines.push('');
  }

  if (linkedinPosts.length) {
    lines.push('## Published Analysis');
    lines.push('');
    for (const p of linkedinPosts) {
      const date = new Date(p.created_at * 1000).toISOString().slice(0, 10);
      lines.push(`### ${p.display_title || p.topic} (${date})`);
      lines.push('');
      if (p.post_url) {
        lines.push(`Canonical: ${p.post_url}`);
        lines.push('');
      }
      lines.push((p.refined_draft || p.draft || '').trim());
      lines.push('');
    }
  }

  lines.push('## Feed');
  lines.push('');
  lines.push('RSS: https://douglas.mclellan.scot/feed.xml');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(lines.join('\n'));
});

// ── Public portfolio ──────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const pdb = db.portfolio(req.portfolioUser);
  const profile = pdb.prepare('SELECT * FROM profile WHERE id = 1').get() || {};
  if (req.portfolioUser === 'douglas' && !profile.phone_public) {
    profile.phone_public = '+353 (0) 896003148';
  }
  const experiences = getPortfolioExperiences(pdb, req.portfolioUser);
  const skills = pdb.prepare(
    'SELECT * FROM skills ORDER BY level, display_order'
  ).all();
  const cv = ensureAiBuildsCv(pdb.prepare(
    'SELECT * FROM cv_context'
  ).all().reduce((acc, row) => { acc[row.section] = row.content; return acc; }, {}), req.portfolioUser);

  const template = req.portfolioUser === 'douglas' ? 'portfolio/douglas' : 'portfolio/index';
  res.render(template, {
    user: req.portfolioUser,
    profile,
    experiences,
    skills,
    cv,
    aiBuildsIntro: shouldShowAiBuilds(req.portfolioUser) ? AI_ASSISTED_APP_BUILDS_INTRO : '',
    aiBuildProjects: shouldShowAiBuilds(req.portfolioUser) ? AI_ASSISTED_APP_BUILDS_PROJECTS : [],
    availableModels: getChatModels(req.portfolioUser),
  });
});

router.post('/contact', requireSameOrigin, contactLimiter, async (req, res) => {
  if (req.portfolioUser !== 'nakai') {
    return res.status(404).json({ error: 'Not found' });
  }

  const honeypot = cleanContactField(req.body.website, 200);
  if (honeypot) {
    return res.json({ ok: true, message: 'Thanks, your message has been sent.' });
  }

  const name = cleanContactField(req.body.name, 120);
  const email = cleanContactField(req.body.email, 180);
  const phone = cleanContactField(req.body.phone, 80);
  const message = cleanContactField(req.body.message, 2000);

  if (!name || !message) {
    return res.status(400).json({ error: 'Please include your name and a short message.' });
  }
  if (!email && !phone) {
    return res.status(400).json({ error: 'Please include either an email address or phone number.' });
  }

  const profile = db.portfolio(req.portfolioUser).prepare('SELECT email FROM profile WHERE id = 1').get() || {};
  const recipient = cleanContactField(
    profile.email || process.env.NAKAI_CONTACT_TO || process.env.GMAIL_SMTP_USER,
    180
  );
  if (!recipient) {
    return res.status(503).json({ error: 'Nakai contact email is not configured yet.' });
  }

  const transport = getGmailTransport();
  if (!transport) {
    return res.status(503).json({ error: 'Contact email service is not configured yet.' });
  }

  const smtpUser = process.env.GMAIL_SMTP_USER;
  const fromName = cleanContactField(process.env.CONTACT_FROM_NAME || 'Nakai portfolio', 120);
  const timestamp = new Date().toISOString();
  const text = [
    'CONTACT FORM COMPLETED',
    '',
    `Name: ${name}`,
    `Email: ${email || '(not provided)'}`,
    `Phone: ${phone || '(not provided)'}`,
    `Source: ${req.hostname}`,
    `Timestamp: ${timestamp}`,
    '',
    'Message:',
    message,
  ].join('\n');

  try {
    await transport.sendMail({
      to: recipient,
      from: `"${fromName.replace(/"/g, "'")}" <${smtpUser}>`,
      replyTo: email || undefined,
      subject: 'CONTACT FORM COMPLETED',
      text,
    });
    return res.json({ ok: true, message: 'Thanks, your message has been sent.' });
  } catch (err) {
    console.error('[nakai-contact]', err);
    return res.status(502).json({ error: 'Could not send the message just now. Please try LinkedIn instead.' });
  }
});

router.get('/executive-summary', (req, res) => {
  const pdb = db.portfolio(req.portfolioUser);
  const profile = pdb.prepare('SELECT * FROM profile WHERE id = 1').get() || {};
  if (req.portfolioUser === 'douglas' && !profile.phone_public) {
    profile.phone_public = '+353 (0) 896003148';
  }
  const experiences = getPortfolioExperiences(pdb, req.portfolioUser);
  const skills = pdb.prepare('SELECT * FROM skills ORDER BY level, display_order').all();
  const candidates = pdb.prepare(`
    SELECT * FROM skill_candidates
     WHERE user = ? AND status IN ('promoted_jd', 'chat_only')
     ORDER BY CASE status WHEN 'promoted_jd' THEN 0 ELSE 1 END, occurrences DESC, last_seen_at DESC
  `).all(req.portfolioUser);
  const cv = ensureAiBuildsCv(pdb.prepare('SELECT * FROM cv_context').all()
    .reduce((acc, row) => { acc[row.section] = row.content; return acc; }, {}), req.portfolioUser);

  const fullName = profile.full_name || (req.portfolioUser === 'douglas' ? 'Douglas McLellan' : 'Nakai McLellan');
  const monthLabel = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const filename = `${fullName} CV - ${monthLabel}.pdf`.replace(/[\\/:*?"<>|]+/g, '-');

  buildExecutiveSummaryPdf({ user: req.portfolioUser, profile, cv, experiences, skills, candidates })
    .then(buf => {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buf);
    })
    .catch(err => {
      console.error('[executive-summary-pdf]', err);
      res.status(500).send('Could not generate executive summary PDF');
    });
});

// ── Standalone full-page chat (mobile-first) ──────────────────────────────────
router.get('/chat', (req, res) => {
  const pdb = db.portfolio(req.portfolioUser);
  const profile = pdb.prepare('SELECT full_name FROM profile WHERE id = 1').get() || {};
  res.render('portfolio/chat', {
    user: req.portfolioUser,
    fullName: profile.full_name || (req.portfolioUser === 'douglas' ? 'Douglas McLellan' : 'Nakai McLellan'),
    availableModels: getChatModels(req.portfolioUser),
  });
});

// ── Portfolio AI chat ─────────────────────────────────────────────────────────
const PUBLIC_PORTFOLIO_CHAT_FALLBACK = 'free';
const PUBLIC_PORTFOLIO_ANALYSER_FALLBACK = 'free';

router.post('/api/chat', requireSameOrigin, publicAiLimiter, async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Empty message' });
  if (String(message).length > 6000) return res.status(400).json({ error: 'Message too long' });

  const pdb = db.portfolio(req.portfolioUser);

  const profile = pdb.prepare('SELECT * FROM profile WHERE id = 1').get() || {};
  const cvRows = pdb.prepare('SELECT section, content FROM cv_context').all();
  const expRows = getPortfolioExperiences(pdb, req.portfolioUser);
  const skillRows = pdb.prepare(
    'SELECT name, level, category, self_rating, evidence, honest_notes, years_experience, last_used FROM skills ORDER BY level, display_order'
  ).all();
  const gaps = pdb.prepare('SELECT * FROM gaps ORDER BY display_order, rowid').all();
  const faqs = pdb.prepare('SELECT * FROM faqs ORDER BY is_common DESC, display_order, rowid').all();
  const aiInstructions = pdb.prepare('SELECT text FROM ai_instructions ORDER BY display_order, rowid').all();
  const chatOnlyCandidates = pdb.prepare(`
    SELECT term, evidence, occurrences
      FROM skill_candidates
     WHERE user = ? AND status = 'chat_only'
  ORDER BY occurrences DESC, last_seen_at DESC
  `).all(req.portfolioUser);
  const profileBlock = profile.full_name ? `## Profile
- Name: ${profile.full_name || ''}
- Email: ${profile.email || '(not shared unless asked)'}
- Current title: ${profile.current_title || ''}
- Location: ${profile.location || ''}
- Target titles: ${profile.target_titles || ''}
- Target company stages: ${profile.target_company_stages || ''}
- Elevator pitch: ${profile.elevator_pitch || ''}
- Career narrative: ${profile.career_narrative || ''}
- Looking for: ${profile.looking_for || ''}
- NOT looking for: ${profile.not_looking_for || ''}
- Management style: ${profile.management_style || ''}
- Work style: ${profile.work_style || ''}
- Salary expectation: ${profile.salary_min || '?'}–${profile.salary_max || '?'} ${profile.salary_currency || 'EUR'}
- Availability: ${profile.availability_status || ''}${profile.available_from ? ' (notice period: ' + profile.available_from + ')' : ''}
- Remote preference: ${profile.remote_preference || ''}` : '';

  const valuesBlock = (profile.must_haves || profile.dealbreakers || profile.mgmt_prefs) ? `## Values & Culture
- Must-haves: ${profile.must_haves || ''}
- Dealbreakers: ${profile.dealbreakers || ''}
- Management preferences: ${profile.mgmt_prefs || ''}
- Team size preferences: ${profile.team_size_prefs || ''}
- Handling conflict: ${profile.conflict_handling || ''}
- Handling ambiguity: ${profile.ambiguity_handling || ''}
- Handling failure: ${profile.failure_handling || ''}` : '';

  const cvContext = [
    profileBlock,
    cvRows.length ? '## CV copy\n' + cvRows.map(r => `**${r.section}:** ${r.content}`).join('\n') : '',
    getAiBuildsCvBlock(cvRows, req.portfolioUser),
    expRows.length ? '## Experience\n' + expRows.map(e => `- **${e.role}**, ${e.company} (${e.start_date || '?'} – ${e.end_date || 'Present'})${e.description ? ': ' + e.description : ''}`).join('\n') : '',
    skillRows.length ? '## Skills\n' + skillRows.map(s => {
      const bits = [`${s.name} (${s.level}`];
      if (s.self_rating) bits.push(`rated ${s.self_rating}/5`);
      if (s.years_experience) bits.push(`${s.years_experience}y`);
      if (s.last_used) bits.push(`last used ${s.last_used}`);
      let line = `- ${bits.join(', ')})`;
      if (s.evidence) line += ` — evidence: ${s.evidence}`;
      if (s.honest_notes) line += ` — note: ${s.honest_notes}`;
      return line;
    }).join('\n') : '',
    gaps.length ? '## Gaps (be honest about these)\n' + gaps.map(g => `- [${g.gap_type}] ${g.description || ''} — why: ${g.why || ''}${g.interested_in_learning ? ' (interested in learning)' : ''}`).join('\n') : '',
    valuesBlock,
    faqs.length ? '## Pre-answered FAQs (use these phrasings)\n' + faqs.map(f => `Q: ${f.question}\nA: ${f.answer || ''}`).join('\n\n') : '',
    chatOnlyCandidates.length ? '## Emerging topics from CV context\n' + chatOnlyCandidates.map(c =>
      `- ${c.term}${c.evidence ? ` — evidence: ${String(c.evidence).split('\n')[0]}` : ''}`
    ).join('\n') : '',
    getPublishedThinkingBlock(req.portfolioUser),
  ].filter(Boolean).join('\n\n');

  const douglasHonestNotes = req.portfolioUser === 'douglas' ? `\n## Honest notes (always use these when relevant)
- No formal Microsoft certifications (MS-102, SC-300, etc). All capability is self-taught and demonstrated through operational delivery.
- Proof available: four-year sole-admin tenure at Cricket Ireland (checkable), GitHub repositories for three shipped tools, Beacon Hospital current role.
- If a recruiter asks about certifications, acknowledge the gap honestly and redirect to the evidence above.
- The candidate is direct about this and does not want it obscured.` : '';

  const honestyLevel = profile.honesty_level || 7;
  const customInstructions = aiInstructions.length
    ? '\n\nSpecific instructions from the candidate:\n' + aiInstructions.map(i => `- ${i.text}`).join('\n')
    : '';

  const sid = sessionId || uuid();

  // Recent conversation history
  const history = pdb.prepare(
    'SELECT role, content FROM portfolio_messages WHERE session_id = ? ORDER BY ts ASC LIMIT 20'
  ).all(sid);

  const honestyDescriptor = honestyLevel <= 3 ? 'diplomatic and polished' :
                           honestyLevel <= 6 ? 'balanced and measured' :
                           honestyLevel <= 8 ? 'direct and honest' : 'brutally honest';

  const systemPrompt = `${PORTFOLIO_CHAT_GUARD}

${getSystemPrompt('portfolio_chat', req.portfolioUser, PROMPTS.portfolio_chat)}

You are ${profile.full_name || (req.portfolioUser === 'douglas' ? 'Douglas McLellan' : 'Nakai McLellan')}.

Tone: ${honestyDescriptor} (honesty level ${honestyLevel}/10).
- Only reference information in the context below — never fabricate.
- Company names, role titles, and employment dates in the Experience section are immutable verified facts. Never alter, infer, merge, extend, or add to them.
- Projects, clients, vendors, technologies, publications, and job descriptions are not employers or employment roles.
- If the fit genuinely isn't there, say so; it's okay to recommend someone not hire you.
- Don't oversell. Don't hedge. Be specific.
- This is a professional career chat for recruiters and hiring managers. Do not discuss personal matters (family members, health, personal life). If asked, say: "This chat is focused on my professional career — I'm not the right source for personal topics."${customInstructions}

Your context:
${wrapUntrustedBlock('candidate_context', (cvContext || 'No CV context loaded yet.') + douglasHonestNotes)}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: wrapUntrustedBlock('visitor_message', message) },
  ];

  // Save visitor message
  pdb.prepare(
    'INSERT INTO portfolio_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)'
  ).run(uuid(), sid, 'user', message);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    let full = '';
    const result = await routeMessage({
      model: getSystemModelKey('portfolio_chat', req.portfolioUser, PUBLIC_PORTFOLIO_CHAT_FALLBACK),
      messages,
      user: req.portfolioUser,
      noSearch: true,
      onChunk: (chunk) => {
        full += chunk;
        res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
      },
    });

    pdb.prepare(
      'INSERT INTO portfolio_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)'
    ).run(uuid(), sid, 'assistant', result.content);

    res.write(`data: ${JSON.stringify({ done: true, sessionId: sid })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

// ── JD analyser ───────────────────────────────────────────────────────────────
router.post('/api/analyse-jd', requireSameOrigin, publicAiLimiter, async (req, res) => {
  const { jd } = req.body;
  if (!jd?.trim()) return res.status(400).json({ error: 'No JD provided' });
  if (String(jd).length > 20000) return res.status(400).json({ error: 'Job description too long' });

  const pdb = db.portfolio(req.portfolioUser);
  const profile = pdb.prepare('SELECT * FROM profile WHERE id = 1').get() || {};
  const cleanJd = jd.trim();
  const submissionId = uuid();
  pdb.prepare(
    'INSERT INTO jd_submissions (id, job_description) VALUES (?, ?)'
  ).run(submissionId, cleanJd);
  const cvRows = pdb.prepare('SELECT section, content FROM cv_context').all();
  const expRows = getPortfolioExperiences(pdb, req.portfolioUser);
  const skillRows = pdb.prepare(
    'SELECT name, level, category FROM skills ORDER BY level, display_order'
  ).all();
  const cvContext = [
    cvRows.map(r => `**${r.section}:** ${r.content}`).join('\n'),
    getAiBuildsCvBlock(cvRows, req.portfolioUser),
    'Experience:\n' + expRows.map(e => `- ${e.role}, ${e.company} (${e.start_date || '?'} – ${e.end_date || 'Present'})${e.description ? ': ' + e.description : ''}`).join('\n'),
    'Skills:\n' + skillRows.map(s => `- ${s.name} (${s.level})`).join('\n'),
    getPublishedThinkingBlock(req.portfolioUser),
  ].filter(Boolean).join('\n\n');

  const jdFullName = profile.full_name || (req.portfolioUser === 'douglas' ? 'Douglas McLellan' : 'Nakai McLellan');
  const jdFirstName = jdFullName.split(' ')[0];

  const messages = [{
    role: 'system',
    content: `${JD_ANALYSER_GUARD}\n\n${getSystemPrompt('jd_analyser', req.portfolioUser, PROMPTS.jd_analyser)}

Company names, role titles, and employment dates in the CV Experience section are immutable verified facts. Never alter them or treat a project, client, vendor, technology, publication, or job description as employment.

Items in the "Published thinking" section are published opinion and analysis. They may be cited (with their links) as evidence of domain thinking relevant to a role, but never as work experience — where a role requires hands-on experience the candidate lacks, say so plainly and reference the published thinking as a partial signal only.`,
  }, {
    role: 'user',
    content: `CV Context:
${wrapUntrustedBlock('candidate_context', cvContext || 'No CV data available.')}

Job Description:
${wrapUntrustedBlock('job_description', cleanJd)}

Candidate name: ${jdFullName}. Address the final verdict using ${jdFirstName}'s name.`,
  }];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const result = await routeMessage({
      model: getSystemModelKey('jd_analyser', req.portfolioUser, PUBLIC_PORTFOLIO_ANALYSER_FALLBACK),
      messages,
      user: req.portfolioUser,
      noSearch: true,
      onChunk: (chunk) => res.write(`data: ${JSON.stringify({ chunk })}\n\n`),
    });
    const contactBlock = getAnalyserContactBlock(result.content, {
      user: req.portfolioUser,
      email: profile.email || (req.portfolioUser === 'douglas' ? 'douglas@mclellan.scot' : ''),
      phone: getPublicPhone(req.portfolioUser, profile),
    });
    const finalResponse = `${result.content}\n\n${contactBlock}`;
    pdb.prepare(
      'UPDATE jd_submissions SET ai_response = ? WHERE id = ?'
    ).run(finalResponse, submissionId);
    res.write(`data: ${JSON.stringify({ chunk: `\n\n${contactBlock}` })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

module.exports = router;
