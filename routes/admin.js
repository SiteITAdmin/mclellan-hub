const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { uuid } = require('../lib/id');
const { scanCvContextCandidates } = require('../lib/cvCandidates');
const { routeMessage } = require('../lib/router');
const { finishGoogleAuth, startGoogleAuth } = require('../lib/google-auth');
const { createRateLimiter, requireSameOrigin } = require('../lib/security');

function requireAdmin(req, res, next) {
  if (req.session?.adminUser === req.portfolioUser) return next();
  res.redirect('/admin/login');
}

function getAdminReturnTo(req, fallback = '/admin') {
  const value = req.body?.return_to || fallback;
  return /^\/admin(#[a-z0-9-]+)?$/i.test(value) ? value : fallback;
}

function getPortfolioDisplayName(user) {
  const names = { douglas: 'Douglas', nakai: 'Nakai' };
  return names[user] || user;
}

function rowsToCvObject(rows) {
  return rows.reduce((acc, row) => {
    acc[row.section] = row.content;
    return acc;
  }, {});
}

function clip(text, max = 900) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1).trim() + '...' : clean;
}

function buildSummaryDraftPrompt({ user, profile, cv, experiences, skills, candidates }) {
  const fullName = profile.full_name || (user === 'douglas' ? 'Douglas McLellan' : 'Nakai McLellan');
  const role = cv.role_label || profile.current_title || '';
  const currentSummary = cv.summary || profile.elevator_pitch || '';
  const expLines = experiences
    .filter(e => e.is_cv_context)
    .slice(0, 6)
    .map(e => `- ${e.role}, ${e.company} (${e.start_date || '?'} - ${e.end_date || 'Present'}): ${clip(e.description, 280)}`)
    .join('\n');
  const skillLines = skills
    .filter(s => s.level !== 'gap')
    .slice(0, 14)
    .map(s => `- ${s.name}${s.level ? ` (${s.level})` : ''}${s.evidence ? `: ${clip(s.evidence, 220)}` : ''}`)
    .join('\n');
  const topicLines = candidates
    .slice(0, 12)
    .map(c => `- ${c.term} (${c.occurrences} mentions, ${c.status}): ${clip(c.evidence, 360)}`)
    .join('\n');

  return `Draft a replacement executive summary for a public portfolio CV.

Return only the summary text. Use 2-3 polished sentences, around 80-130 words.
Be specific, recruiter-facing, and evidence-backed. Do not invent claims. Do not use first person.
Correct spelling and grammar. Avoid keyword stuffing and avoid listing every tool.

Candidate:
- Name: ${fullName}
- Current role/title: ${role}
- Location: ${profile.location || ''}
- Target titles: ${profile.target_titles || ''}
- Looking for: ${profile.looking_for || ''}

Current summary:
${currentSummary || '(none)'}

Selected experience:
${expLines || '(none)'}

Reviewed skills:
${skillLines || '(none)'}

Reviewed detected topics from CV context:
${topicLines || '(none)'}`;
}

async function draftExecutiveSummary({ user, profile, cv, experiences, skills, candidates }) {
  const messages = [
    {
      role: 'system',
      content: 'You write concise, accurate executive summaries for senior professional CVs. You use only supplied evidence.',
    },
    {
      role: 'user',
      content: buildSummaryDraftPrompt({ user, profile, cv, experiences, skills, candidates }),
    },
  ];
  let content = '';
  const result = await routeMessage({
    model: 'deepseek-v3',
    messages,
    user,
    noSearch: true,
    searchProvider: 'off',
    onChunk: chunk => { content += String(chunk || '').replace(/^\x00/, ''); },
  });
  return (result?.content || content)
    .replace(/^\x00/, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

router.get('/admin/login', (req, res) => {
  res.render('admin/login', { user: req.portfolioUser, displayUser: getPortfolioDisplayName(req.portfolioUser), error: null });
});

router.get('/admin/auth/google', (req, res, next) =>
  startGoogleAuth({ purpose: 'portfolio-admin', user: req.portfolioUser, callbackPath: '/admin/auth/google/callback', returnTo: '/admin' })(req, res, next)
);

router.get('/admin/auth/google/callback', (req, res, next) =>
  finishGoogleAuth({ purpose: 'portfolio-admin', user: req.portfolioUser, callbackPath: '/admin/auth/google/callback', sessionKey: 'adminUser', returnTo: '/admin' })(req, res, next)
);

router.post('/admin/logout', requireSameOrigin, (req, res) => {
  req.session.adminUser = null;
  res.redirect('/admin/login');
});

router.use((req, res, next) => {
  if (req.method === 'POST' && req.path.startsWith('/admin') && req.path !== '/admin/login' && req.path !== '/admin/logout') {
    return requireSameOrigin(req, res, () => {
      const originalRedirect = res.redirect.bind(res);
      res.redirect = (...args) => {
        const target = args[args.length - 1];
        if (typeof target === 'string' && target.startsWith('/admin')) {
          args[args.length - 1] = getAdminReturnTo(req, target);
        }
        return originalRedirect(...args);
      };
      next();
    });
  }
  return next();
});

router.get('/admin', requireAdmin, (req, res) => {
  const pdb = db.portfolio(req.portfolioUser);
  if (req.portfolioUser === 'douglas') {
    const hasPhone = pdb.prepare('SELECT phone_public FROM profile WHERE id = 1').get();
    if (!hasPhone?.phone_public) {
      pdb.prepare('UPDATE profile SET phone_public = ?, updated_at = unixepoch() WHERE id = 1')
        .run('+353 (0) 896003148');
    }
  }
  scanCvContextCandidates({ hub: db.hub(), portfolio: pdb, user: req.portfolioUser });
  const experiences = pdb.prepare('SELECT * FROM experiences ORDER BY display_order').all();
  const skills = pdb.prepare('SELECT * FROM skills ORDER BY level, display_order').all();
  const cvRows = pdb.prepare('SELECT * FROM cv_context ORDER BY section').all();
  const cv = rowsToCvObject(cvRows);
  const profile = pdb.prepare('SELECT * FROM profile WHERE id = 1').get() || {};
  const gaps = pdb.prepare('SELECT * FROM gaps ORDER BY display_order, rowid').all();
  const faqs = pdb.prepare('SELECT * FROM faqs ORDER BY display_order, rowid').all();
  const aiInstructions = pdb.prepare('SELECT * FROM ai_instructions ORDER BY display_order, rowid').all();
  const jdSubmissions = pdb.prepare(
    'SELECT * FROM jd_submissions ORDER BY created_at DESC LIMIT 100'
  ).all();
  const skillCandidates = pdb.prepare(
    "SELECT * FROM skill_candidates WHERE user = ? ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'chat_only' THEN 1 WHEN 'promoted_jd' THEN 2 ELSE 3 END, occurrences DESC, last_seen_at DESC"
  ).all(req.portfolioUser);
  const hubDb = db.hub();
  const projects = hubDb.prepare(
    'SELECT * FROM projects WHERE user = ? ORDER BY name'
  ).all(req.portfolioUser);

  res.render('admin/index', {
    user: req.portfolioUser,
    displayUser: getPortfolioDisplayName(req.portfolioUser),
    experiences, skills, cvRows, cv, profile, gaps, faqs, aiInstructions, jdSubmissions, skillCandidates, projects,
    summaryDraft: req.session.summaryDraft || null,
    summaryDraftError: req.session.summaryDraftError || null,
  });
  req.session.summaryDraftError = null;
});

// ── Profile (one row per portfolio user) ──────────────────────────────────────
router.post('/admin/profile', requireAdmin, (req, res) => {
  const pdb = db.portfolio(req.portfolioUser);
  const fields = [
    'full_name','email','current_title','location','target_titles','target_company_stages',
    'elevator_pitch','career_narrative','looking_for','not_looking_for',
    'management_style','work_style','salary_min','salary_max','salary_currency',
    'availability_status','available_from','remote_preference','phone_public',
    'must_haves','dealbreakers','mgmt_prefs','team_size_prefs',
    'conflict_handling','ambiguity_handling','failure_handling','honesty_level',
  ];
  const values = fields.map(f => {
    const v = req.body[f];
    if (v === undefined || v === '') return null;
    if (['salary_min','salary_max','honesty_level'].includes(f)) return parseInt(v, 10) || null;
    if (f === 'target_company_stages' && Array.isArray(v)) return v.join(',');
    return v;
  });
  const sets = fields.map(f => `${f} = ?`).join(', ');
  pdb.prepare(`UPDATE profile SET ${sets}, updated_at = unixepoch() WHERE id = 1`).run(...values);
  res.redirect('/admin#profile');
});

// ── Skills (extended) ─────────────────────────────────────────────────────────
router.post('/admin/skills/:id', requireAdmin, (req, res) => {
  const { name, level, category, display_order, self_rating, evidence, honest_notes, years_experience, last_used } = req.body;
  db.portfolio(req.portfolioUser).prepare(`
    UPDATE skills SET name=?, level=?, category=?, display_order=?,
                      self_rating=?, evidence=?, honest_notes=?, years_experience=?, last_used=?
     WHERE id=?
  `).run(
    name, level, category || null, parseInt(display_order, 10) || 0,
    parseInt(self_rating, 10) || null, evidence || null, honest_notes || null,
    parseInt(years_experience, 10) || null, last_used || null, req.params.id
  );
  res.redirect('/admin#skills');
});

// ── Gaps ──────────────────────────────────────────────────────────────────────
router.post('/admin/gaps', requireAdmin, (req, res) => {
  const { gap_type, description, why, interested_in_learning, display_order } = req.body;
  db.portfolio(req.portfolioUser).prepare(
    'INSERT INTO gaps (id, gap_type, description, why, interested_in_learning, display_order) VALUES (?,?,?,?,?,?)'
  ).run(uuid(), gap_type, description, why, interested_in_learning ? 1 : 0, parseInt(display_order, 10) || 0);
  res.redirect('/admin#gaps');
});
router.post('/admin/gaps/:id', requireAdmin, (req, res) => {
  const { gap_type, description, why, interested_in_learning, display_order } = req.body;
  db.portfolio(req.portfolioUser).prepare(
    'UPDATE gaps SET gap_type=?, description=?, why=?, interested_in_learning=?, display_order=? WHERE id=?'
  ).run(gap_type, description, why, interested_in_learning ? 1 : 0, parseInt(display_order, 10) || 0, req.params.id);
  res.redirect('/admin#gaps');
});
router.post('/admin/gaps/:id/delete', requireAdmin, (req, res) => {
  db.portfolio(req.portfolioUser).prepare('DELETE FROM gaps WHERE id = ?').run(req.params.id);
  res.redirect('/admin#gaps');
});

// ── FAQs ──────────────────────────────────────────────────────────────────────
router.post('/admin/faqs', requireAdmin, (req, res) => {
  const { question, answer, is_common, display_order } = req.body;
  db.portfolio(req.portfolioUser).prepare(
    'INSERT INTO faqs (id, question, answer, is_common, display_order) VALUES (?,?,?,?,?)'
  ).run(uuid(), question, answer, is_common ? 1 : 0, parseInt(display_order, 10) || 0);
  res.redirect('/admin#faq');
});
router.post('/admin/faqs/:id', requireAdmin, (req, res) => {
  const { question, answer, is_common, display_order } = req.body;
  db.portfolio(req.portfolioUser).prepare(
    'UPDATE faqs SET question=?, answer=?, is_common=?, display_order=? WHERE id=?'
  ).run(question, answer, is_common ? 1 : 0, parseInt(display_order, 10) || 0, req.params.id);
  res.redirect('/admin#faq');
});
router.post('/admin/faqs/:id/delete', requireAdmin, (req, res) => {
  db.portfolio(req.portfolioUser).prepare('DELETE FROM faqs WHERE id = ?').run(req.params.id);
  res.redirect('/admin#faq');
});

// ── Skill candidates ──────────────────────────────────────────────────────────
router.post('/admin/skill-candidates/rescan', requireAdmin, (req, res) => {
  scanCvContextCandidates({ hub: db.hub(), portfolio: db.portfolio(req.portfolioUser), user: req.portfolioUser });
  res.redirect('/admin#skill-candidates');
});

router.post('/admin/skill-candidates/:id/promote-jd', requireAdmin, (req, res) => {
  const pdb = db.portfolio(req.portfolioUser);
  const candidate = pdb.prepare('SELECT * FROM skill_candidates WHERE id = ? AND user = ?')
    .get(req.params.id, req.portfolioUser);
  if (!candidate) return res.redirect('/admin#skill-candidates');

  let skill = pdb.prepare('SELECT * FROM skills WHERE lower(name) = lower(?)').get(candidate.term);
  if (!skill) {
    const nextOrder = (pdb.prepare('SELECT COALESCE(MAX(display_order), 0) AS max_order FROM skills').get().max_order || 0) + 10;
    const skillId = uuid();
    pdb.prepare(`
      INSERT INTO skills (id, name, level, category, display_order, evidence, honest_notes)
      VALUES (?, ?, 'moderate', 'cv-context', ?, ?, ?)
    `).run(
      skillId,
      candidate.term,
      nextOrder,
      candidate.evidence || null,
      'Promoted from repeated CV-context activity.'
    );
    skill = { id: skillId };
  } else if (candidate.evidence && !String(skill.evidence || '').includes(candidate.evidence)) {
    const mergedEvidence = [skill.evidence, candidate.evidence].filter(Boolean).join('\n\n');
    pdb.prepare('UPDATE skills SET evidence = ? WHERE id = ?').run(mergedEvidence, skill.id);
  }

  pdb.prepare(`
    UPDATE skill_candidates
       SET status = 'promoted_jd', promoted_skill_id = ?, updated_at = unixepoch()
     WHERE id = ?
  `).run(skill.id, candidate.id);

  res.redirect('/admin#skill-candidates');
});

router.post('/admin/skill-candidates/:id/promote-chat', requireAdmin, (req, res) => {
  db.portfolio(req.portfolioUser).prepare(`
    UPDATE skill_candidates SET status = 'chat_only', updated_at = unixepoch()
    WHERE id = ? AND user = ?
  `).run(req.params.id, req.portfolioUser);
  res.redirect('/admin#skill-candidates');
});

router.post('/admin/skill-candidates/:id/dismiss', requireAdmin, (req, res) => {
  db.portfolio(req.portfolioUser).prepare(`
    UPDATE skill_candidates SET status = 'dismissed', updated_at = unixepoch()
    WHERE id = ? AND user = ?
  `).run(req.params.id, req.portfolioUser);
  res.redirect('/admin#skill-candidates');
});

router.post('/admin/skill-candidates/:id/reset', requireAdmin, (req, res) => {
  db.portfolio(req.portfolioUser).prepare(`
    UPDATE skill_candidates SET status = 'pending', updated_at = unixepoch()
    WHERE id = ? AND user = ?
  `).run(req.params.id, req.portfolioUser);
  res.redirect('/admin#skill-candidates');
});

// ── AI Instructions ───────────────────────────────────────────────────────────
router.post('/admin/ai-instructions', requireAdmin, (req, res) => {
  const { text, display_order } = req.body;
  if (!text?.trim()) return res.redirect('/admin#ai');
  db.portfolio(req.portfolioUser).prepare(
    'INSERT INTO ai_instructions (id, text, display_order) VALUES (?,?,?)'
  ).run(uuid(), text.trim(), parseInt(display_order, 10) || 0);
  res.redirect('/admin#ai');
});
router.post('/admin/ai-instructions/:id/delete', requireAdmin, (req, res) => {
  db.portfolio(req.portfolioUser).prepare('DELETE FROM ai_instructions WHERE id = ?').run(req.params.id);
  res.redirect('/admin#ai');
});

// ── CV content (key/value sections shown on public portfolio) ─────────────────
router.post('/admin/cv', requireAdmin, (req, res) => {
  const { section, content } = req.body;
  if (!section) return res.redirect('/admin');
  const pdb = db.portfolio(req.portfolioUser);
  pdb.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_cv_section ON cv_context(section)');
  pdb.prepare(`
    INSERT INTO cv_context (id, section, content) VALUES (?, ?, ?)
    ON CONFLICT(section) DO UPDATE SET content = excluded.content, updated_at = unixepoch()
  `).run(uuid(), section.trim(), content || '');
  res.redirect('/admin');
});

router.post('/admin/cv/summary-draft', requireAdmin, async (req, res) => {
  const pdb = db.portfolio(req.portfolioUser);
  try {
    scanCvContextCandidates({ hub: db.hub(), portfolio: pdb, user: req.portfolioUser });
    const profile = pdb.prepare('SELECT * FROM profile WHERE id = 1').get() || {};
    const cvRows = pdb.prepare('SELECT * FROM cv_context ORDER BY section').all();
    const cv = rowsToCvObject(cvRows);
    const experiences = pdb.prepare('SELECT * FROM experiences WHERE is_cv_context = 1 ORDER BY display_order ASC').all();
    const skills = pdb.prepare("SELECT * FROM skills WHERE level != 'gap' ORDER BY CASE level WHEN 'strong' THEN 0 ELSE 1 END, display_order").all();
    const candidates = pdb.prepare(`
      SELECT * FROM skill_candidates
       WHERE user = ? AND status IN ('promoted_jd', 'chat_only')
       ORDER BY CASE status WHEN 'promoted_jd' THEN 0 ELSE 1 END, occurrences DESC, last_seen_at DESC
    `).all(req.portfolioUser);

    const draft = await draftExecutiveSummary({
      user: req.portfolioUser,
      profile,
      cv,
      experiences,
      skills,
      candidates,
    });
    req.session.summaryDraft = {
      content: draft,
      generated_at: Date.now(),
      topic_count: candidates.length,
      skill_count: skills.length,
    };
  } catch (err) {
    console.error('[summary-draft]', err);
    req.session.summaryDraftError = err.message || 'Could not draft executive summary';
  }
  res.redirect('/admin#cv');
});

router.post('/admin/cv/summary-draft/save', requireAdmin, (req, res) => {
  const content = String(req.body.content || '').trim();
  if (content) {
    const pdb = db.portfolio(req.portfolioUser);
    pdb.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_cv_section ON cv_context(section)');
    pdb.prepare(`
      INSERT INTO cv_context (id, section, content) VALUES (?, 'summary', ?)
      ON CONFLICT(section) DO UPDATE SET content = excluded.content, updated_at = unixepoch()
    `).run(uuid(), content);
  }
  req.session.summaryDraft = null;
  res.redirect('/admin#cv');
});

router.post('/admin/cv/summary-draft/discard', requireAdmin, (req, res) => {
  req.session.summaryDraft = null;
  res.redirect('/admin#cv');
});

router.post('/admin/cv/:section/delete', requireAdmin, (req, res) => {
  db.portfolio(req.portfolioUser).prepare('DELETE FROM cv_context WHERE section = ?').run(req.params.section);
  res.redirect('/admin');
});

// ── Edit experience (inline) ──────────────────────────────────────────────────

// ── Experiences ───────────────────────────────────────────────────────────────
router.post('/admin/experiences', requireAdmin, (req, res) => {
  const { company, role, start_date, end_date, description, is_cv_context, display_order } = req.body;
  const pdb = db.portfolio(req.portfolioUser);
  pdb.prepare(
    'INSERT INTO experiences (id, company, role, start_date, end_date, description, is_cv_context, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(uuid(), company, role, start_date, end_date, description, is_cv_context ? 1 : 0, display_order || 0);
  res.redirect('/admin');
});

router.post('/admin/experiences/:id', requireAdmin, (req, res) => {
  const { company, role, start_date, end_date, description, is_cv_context, display_order } = req.body;
  const pdb = db.portfolio(req.portfolioUser);
  pdb.prepare(
    'UPDATE experiences SET company=?, role=?, start_date=?, end_date=?, description=?, is_cv_context=?, display_order=? WHERE id=?'
  ).run(company, role, start_date, end_date, description, is_cv_context ? 1 : 0, display_order || 0, req.params.id);
  res.redirect('/admin');
});

router.post('/admin/experiences/:id/delete', requireAdmin, (req, res) => {
  db.portfolio(req.portfolioUser).prepare('DELETE FROM experiences WHERE id = ?').run(req.params.id);
  res.redirect('/admin');
});

// ── Skills ────────────────────────────────────────────────────────────────────
router.post('/admin/skills', requireAdmin, (req, res) => {
  const { name, level, category, display_order } = req.body;
  const pdb = db.portfolio(req.portfolioUser);
  pdb.prepare(
    'INSERT INTO skills (id, name, level, category, display_order) VALUES (?, ?, ?, ?, ?)'
  ).run(uuid(), name, level, category, display_order || 0);
  res.redirect('/admin');
});

router.post('/admin/skills/:id/delete', requireAdmin, (req, res) => {
  db.portfolio(req.portfolioUser).prepare('DELETE FROM skills WHERE id = ?').run(req.params.id);
  res.redirect('/admin');
});

// ── Toggle project CV context flag ────────────────────────────────────────────
router.post('/admin/projects/:id/toggle-cv', requireAdmin, (req, res) => {
  const hubDb = db.hub();
  const project = hubDb.prepare('SELECT * FROM projects WHERE id = ? AND user = ?')
                       .get(req.params.id, req.portfolioUser);
  if (!project) return res.status(404).json({ error: 'Not found' });
  hubDb.prepare('UPDATE projects SET is_cv_context = ? WHERE id = ?')
       .run(project.is_cv_context ? 0 : 1, project.id);
  res.redirect('/admin');
});

module.exports = router;
