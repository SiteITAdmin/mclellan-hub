'use strict';

const fs   = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { randomUUID } = require('crypto');
const fetch = require('./fetch');
const { google } = require('googleapis');
const db = require('./db');
const { logUsageFromResponse } = require('./openrouter-usage');
const { TASK_CODES, openRouterHeaders } = require('./openrouter-attribution');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');
const { parseModelObject } = require('./model-response');
const linkedinTeam = require('./linkedin-agent-team');
const { writeLinkedInQualityReview } = require('./hub-quality-board');

const OR_URL  = 'https://openrouter.ai/api/v1/chat/completions';
const OR_KEY  = () => process.env.OPENROUTER_API_KEY;

const FOLDER_NAME = 'LinkedIn Posts';
const SHEET_TITLE = 'LinkedIn Content Calendar';
const SHEET_COLS  = ['Date', 'Topic', 'Original Draft', 'Refined Draft', 'Score', 'Verdict', 'Signal/Noise', 'Expertise', 'Top Fix', 'Recruiter View', 'Teaser Refined', 'Carousel Reviewed', 'Status', 'Content URL'];

// ── Rubric ────────────────────────────────────────────────────────────────────
// Exact rubric as defined by Douglas McLellan. Do not modify descriptions.
const RUBRIC = `Score each axis 1–5:
- demonstrated_expertise: does the post show specific knowledge, or just a generic observation?
- professional_positioning: is the author's expertise clearly signalled by the content?
- signal_to_noise: does every sentence earn its place, or is there filler?
- industry_relevance: would the target audience find this genuinely useful?
- credibility_markers: are there concrete examples, numbers, or named outcomes?

Required elements — for each, mark present true/false. If present, also provide quality ("good", "strong", "weak"):
- technical_strategic_depth: does the post go beyond surface observation into mechanism or implication?
- clear_expertise_signal: does the reader know who this person is and why they are credible?

Anti-patterns — identify any of these that are present and describe exactly how they appear:
- Engagement-baiting question at end dilutes professional tone (e.g. "What's been your experience with this?")
- Context-free reflection that adds no insight (e.g. "This really made me think...")
- Doesn't show HOW the problem was approached, just that it was solved
- Too long — loses impact by third paragraph

Critical gaps: list specific things that are absent but would materially improve the post.

Top fixes: provide exactly 2, ranked by priority. Each must include:
- priority (1 or 2)
- problem: name the specific problem concisely
- fix: a concrete, actionable instruction — not vague advice
- impact: what metric or quality improves and by how much

Recruiter perspective: complete this template exactly — "A hiring manager would see: [specific role/level], credible experience in [domain], but unclear on [gap]. Likely to prompt a conversation if hiring for [type of role]."`;


// ── LLM helpers ───────────────────────────────────────────────────────────────
const LLM_TIMEOUT_MS = 90_000;

async function llmFetch(body, taskCode = TASK_CODES.CONTENT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    return await fetch(OR_URL, {
      method: 'POST',
      headers: openRouterHeaders(taskCode, { apiKey: OR_KEY() }),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function llmText(model, messages, temperature = 0.7, taskCode = TASK_CODES.CONTENT, modelKey = 'linkedin-pipeline') {
  const started = Date.now();
  const r = await llmFetch({ model, messages, temperature }, taskCode);
  if (!r.ok) throw new Error(`LLM (${model}) ${r.status}: ${await r.text()}`);
  const data = await r.json();
  logUsageFromResponse({
    user: 'system',
    feature: modelKey,
    modelKey,
    fallbackModelId: model,
    data,
    durationMs: Date.now() - started,
    taskCode,
  });
  const content = messageText(data.choices?.[0]?.message);
  if (!content) {
    const finish = data.choices?.[0]?.finish_reason || 'unknown';
    throw new Error(`LLM (${model}) returned empty content (finish_reason=${finish})`);
  }
  return content;
}

function messageText(message = {}) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.content === 'string') return part.content;
      return '';
    }).join('').trim();
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}

function parseJsonMessage(data, model, modelKey) {
  const choice = data.choices?.[0];
  const raw = messageText(choice?.message);
  if (!raw) {
    const finish = choice?.finish_reason || 'unknown';
    const hasReasoning = Boolean(choice?.message?.reasoning || choice?.message?.reasoning_details);
    throw new Error(`LLM-JSON (${model}) returned empty content for ${modelKey} (finish_reason=${finish}, reasoning=${hasReasoning ? 'present' : 'absent'})`);
  }
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  const content = (s >= 0 && e > s) ? raw.slice(s, e + 1) : raw;
  return parseModelObject(content, {}, modelKey);
}

async function llmJsonOnce(model, messages, taskCode, modelKey) {
  const started = Date.now();
  const r = await llmFetch({ model, messages, temperature: 0.2, response_format: { type: 'json_object' } }, taskCode);
  if (!r.ok) throw new Error(`LLM-JSON (${model}) ${r.status}: ${await r.text()}`);
  const data = await r.json();
  logUsageFromResponse({
    user: 'system',
    feature: modelKey,
    modelKey,
    fallbackModelId: model,
    data,
    durationMs: Date.now() - started,
    taskCode,
  });
  return parseJsonMessage(data, model, modelKey);
}

async function llmJson(model, messages, taskCode = TASK_CODES.CONTENT, modelKey = 'linkedin-pipeline', options = {}) {
  try {
    return await llmJsonOnce(model, messages, taskCode, modelKey);
  } catch (err) {
    const fallbackModel = options.fallbackModelId;
    if (fallbackModel && fallbackModel !== model) {
      console.warn(`[linkedin-pipeline] ${modelKey} failed on ${model}; retrying ${fallbackModel}: ${err.message}`);
      return llmJsonOnce(fallbackModel, messages, taskCode, `${modelKey}:fallback`);
    }
    throw err;
  }
}

// ── Debug logging ─────────────────────────────────────────────────────────────
function pipelineLog(stage, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  console.log(`\n[linkedin-pipeline:${stage}]\n${body}\n[/linkedin-pipeline:${stage}]`);
}

// ── Fetch a single URL via Firecrawl (or plain fetch fallback) ────────────────
async function fetchSourceUrl(url) {
  if (process.env.FIRECRAWL_API_KEY) {
    try {
      const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, formats: ['markdown'] }),
      });
      if (r.ok) {
        const data = await r.json();
        if (data?.data?.markdown) return data.data.markdown.slice(0, 4000);
      }
    } catch (_) {}
  }
  // Plain fetch fallback — strip HTML tags roughly
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResearchBot/1.0)' } });
    if (r.ok) {
      const html = await r.text();
      return html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 4000);
    }
  } catch (_) {}
  return null;
}

// ── Research ──────────────────────────────────────────────────────────────────
async function research(topic, user, onStatus, sourceUrl = null) {
  // If a primary source URL is provided, fetch it first before planning queries
  let primarySource = null;
  if (sourceUrl) {
    onStatus('Fetching primary source article…');
    const content = await fetchSourceUrl(sourceUrl);
    if (content) {
      primarySource = { title: 'PRIMARY SOURCE (user-provided)', url: sourceUrl, fullContent: content, isPrimary: true };
      pipelineLog('primary-source', `Fetched ${content.length} chars from ${sourceUrl}`);
    }
  }

  onStatus('Planning search queries…');

  const plannerContext = primarySource
    ? `The user has provided a primary source article (URL: ${sourceUrl}). Generate queries that EXPAND ON and CORROBORATE the claims in this article — finding additional data points, EU/Ireland context, expert commentary, or related industry developments. Do NOT generate queries designed to fact-check or contradict the primary source. The article's core claims are treated as authoritative.`
    : `Your objective is to produce five distinct and specific search queries designed to research a given LinkedIn post topic from multiple perspectives.`;

  const todayStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const plannerPrompt = getSystemPrompt('linkedin_planner', user, PROMPTS.linkedin_planner)
    .replace('[DATE]', todayStr) + '\n\n' + plannerContext;

  const plannerFallback = 'deepseek/deepseek-v3.2';
  const plan = await llmJson(getSystemModelId('linkedin_planner', user, plannerFallback), [
    { role: 'system', content: plannerPrompt },
    { role: 'user', content: primarySource ? `Topic: ${topic}\n\nPrimary source content (expand on this, do not contradict):\n${primarySource.fullContent.slice(0, 1000)}` : topic },
  ], TASK_CODES.LINKEDIN_PLANNER, 'linkedin-planner', { fallbackModelId: plannerFallback });
  const queries = (plan.queries || [topic]).slice(0, 5);
  pipelineLog('queries', queries);

  onStatus(`Searching ${queries.length} angles…`);

  let sources = [];
  if (process.env.BRAVE_SEARCH_API_KEY) {
    const results = await Promise.all(queries.map(q =>
      fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5&freshness=pm`, {
        headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY },
      }).then(r => r.ok ? r.json() : { web: { results: [] } }).catch(() => ({ web: { results: [] } }))
    ));
    const seen = new Set();
    if (primarySource) seen.add(sourceUrl); // don't re-fetch primary source
    for (const r of results) {
      for (const s of (r.web?.results || [])) {
        if (s.url && !seen.has(s.url)) { seen.add(s.url); sources.push({ title: s.title, url: s.url, snippet: s.description }); }
      }
    }
  }

  // Firecrawl: fetch full content from top URLs for deeper research
  if (process.env.FIRECRAWL_API_KEY && sources.length > 0) {
    onStatus('Fetching full article content…');
    const topUrls = sources.slice(0, 5).map(s => s.url);
    const fetched = await Promise.allSettled(topUrls.map(url =>
      fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, formats: ['markdown'] }),
      }).then(r => r.ok ? r.json() : null).catch(() => null)
    ));
    for (let i = 0; i < fetched.length; i++) {
      const result = fetched[i];
      if (result.status === 'fulfilled' && result.value?.data?.markdown) {
        const md = result.value.data.markdown.slice(0, 2000);
        sources[i] = { ...sources[i], fullContent: md };
      }
    }
  }

  // Prepend primary source as [1] so it anchors the synthesis
  if (primarySource) sources.unshift(primarySource);

  const context = sources.slice(0, 20).map((s, i) => {
    const label = s.isPrimary ? `[${i+1}] *** PRIMARY SOURCE (user-provided — treat as authoritative) ***\n${s.url}` : `[${i+1}] ${s.title}\n${s.url}\n${s.snippet || ''}`;
    return s.fullContent ? `${label}\n\nFull content:\n${s.fullContent}` : label;
  }).join('\n\n---\n\n');

  pipelineLog('sources', sources.slice(0, 20).map(s => `${s.isPrimary ? '[PRIMARY] ' : ''}${s.title || s.url} — ${s.url}`));
  onStatus('Synthesising research…');

  const primaryNote = primarySource
    ? `\n\nIMPORTANT: Source [1] is a PRIMARY SOURCE provided directly by Douglas — treat its claims and statistics as authoritative. If other sources appear to contradict source [1], note the discrepancy explicitly rather than silently overriding it. Do not dilute or second-guess the primary source's core claims.`
    : '';

  const synthesiserPrompt = getSystemPrompt('linkedin_synthesiser', user, PROMPTS.linkedin_synthesiser)
    .replace('[DATE]', todayStr) + (primaryNote || '');

  const synthesis = await llmText(getSystemModelId('linkedin_synthesiser', user, 'anthropic/claude-sonnet-4-6'), [
    { role: 'system', content: synthesiserPrompt },
    { role: 'user', content: `Topic: ${topic}\n\nSources:\n${context}` },
  ], 0.7, TASK_CODES.LINKEDIN_SYNTHESISER, 'linkedin-synthesiser');

  pipelineLog('synthesis', synthesis);
  return { synthesis, sources: sources.slice(0, 20) };
}

// ── Draft ─────────────────────────────────────────────────────────────────────
async function draftPost(topic, synthesis, user, onStatus, spiciness = 'professional') {
  onStatus('Writing draft…');
  const todayStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const spicyKey = spiciness !== 'professional' ? `spiciness_${spiciness}_drafter` : null;
  const spicyMod = spicyKey ? getSystemPrompt(spicyKey, user, PROMPTS[spicyKey] || '') : '';
  const drafterPrompt = getSystemPrompt('linkedin_drafter', user, PROMPTS.linkedin_drafter)
    .replace('[DATE]', todayStr) + spicyMod;

  const draft = await llmText(getSystemModelId('linkedin_drafter', user, 'deepseek/deepseek-v4-flash'), [
    { role: 'system', content: drafterPrompt },
    { role: 'user', content: `Topic: ${topic}\n\nResearch:\n${synthesis}` },
  ], 0.8, TASK_CODES.LINKEDIN_DRAFTER, 'linkedin-drafter');
  pipelineLog('draft-original', draft);
  return draft;
}

// ── Score ─────────────────────────────────────────────────────────────────────
async function scorePost(draftText, user, onStatus) {
  onStatus('Scoring against rubric…');
  const scorerPrompt = getSystemPrompt('linkedin_scorer', user, PROMPTS.linkedin_scorer);
  const scorerFallback = 'anthropic/claude-sonnet-4-6';

  const score = await llmJson(getSystemModelId('linkedin_scorer', user, scorerFallback), [
    { role: 'system', content: scorerPrompt },
    { role: 'user', content: draftText },
  ], TASK_CODES.LINKEDIN_SCORER, 'linkedin-scorer', { fallbackModelId: scorerFallback });
  pipelineLog('score', score);
  return score;
}

// ── Carousel PDF (Puppeteer) ──────────────────────────────────────────────────
const HUB_PUR = '#7c6af5';

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderPoints(points) {
  return (points || []).slice(0, 3).map((pt, i) => {
    const lead = escHtml(typeof pt === 'object' ? pt.lead : '');
    const body = escHtml(typeof pt === 'object' ? pt.body : pt);
    return `<div class="point">
      <div class="point-num">${i + 1}</div>
      <div class="point-text">${lead ? `<strong>${lead}</strong> ` : ''}${body}</div>
    </div>`;
  }).join('');
}

function buildSlideHtml(slides) {
  const s1 = slides.slide1 || {}, s2 = slides.slide2 || {};
  const s3 = slides.slide3 || {}, s4 = slides.slide4 || {};

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Playfair+Display:ital,wght@0,700;0,800;1,700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#faf9fb;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.slide{width:1080px;height:1350px;overflow:hidden;position:relative;page-break-after:always;break-after:page;font-family:'Manrope',-apple-system,sans-serif}
@page{size:1080px 1350px;margin:0}

/* Shared footer */
.footer{position:absolute;bottom:0;left:0;right:0;height:64px;background:#f3f1f6;border-top:1px solid #e9e6ee;display:flex;align-items:center;justify-content:space-between;padding:0 72px}
.footer-name{font-size:15px;font-weight:600;color:#4d4a5a;letter-spacing:.01em}
.footer-page{font-size:14px;color:#8a8693;font-weight:500}

/* COVER */
.cover{background:#ffffff;display:flex;flex-direction:column}
.cover-accent{height:8px;background:${HUB_PUR};flex-shrink:0}
.cover-body{flex:1;padding:56px 80px 84px;display:flex;flex-direction:column}
.cover-tag{background:${HUB_PUR};color:#fff;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;padding:8px 16px;border-radius:4px;display:inline-block;margin-bottom:0;width:fit-content;flex-shrink:0}
.cover-center{flex:1;display:flex;flex-direction:column;justify-content:center}
.cover-headline{font-family:'Playfair Display',Georgia,serif;font-size:82px;font-weight:800;line-height:1.05;color:#15131e}
.cover-rule{width:56px;height:4px;background:${HUB_PUR};border-radius:2px;margin:36px 0 22px}
.cover-sub{font-size:24px;font-weight:600;color:#4d4a5a;line-height:1.5;margin-bottom:14px}
.cover-ctx{font-size:17px;color:#8a8693;line-height:1.85;max-width:860px}

/* BODY */
.body-slide{background:#faf9fb;display:flex;flex-direction:column}
.body-head{padding:56px 80px 36px}
.slide-num{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${HUB_PUR};margin-bottom:14px}
.body-title{font-family:'Playfair Display',Georgia,serif;font-size:52px;font-weight:700;color:#15131e;line-height:1.1}
.body-rule{height:2px;background:${HUB_PUR};margin:0 80px;border-radius:2px;opacity:.18}
.points{flex:1;padding:40px 80px 84px;display:flex;flex-direction:column;gap:28px}
.point{display:flex;gap:22px;align-items:flex-start}
.point-num{width:36px;height:36px;min-width:36px;border-radius:50%;background:${HUB_PUR};color:#fff;font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:3px;flex-shrink:0}
.point-text{font-size:19px;line-height:1.78;color:#4d4a5a;font-weight:400}
.point-text strong{color:#15131e;font-weight:700}

/* TAKEAWAY */
.takeaway{background:#ffffff;display:flex;flex-direction:column}
.takeaway-accent{height:8px;background:${HUB_PUR};flex-shrink:0}
.takeaway-body{flex:1;padding:60px 80px 84px;display:flex;flex-direction:column}
.tk-label{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${HUB_PUR};margin-bottom:52px}
.tk-insight{font-family:'Playfair Display',Georgia,serif;font-size:60px;font-weight:700;line-height:1.1;color:#15131e;flex:1;display:flex;align-items:center}
.tk-rule{height:1px;background:#e9e6ee;margin:40px 0 28px}
.tk-detail{font-size:19px;color:#4d4a5a;line-height:1.85;margin-bottom:22px}
.tk-q{font-size:17px;color:#8a8693;font-style:italic;line-height:1.7}
</style></head><body>

<div class="slide cover">
  <div class="cover-accent"></div>
  <div class="cover-body">
    <div class="cover-tag">Thought Leadership</div>
    <div class="cover-center">
      <div class="cover-headline">${escHtml(s1.headline)}</div>
      <div class="cover-rule"></div>
      <div class="cover-sub">${escHtml(s1.subheadline)}</div>
      ${s1.context ? `<div class="cover-ctx">${escHtml(s1.context)}</div>` : ''}
    </div>
  </div>
  <div class="footer">
    <span class="footer-name">Douglas McLellan &middot; Technology Leader &middot; Ireland</span>
    <span class="footer-page">1 / 4</span>
  </div>
</div>

<div class="slide body-slide">
  <div class="body-head">
    <div class="slide-num">02 / 04</div>
    <div class="body-title">${escHtml(s2.title || 'The Real Problem')}</div>
  </div>
  <div class="body-rule"></div>
  <div class="points">${renderPoints(s2.points)}</div>
  <div class="footer">
    <span class="footer-name">Douglas McLellan &middot; Technology Leader &middot; Ireland</span>
    <span class="footer-page">2 / 4</span>
  </div>
</div>

<div class="slide body-slide">
  <div class="body-head">
    <div class="slide-num">03 / 04</div>
    <div class="body-title">${escHtml(s3.title || 'What Actually Works')}</div>
  </div>
  <div class="body-rule"></div>
  <div class="points">${renderPoints(s3.points)}</div>
  <div class="footer">
    <span class="footer-name">Douglas McLellan &middot; Technology Leader &middot; Ireland</span>
    <span class="footer-page">3 / 4</span>
  </div>
</div>

<div class="slide takeaway">
  <div class="takeaway-accent"></div>
  <div class="takeaway-body">
    <div class="tk-label">Takeaway</div>
    <div class="tk-insight">${escHtml(s4.insight)}</div>
    <div class="tk-rule"></div>
    ${s4.detail ? `<div class="tk-detail">${escHtml(s4.detail)}</div>` : ''}
    ${s4.question ? `<div class="tk-q">${escHtml(s4.question)}</div>` : ''}
  </div>
  <div class="footer">
    <span class="footer-name">Douglas McLellan &middot; Technology Leader &middot; Ireland</span>
    <span class="footer-page">4 / 4</span>
  </div>
</div>

</body></html>`;
}

async function buildPuppeteerPdf(slides) {
  const puppeteer = require('puppeteer');
  const html = buildSlideHtml(slides);
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1350 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    return Buffer.from(await page.pdf({ width: '1080px', height: '1350px', printBackground: true }));
  } finally {
    await browser.close();
  }
}

async function generateCarousel(topic, synthesis, draft, scoring, user, onStatus, spiciness = 'professional') {
  onStatus('Planning carousel slides…');

  // Summarise teaser gaps so carousel can compensate
  const weakAxes = Object.entries(scoring.axis_scores || {})
    .filter(([, v]) => v < 4).map(([k, v]) => `${k} (${v}/5)`).join(', ') || 'none';
  const gapList = [
    ...(scoring.critical_gaps || []),
    ...(scoring.top_fixes || []).map(f => f.problem),
  ].filter(Boolean).join('; ') || 'none';

  const carouselTodayStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const carouselSpicyKey = spiciness !== 'professional' ? `spiciness_${spiciness}_carousel` : null;
  const carouselSpicyMod = carouselSpicyKey ? getSystemPrompt(carouselSpicyKey, user, PROMPTS[carouselSpicyKey] || '') : '';
  const carouselPrompt = getSystemPrompt('linkedin_carousel', user, PROMPTS.linkedin_carousel)
    .replace('[DATE]', carouselTodayStr) + carouselSpicyMod;

  const carouselFallback = 'deepseek/deepseek-v4-flash';
  const slides = await llmJson(getSystemModelId('linkedin_carousel', user, carouselFallback), [
    { role: 'system', content: carouselPrompt },
    { role: 'user', content: `Topic: ${topic}\n\nResearch:\n${synthesis}\n\nTeaser post:\n${draft}\n\nTeaser score gaps to compensate for:\n- Weak axes: ${weakAxes}\n- Gaps identified: ${gapList}\n\nThe carousel must directly address these weaknesses with evidence, specifics, and depth the teaser could not fit.` },
  ], TASK_CODES.LINKEDIN_CAROUSEL, 'linkedin-carousel', { fallbackModelId: carouselFallback });

  pipelineLog('carousel-draft', slides);
  const { slides: reviewed, wasReviewed } = await reviewCarousel(slides, draft, scoring, user, onStatus);
  pipelineLog('carousel-reviewed', { wasReviewed, slides: reviewed });
  onStatus('Rendering carousel PDF…');
  const pdf = await buildPuppeteerPdf(reviewed);
  return { pdf, wasReviewed };
}

// ── Carousel review ───────────────────────────────────────────────────────────
const CAROUSEL_RUBRIC = `Review carousel slide content against these criteria:

Evidence density: each body point must have specific data, named organisations, or concrete outcomes — not generic summaries ("Many organisations struggle with X" fails this)
EU/Ireland relevance: at least one EU regulation, Irish/EU named organisation, adoption trend, or policy context must appear somewhere in slides 2–4
Teaser coherence: carousel must directly expand on what the teaser implied — not repeat it, not ignore it
Point completeness: each point needs a strong lead phrase AND substantive body text (25–50 words of real detail)
Takeaway strength: slide 4 insight must be specific and memorable enough to save and share — a generic platitude ("Leadership matters") fails this

Anti-patterns to fix:
- Body text that summarises without evidence
- No EU/Ireland context anywhere in the deck
- Takeaway that could apply to any topic in any industry
- Points that repeat what the teaser already covered`;

async function reviewCarousel(slides, draft, scoring, user, onStatus) {
  onStatus('Reviewing carousel content…');
  try {
    const reviewerFallback = 'mistralai/mistral-medium-3';
    const reviewed = await llmJson(getSystemModelId('linkedin_carousel_reviewer', user, reviewerFallback), [
      { role: 'system', content: getSystemPrompt('linkedin_carousel_reviewer', user, PROMPTS.linkedin_carousel_reviewer) },
      { role: 'user', content: `Rubric:\n${CAROUSEL_RUBRIC}\n\nTeaser post:\n${draft}\n\nTeaser gaps: ${(scoring.critical_gaps || []).join('; ') || 'none'}\n\nCarousel to review:\n${JSON.stringify(slides, null, 2)}` },
    ], TASK_CODES.LINKEDIN_CAROUSEL_REVIEWER, 'linkedin-carousel-reviewer', { fallbackModelId: reviewerFallback });

    // Guard: fall back to originals if the response doesn't have the expected shape
    if (!reviewed?.slide1 || !reviewed?.slide2 || !reviewed?.slide3 || !reviewed?.slide4) {
      onStatus('Carousel review returned unexpected shape — using original slides');
      return { slides, wasReviewed: false };
    }

    return { slides: reviewed, wasReviewed: true };
  } catch (err) {
    onStatus(`Carousel review skipped: ${err.message}`);
    return { slides, wasReviewed: false };
  }
}

// ── Refine ────────────────────────────────────────────────────────────────────
async function refineDraft(draft, synthesis, scoring, user, onStatus, spiciness = 'professional') {
  onStatus('Refining draft…');
  const antiPatterns = (scoring.anti_patterns_present || []).join('; ') || 'none';

  const topFixes = (scoring.top_fixes || [])
    .sort((a, b) => (a.priority || 0) - (b.priority || 0))
    .map(f => `P${f.priority}: ${f.problem} → ${f.fix} (impact: ${f.impact})`)
    .join('\n') || 'none';
  const refineTodayStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const refineSpicyKey = spiciness !== 'professional' ? `spiciness_${spiciness}_refiner` : null;
  const refineSpicyMod = refineSpicyKey ? getSystemPrompt(refineSpicyKey, user, PROMPTS[refineSpicyKey] || '') : '';
  const refinePrompt = getSystemPrompt('linkedin_refiner', user, PROMPTS.linkedin_refiner)
    .replace('[DATE]', refineTodayStr) + refineSpicyMod;

  const refined = await llmText(getSystemModelId('linkedin_refiner', user, 'mistralai/mistral-medium-3'), [
    { role: 'system', content: refinePrompt },
    { role: 'user', content: `Research synthesis:\n${synthesis}\n\nDraft:\n${draft}\n\nScore: ${scoring.overall_score}/5 (${scoring.recruiter_value})\nPrioritised fixes:\n${topFixes}\nAnti-patterns: ${antiPatterns}\nCritical gaps: ${(scoring.critical_gaps || []).join('; ') || 'none'}\n\nMake targeted improvements to address these specific issues. Keep what is already working.` },
  ], 0.7, TASK_CODES.LINKEDIN_REFINER, 'linkedin-refiner');
  pipelineLog('draft-refined', refined);
  return refined;
}

// ── Image ─────────────────────────────────────────────────────────────────────
async function generateImage(topic, user, onStatus) {
  const key = process.env.GOOGLE_AI_API_KEY;
  if (!key) { onStatus('Image gen skipped — GOOGLE_AI_API_KEY not set'); return null; }

  onStatus('Generating image…');
  const imageInstructions = getSystemPrompt('linkedin_image', user, PROMPTS.linkedin_image);
  const imagePrompt = await llmText(getSystemModelId('linkedin_image', user, 'deepseek/deepseek-chat'), [
    { role: 'user', content: `${imageInstructions}\n\nTopic: "${topic}"` },
  ], 0.7, TASK_CODES.LINKEDIN_IMAGE_PROMPT, 'linkedin-image-prompt');

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: imagePrompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
    }
  );
  if (!r.ok) throw new Error(`Image API ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const part = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!part) throw new Error('No image in response');
  return { base64: part.inlineData.data, mimeType: part.inlineData.mimeType || 'image/png' };
}

// ── Save image locally (for dchat display) ────────────────────────────────────
function saveImageLocally(base64, mimeType) {
  const ext = mimeType.includes('jpeg') ? 'jpg' : 'png';
  const filename = `linkedin-${randomUUID()}.${ext}`;
  const dir = path.join(__dirname, '..', 'public', 'generated');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), Buffer.from(base64, 'base64'));
  return `/generated/${filename}`;
}

// ── Google auth (user OAuth token) ────────────────────────────────────────────
function getGoogleClients(user) {
  const row = db.hub().prepare(
    "SELECT value FROM crm_context WHERE user = ? AND key = '_google_refresh_token'"
  ).get(user);
  if (!row) throw new Error('No Google token — sign in at /auth/google first');

  const oauth = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );
  oauth.setCredentials({ refresh_token: row.value });

  // Catch scope errors with a helpful message
  oauth.on('tokens', () => {});

  return {
    drive:  google.drive({ version: 'v3', auth: oauth }),
    sheets: google.sheets({ version: 'v4', auth: oauth }),
  };
}

// ── Drive folder ──────────────────────────────────────────────────────────────
async function getLinkedInFolder(drive) {
  const cached = db.hub().prepare(
    "SELECT value FROM crm_context WHERE user = 'system' AND key = 'linkedin_drive_folder_id'"
  ).get();
  if (cached) return cached.value;

  const list = await drive.files.list({
    q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
  });

  let folderId = list.data.files?.[0]?.id;
  if (!folderId) {
    const folder = await drive.files.create({
      requestBody: { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id',
    });
    folderId = folder.data.id;
  }

  db.hub().prepare(
    "INSERT OR REPLACE INTO crm_context (id, user, key, value) VALUES (?, 'system', 'linkedin_drive_folder_id', ?)"
  ).run(randomUUID(), folderId);
  return folderId;
}

async function uploadToDrive(drive, base64, mimeType, filename, onStatus) {
  onStatus('Uploading image to Drive…');
  const folderId = await getLinkedInFolder(drive);

  const body = new Readable();
  body.push(Buffer.from(base64, 'base64'));
  body.push(null);

  const file = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType, body },
    fields: 'id,webViewLink',
  });

  // Anyone with the link can view
  await drive.permissions.create({
    fileId: file.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return {
    driveUrl: file.data.webViewLink,
    directUrl: `https://drive.google.com/uc?export=view&id=${file.data.id}`,
  };
}

// ── Sheets ────────────────────────────────────────────────────────────────────
async function getOrCreateSheet(sheets, drive, onStatus) {
  const hub = db.hub();
  const cached = hub.prepare(
    "SELECT value FROM crm_context WHERE user = 'system' AND key = 'linkedin_sheet_id'"
  ).get();

  if (cached) {
    try {
      await sheets.spreadsheets.get({ spreadsheetId: cached.value, fields: 'spreadsheetId' });
      return cached.value;
    } catch {
      console.log('[linkedin] cached sheet missing or deleted — creating new one');
      hub.prepare("DELETE FROM crm_context WHERE user = 'system' AND key = 'linkedin_sheet_id'").run();
    }
  }

  onStatus('Creating content calendar sheet…');
  const folderId = await getLinkedInFolder(drive);

  const sheet = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: SHEET_TITLE },
      sheets: [{
        properties: { title: 'Calendar' },
        data: [{
          startRow: 0, startColumn: 0,
          rowData: [{
            values: SHEET_COLS.map(v => ({
              userEnteredValue: { stringValue: v },
              userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.2, green: 0.2, blue: 0.6 } },
            })),
          }],
        }],
      }],
    },
  });

  const sheetId = sheet.data.spreadsheetId;

  // Move sheet into the LinkedIn Posts folder
  await drive.files.update({
    fileId: sheetId,
    addParents: folderId,
    removeParents: 'root',
    fields: 'id,parents',
  });

  console.log(`[linkedin] Sheet created in LinkedIn Posts folder: https://docs.google.com/spreadsheets/d/${sheetId}`);
  db.hub().prepare(
    "INSERT OR REPLACE INTO crm_context (id, user, key, value) VALUES (?, 'system', 'linkedin_sheet_id', ?)"
  ).run(randomUUID(), sheetId);
  return sheetId;
}

async function appendRow(sheets, sheetId, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Calendar!A:N',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

function loadPost(hub, postId) {
  return hub.prepare('SELECT * FROM linkedin_posts WHERE id = ?').get(postId);
}

function runQualityGate({ hub, user, postId, persist, onStatus }) {
  const post = loadPost(hub, postId);
  linkedinTeam.writeManagingEditorReceipt({ user, postId, post });
  const quality = writeLinkedInQualityReview({ user, postId, post }).receipt;
  if (quality.quality_veto) {
    persist({ status: 'needs_revision' });
    const blockers = (quality.blocking_checks || []).join(', ') || 'quality board veto';
    onStatus(`Quality board veto — artifacts skipped until resolved (${blockers})`);
  }
  return { post, quality };
}

function clearArtifactFields(persist) {
  persist({ carousel_url: '', sheet_url: '', image_url: '' });
}

// ── Main pipeline ─────────────────────────────────────────────────────────────
async function runPipeline(user, topic, onStatus = () => {}, existingPostId = null, sourceUrl = null, spiciness = 'professional') {
  if (!OR_KEY()) throw new Error('OPENROUTER_API_KEY not set');
  const validSpiciness = ['professional', 'challenging', 'provocative'];
  if (!validSpiciness.includes(spiciness)) spiciness = 'professional';

  const postId = existingPostId || randomUUID();
  const hub = db.hub();
  if (!existingPostId) {
    hub.prepare(`INSERT INTO linkedin_posts (id, user, topic, status, spiciness) VALUES (?, ?, ?, 'processing', ?)`)
      .run(postId, user, topic, spiciness);
  } else {
    hub.prepare(`UPDATE linkedin_posts SET spiciness = ? WHERE id = ?`).run(spiciness, postId);
  }

  const persist = (fields) => {
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    try { hub.prepare(`UPDATE linkedin_posts SET ${sets} WHERE id = ?`).run(...Object.values(fields), postId); } catch (_) {}
  };

  try {
    const { synthesis, sources } = await research(topic, user, onStatus, sourceUrl);
    persist({ research: synthesis });
    linkedinTeam.writeResearchReceipt({ user, postId, topic, synthesis, sources, sourceUrl });

    const draft = await draftPost(topic, synthesis, user, onStatus, spiciness);
    persist({ draft });

    const scoring = await scorePost(draft, user, onStatus);
    persist({ score_json: JSON.stringify(scoring) });

    // Refine based on score feedback — graceful skip
    let refinedDraft = null;
    let teaserRefined = false;
    try {
      refinedDraft = await refineDraft(draft, synthesis, scoring, user, onStatus, spiciness);
      teaserRefined = true;
      persist({ refined_draft: refinedDraft });
    } catch (err) {
      onStatus(`Refinement skipped: ${err.message}`);
    }
    linkedinTeam.writeDraftCriticReceipt({ user, postId, draft, refinedDraft, scoring });

    let quality = null;
    try {
      ({ quality } = runQualityGate({ hub, user, postId, persist, onStatus }));
      if (quality.quality_veto) {
        return {
          postId,
          topic,
          draft,
          refinedDraft,
          score: scoring,
          sources,
          localImagePath: null,
          carouselUrl: null,
          driveUrl: null,
          sheetUrl: null,
          quality,
          artifactsSkipped: true,
        };
      }
    } catch (err) {
      console.warn('[linkedin] pre-artifact quality board failed:', err.message);
      persist({ status: 'needs_revision' });
      return {
        postId,
        topic,
        draft,
        refinedDraft,
        score: scoring,
        sources,
        localImagePath: null,
        carouselUrl: null,
        driveUrl: null,
        sheetUrl: null,
        quality: { verdict: 'fail', quality_veto: true, error: err.message },
        artifactsSkipped: true,
      };
    }

    // Carousel PDF
    let carouselUrl = null;
    let carouselReviewed = false;
    try {
      const { pdf: pdfBuffer, wasReviewed } = await generateCarousel(topic, synthesis, refinedDraft || draft, scoring, user, onStatus, spiciness);
      carouselReviewed = wasReviewed;
      const { drive } = getGoogleClients(user);
      const dateStr = new Date().toISOString().slice(0, 10);
      const slug = topic.slice(0, 40).replace(/[^a-z0-9]/gi, '-').toLowerCase();
      const { driveUrl: url } = await uploadToDrive(
        drive, pdfBuffer.toString('base64'), 'application/pdf', `${dateStr}-${slug}-carousel.pdf`, onStatus
      );
      carouselUrl = url;
      persist({ carousel_url: carouselUrl });
      linkedinTeam.writeArtifactReceipt({ user, postId, pdfBuffer, carouselUrl, carouselReviewed });
    } catch (err) {
      onStatus(`Carousel skipped: ${err.message}`);
      linkedinTeam.writeArtifactReceipt({ user, postId, error: err });
    }

    // Image — graceful skip if key missing or API fails
    let imageData = null;
    try { imageData = await generateImage(topic, user, onStatus); } catch (err) {
      onStatus(`Image skipped: ${err.message}`);
    }

    // Save image locally for dchat rendering
    const localImagePath = imageData ? saveImageLocally(imageData.base64, imageData.mimeType) : null;
    if (localImagePath) persist({ image_url: localImagePath });

    // Drive upload — graceful skip if scopes not yet granted
    let driveUrl = null;
    if (imageData) {
      try {
        const { drive } = getGoogleClients(user);
        const dateStr = new Date().toISOString().slice(0, 10);
        const slug = topic.slice(0, 40).replace(/[^a-z0-9]/gi, '-').toLowerCase();
        const { driveUrl: url } = await uploadToDrive(
          drive, imageData.base64, imageData.mimeType, `${dateStr}-${slug}.png`, onStatus
        );
        driveUrl = url;
      } catch (err) {
        onStatus(`Drive upload skipped: ${err.message}`);
      }
    }

    // Sheets — graceful skip if scopes not yet granted
    let sheetUrl = null;
    try {
      const { sheets, drive } = getGoogleClients(user);
      const sheetId = await getOrCreateSheet(sheets, drive, onStatus);
      onStatus('Saving to content calendar…');
      const ax = scoring.axis_scores || {};
      const topFix1 = scoring.top_fixes?.[0];
      await appendRow(sheets, sheetId, [
        new Date().toLocaleDateString('en-GB'),
        topic,
        draft,
        refinedDraft || draft,
        scoring.overall_score || '',
        scoring.recruiter_value || '',
        ax.signal_to_noise || '',
        ax.demonstrated_expertise || '',
        topFix1 ? `${topFix1.problem} → ${topFix1.fix}` : '',
        scoring.recruiter_perspective || '',
        teaserRefined ? 'Yes' : 'No',
        carouselReviewed ? 'Yes' : 'No',
        'Draft',
        carouselUrl || driveUrl || '',
      ]);
      sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}`;
      persist({ sheet_url: sheetUrl });
    } catch (err) {
      onStatus(`Sheet skipped: ${err.message}`);
    }

    persist({ status: 'draft' });
    const post = loadPost(hub, postId);
    linkedinTeam.writeManagingEditorReceipt({ user, postId, post });
    try {
      quality = writeLinkedInQualityReview({ user, postId, post }).receipt;
      if (quality.quality_veto) {
        clearArtifactFields(persist);
        persist({ status: 'needs_revision' });
        carouselUrl = null;
        driveUrl = null;
        sheetUrl = null;
      }
    } catch (err) {
      console.warn('[linkedin] quality board failed:', err.message);
    }
    return { postId, topic, draft, refinedDraft, score: scoring, sources, localImagePath, carouselUrl, driveUrl, sheetUrl, quality };

  } catch (err) {
    persist({ status: 'error' });
    linkedinTeam.writeManagingEditorReceipt({ user, postId, post: { status: 'error' }, error: err });
    throw err;
  }
}

// ── Resume a stuck post (carousel + sheet only) ───────────────────────────────
async function resumePost(postId, user, onStatus = () => {}) {
  const hub = db.hub();
  const post = loadPost(hub, postId);
  if (!post) throw new Error(`Post ${postId} not found`);

  const persist = (fields) => {
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    hub.prepare(`UPDATE linkedin_posts SET ${sets} WHERE id = ?`).run(...Object.values(fields), postId);
  };

  const preQuality = writeLinkedInQualityReview({ user, postId, post }).receipt;
  const retryableArtifactBlockers = new Set(['artifact_is_usable_when_present', 'pipeline_completed_cleanly']);
  const nonArtifactBlockers = (preQuality.blocking_checks || [])
    .filter(name => !retryableArtifactBlockers.has(name));
  if (preQuality.quality_veto && nonArtifactBlockers.length) {
    persist({ status: 'needs_revision' });
    const blockers = nonArtifactBlockers.join(', ') || 'quality board veto';
    onStatus(`Quality board veto — PDF retry skipped until resolved (${blockers})`);
    return { postId, carouselUrl: null, quality: preQuality, artifactsSkipped: true };
  }

  const scoring = JSON.parse(post.score_json || '{}');
  const draft   = post.refined_draft || post.draft;

  let carouselUrl = null;
  let carouselReviewed = false;
  try {
    const { pdf: pdfBuffer, wasReviewed } = await generateCarousel(post.topic, post.research, draft, scoring, user, onStatus, post.spiciness || 'professional');
    carouselReviewed = wasReviewed;
    const { drive } = getGoogleClients(user);
    const dateStr = new Date().toISOString().slice(0, 10);
    const slug = post.topic.slice(0, 40).replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const { driveUrl: url } = await uploadToDrive(
      drive, pdfBuffer.toString('base64'), 'application/pdf', `${dateStr}-${slug}-carousel.pdf`, onStatus
    );
    carouselUrl = url;
    persist({ carousel_url: carouselUrl });
    linkedinTeam.writeArtifactReceipt({ user, postId, pdfBuffer, carouselUrl, carouselReviewed });
  } catch (err) {
    onStatus(`Carousel skipped: ${err.message}`);
    console.error('[linkedin] resumePost carousel error:', err.message);
    linkedinTeam.writeArtifactReceipt({ user, postId, error: err });
  }

  try {
    const { sheets, drive } = getGoogleClients(user);
    const sheetId = await getOrCreateSheet(sheets, drive, onStatus);
    onStatus('Saving to content calendar…');
    const ax  = scoring.axis_scores || {};
    const tf1 = scoring.top_fixes?.[0];
    await appendRow(sheets, sheetId, [
      new Date().toLocaleDateString('en-GB'),
      post.topic,
      post.draft,
      post.refined_draft || post.draft,
      scoring.overall_score || '',
      scoring.recruiter_value || '',
      ax.signal_to_noise || '',
      ax.demonstrated_expertise || '',
      tf1 ? `${tf1.problem} → ${tf1.fix}` : '',
      scoring.recruiter_perspective || '',
      post.refined_draft ? 'Yes' : 'No',
      carouselReviewed ? 'Yes' : 'No',
      'Draft',
      carouselUrl || '',
    ]);
    persist({ sheet_url: `https://docs.google.com/spreadsheets/d/${sheetId}` });
  } catch (err) {
    onStatus(`Sheet skipped: ${err.message}`);
    console.error('[linkedin] resumePost sheet error:', err.message);
  }

  persist({ status: 'draft' });
  const updated = hub.prepare('SELECT * FROM linkedin_posts WHERE id = ?').get(postId);
  linkedinTeam.writeManagingEditorReceipt({ user, postId, post: updated });
  try {
    const quality = writeLinkedInQualityReview({ user, postId, post: updated }).receipt;
    if (quality.quality_veto) {
      clearArtifactFields(persist);
      persist({ status: 'needs_revision' });
      carouselUrl = null;
    }
  } catch (err) {
    console.warn('[linkedin] resumePost quality board failed:', err.message);
  }
  onStatus('Done.');
  return { postId, carouselUrl };
}

// Derives a clean public display title for a post whose topic may be raw
// pasted text, a URL, or drafting instructions. Stores it in display_title;
// the original topic is never modified.
async function generateDisplayTitle(user, postId) {
  const post = db.hub().prepare('SELECT * FROM linkedin_posts WHERE id = ? AND user = ?').get(postId, user);
  if (!post) return null;
  const postText = (post.refined_draft || post.draft || '').trim();
  const titlePrompt = getSystemPrompt('linkedin_title', user, PROMPTS.linkedin_title);
  const titleFallback = 'anthropic/claude-haiku-4-5';
  const result = await llmJson(getSystemModelId('linkedin_title', user, titleFallback), [
    { role: 'system', content: titlePrompt },
    { role: 'user', content: `Original topic:\n${String(post.topic || '').slice(0, 2000)}\n\nPublished post text:\n${postText.slice(0, 6000)}` },
  ], TASK_CODES.CONTENT, 'linkedin-title', { fallbackModelId: titleFallback });
  const title = String(result.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!title) throw new Error('linkedin_title returned no title');
  db.hub().prepare('UPDATE linkedin_posts SET display_title = ? WHERE id = ?').run(title, postId);
  return title;
}

module.exports = {
  runPipeline,
  resumePost,
  generateDisplayTitle,
  _test: { messageText, parseJsonMessage },
};
