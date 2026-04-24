const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { uuid } = require('../lib/id');
const { scanCvContextCandidates } = require('../lib/cvCandidates');
const { finishGoogleAuth, startGoogleAuth } = require('../lib/google-auth');
const { createRateLimiter, requireSameOrigin } = require('../lib/security');

function requireAdmin(req, res, next) {
  if (req.session?.adminUser === req.portfolioUser) return next();
  res.redirect('/admin/login');
}

router.get('/admin/login', (req, res) => {
  res.render('admin/login', { user: req.portfolioUser, error: null });
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
    return requireSameOrigin(req, res, next);
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
    experiences, skills, cvRows, profile, gaps, faqs, aiInstructions, jdSubmissions, skillCandidates, projects,
  });
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
