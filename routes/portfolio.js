const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { routeMessage } = require('../lib/router');
const { uuid } = require('../lib/id');
const PDFDocument = require('pdfkit');
const {
  AI_ASSISTED_APP_BUILDS_INTRO,
  AI_ASSISTED_APP_BUILDS_PROJECTS,
  getAiAssistedBuildsText,
} = require('../lib/aiBuilds');
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

async function buildExecutiveSummaryPdf({ user, profile, cv, experiences }) {
  const fullName = profile.full_name || (user === 'douglas' ? 'Douglas McLellan' : 'Nakai McLellan');
  const title = cv.role_label || profile.current_title || '';
  const summary = cv.summary || profile.elevator_pitch || '';
  const website = getPortfolioBaseUrl(user);
  const email = profile.email || (user === 'douglas' ? 'douglas@mclellan.scot' : '');
  const phone = getPublicPhone(user, profile);
  const location = profile.location || '';
  const linkedin = cv.linkedin_url || '';
  const highlights = experiences.slice(0, 5);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 52, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const drawRule = () => {
      const y = doc.y;
      doc.save();
      doc.moveTo(52, y).lineTo(543, y).lineWidth(1).strokeColor('#d8d4e8').stroke();
      doc.restore();
      doc.moveDown(1);
    };

    doc.fillColor('#1b1b23').font('Helvetica-Bold').fontSize(24).text(fullName);
    if (title) {
      doc.moveDown(0.15);
      doc.fillColor('#4a4760').font('Helvetica').fontSize(12).text(title);
    }

    doc.moveDown(0.35);
    doc.font('Helvetica').fontSize(10).fillColor('#5f5b74');
    const contactBits = [email, phone, website].filter(Boolean).join('   •   ');
    if (contactBits) doc.text(contactBits);
    if (location || linkedin) {
      doc.moveDown(0.15);
      doc.text([location, linkedin].filter(Boolean).join('   •   '));
    }

    doc.moveDown(0.8);
    drawRule();

    if (summary) {
      doc.fillColor('#4648d4').font('Helvetica-Bold').fontSize(11).text('EXECUTIVE SUMMARY');
      doc.moveDown(0.35);
      doc.fillColor('#1b1b23').font('Helvetica').fontSize(11).text(summary, { lineGap: 3 });
      doc.moveDown(0.8);
    }

    drawRule();
    doc.fillColor('#4648d4').font('Helvetica-Bold').fontSize(11).text('KEY EXPERIENCE');
    doc.moveDown(0.45);

    highlights.forEach((exp, idx) => {
      const dates = `${exp.start_date || '?'} - ${exp.end_date || 'Present'}`;
      doc.fillColor('#1b1b23').font('Helvetica-Bold').fontSize(11)
        .text(`${exp.role} | ${exp.company}`);
      doc.fillColor('#5f5b74').font('Helvetica').fontSize(10)
        .text(dates);
      if (exp.description) {
        doc.moveDown(0.15);
        doc.fillColor('#1b1b23').font('Helvetica').fontSize(10.5)
          .text(exp.description, { lineGap: 2 });
      }
      if (idx < highlights.length - 1) doc.moveDown(0.8);
    });

    if (shouldShowAiBuilds(user)) {
      doc.moveDown(1);
      drawRule();
      doc.fillColor('#4648d4').font('Helvetica-Bold').fontSize(11).text('AI-ASSISTED APP BUILDS');
      doc.moveDown(0.45);
      AI_ASSISTED_APP_BUILDS_PROJECTS.forEach((project, idx) => {
        doc.fillColor('#1b1b23').font('Helvetica-Bold').fontSize(10.5).text(project.name);
        doc.moveDown(0.12);
        doc.fillColor('#1b1b23').font('Helvetica').fontSize(9.5)
          .text(project.summary, { lineGap: 2 });
        doc.moveDown(0.12);
        doc.fillColor('#5f5b74').font('Helvetica').fontSize(8.5)
          .text(project.stack, { lineGap: 1 });
        if (idx < AI_ASSISTED_APP_BUILDS_PROJECTS.length - 1) doc.moveDown(0.55);
      });
    }

    doc.moveDown(0.9);
    drawRule();
    doc.fillColor('#5f5b74').font('Helvetica').fontSize(9)
      .text(`Portfolio: ${website}`);

    doc.end();
  });
}

function getAnalyserContactBlock(resultContent, { email, phone }) {
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
  const pass = process.env.GMAIL_SMTP_APP_PASSWORD;
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

// ── Public portfolio ──────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const pdb = db.portfolio(req.portfolioUser);
  const profile = pdb.prepare('SELECT * FROM profile WHERE id = 1').get() || {};
  if (req.portfolioUser === 'douglas' && !profile.phone_public) {
    profile.phone_public = '+353 (0) 896003148';
  }
  const experiences = pdb.prepare(
    'SELECT * FROM experiences WHERE is_cv_context = 1 ORDER BY display_order ASC'
  ).all();
  const skills = pdb.prepare(
    'SELECT * FROM skills ORDER BY level, display_order'
  ).all();
  const cv = ensureAiBuildsCv(pdb.prepare(
    'SELECT * FROM cv_context'
  ).all().reduce((acc, row) => { acc[row.section] = row.content; return acc; }, {}), req.portfolioUser);

  res.render('portfolio/index', {
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
  const experiences = pdb.prepare(
    'SELECT role, company, start_date, end_date, description FROM experiences WHERE is_cv_context = 1 ORDER BY display_order ASC'
  ).all();
  const cv = ensureAiBuildsCv(pdb.prepare('SELECT * FROM cv_context').all()
    .reduce((acc, row) => { acc[row.section] = row.content; return acc; }, {}), req.portfolioUser);

  const fullName = profile.full_name || (req.portfolioUser === 'douglas' ? 'Douglas McLellan' : 'Nakai McLellan');
  const filename = `${fullName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-executive-summary.pdf`;

  buildExecutiveSummaryPdf({ user: req.portfolioUser, profile, cv, experiences })
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
router.post('/api/chat', requireSameOrigin, publicAiLimiter, async (req, res) => {
  const { message, sessionId, model } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Empty message' });
  if (String(message).length > 6000) return res.status(400).json({ error: 'Message too long' });

  const pdb = db.portfolio(req.portfolioUser);
  const hubDb = db.hub();

  const profile = pdb.prepare('SELECT * FROM profile WHERE id = 1').get() || {};
  const cvRows = pdb.prepare('SELECT section, content FROM cv_context').all();
  const expRows = pdb.prepare(
    'SELECT role, company, start_date, end_date, description FROM experiences WHERE is_cv_context = 1 ORDER BY display_order ASC'
  ).all();
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
  const hubCvMessages = hubDb.prepare(`
    SELECT m.content FROM messages m
    JOIN projects p ON m.project_id = p.id
    WHERE p.user = ? AND p.is_cv_context = 1 AND m.role = 'assistant'
    ORDER BY m.ts DESC LIMIT 20
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
    hubCvMessages.length ? '## Additional notes\n' + hubCvMessages.map(m => m.content).join('\n\n') : '',
  ].filter(Boolean).join('\n\n');

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

You are ${profile.full_name || (req.portfolioUser === 'douglas' ? 'Douglas McLellan' : 'Nakai McLellan')}, speaking in first person to a recruiter or hiring manager about your professional work and career.

Tone: ${honestyDescriptor} (honesty level ${honestyLevel}/10).
- Only reference information in the context below — never fabricate.
- If the fit genuinely isn't there, say so; it's okay to recommend someone not hire you.
- Don't oversell. Don't hedge. Be specific.${customInstructions}

Your context:
${wrapUntrustedBlock('candidate_context', cvContext || 'No CV context loaded yet.')}`;

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
      model: model || 'deepseek-v3',
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
  const expRows = pdb.prepare(
    'SELECT role, company, start_date, end_date, description FROM experiences WHERE is_cv_context = 1 ORDER BY display_order ASC'
  ).all();
  const skillRows = pdb.prepare(
    'SELECT name, level, category FROM skills ORDER BY level, display_order'
  ).all();
  const cvContext = [
    cvRows.map(r => `**${r.section}:** ${r.content}`).join('\n'),
    getAiBuildsCvBlock(cvRows, req.portfolioUser),
    'Experience:\n' + expRows.map(e => `- ${e.role}, ${e.company} (${e.start_date || '?'} – ${e.end_date || 'Present'})${e.description ? ': ' + e.description : ''}`).join('\n'),
    'Skills:\n' + skillRows.map(s => `- ${s.name} (${s.level})`).join('\n'),
  ].filter(Boolean).join('\n\n');

  const messages = [{
    role: 'system',
    content: JD_ANALYSER_GUARD,
  }, {
    role: 'user',
    content: `You are helping a recruiter or hiring manager decide whether to contact this candidate about a role. Be direct, commercially useful, and evidence-led. If the fit is weak or partial, say so clearly. Do not frame the answer as advice to the candidate about whether they should apply.

CV Context:
${wrapUntrustedBlock('candidate_context', cvContext || 'No CV data available.')}

Job Description:
${wrapUntrustedBlock('job_description', cleanJd)}

Provide:
1. Contact recommendation (Strong outreach / Worth a conversation / Probably not a fit) with one sentence reason
2. The strongest matching capabilities or experiences
3. Any gaps, risks, or missing evidence a recruiter should note
4. The most promising angle for outreach if they do contact the candidate
5. A short recruiter verdict on whether Douglas is worth approaching for this role now`,
  }];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const result = await routeMessage({
      model: 'claude-sonnet',
      messages,
      user: req.portfolioUser,
      noSearch: true,
      onChunk: (chunk) => res.write(`data: ${JSON.stringify({ chunk })}\n\n`),
    });
    const contactBlock = getAnalyserContactBlock(result.content, {
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
