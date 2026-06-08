'use strict';

const fs   = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { randomUUID } = require('crypto');
const fetch = require('node-fetch');
const { google } = require('googleapis');
const db = require('./db');
const { logUsageFromResponse } = require('./openrouter-usage');
const { getSystemModelId } = require('./settings');

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

async function llmFetch(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    return await fetch(OR_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OR_KEY()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function llmText(model, messages, temperature = 0.7) {
  const started = Date.now();
  const r = await llmFetch({ model, messages, temperature });
  if (!r.ok) throw new Error(`LLM (${model}) ${r.status}: ${await r.text()}`);
  const data = await r.json();
  logUsageFromResponse({
    user: 'system',
    feature: 'linkedin-pipeline',
    modelKey: 'linkedin-pipeline',
    fallbackModelId: model,
    data,
    durationMs: Date.now() - started,
  });
  return data.choices[0].message.content.trim();
}

async function llmJson(model, messages) {
  const started = Date.now();
  const r = await llmFetch({ model, messages, temperature: 0.2, response_format: { type: 'json_object' } });
  if (!r.ok) throw new Error(`LLM-JSON (${model}) ${r.status}: ${await r.text()}`);
  const data = await r.json();
  logUsageFromResponse({
    user: 'system',
    feature: 'linkedin-pipeline',
    modelKey: 'linkedin-pipeline',
    fallbackModelId: model,
    data,
    durationMs: Date.now() - started,
  });
  const raw = data.choices[0].message.content;
  // Strip markdown code fences if model wraps JSON in ```json ... ```
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(cleaned);
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

  const plan = await llmJson(getSystemModelId('linkedin_planner', user, 'deepseek/deepseek-v3.2'), [
    { role: 'system', content: `You are an AI assistant tasked with generating targeted web search queries. Today's date is ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}. ${plannerContext}

The primary output format for this task must be a JSON object. This JSON object should contain a single key, "queries," whose value is an array of strings. Each string in the array will represent one of the generated web search queries. The structure should strictly adhere to the format: {"queries": ["query_1", "query_2", "query_3", "query_4", "query_5"]}.

RECENCY REQUIREMENT: All queries must be oriented toward finding content published in 2026, and where possible the last 30 days. Explicitly include "2026" in at least two of your five queries. Frame queries to surface recent reports, announcements, research, statistics, or commentary — not background or evergreen explainers.

When generating the queries, ensure they are specific enough to yield relevant results and varied enough to cover different angles of the provided LinkedIn post topic. Consider searches that might uncover:
- Recent statistics or reports published in 2026.
- Current trends, policy changes, or industry announcements from 2026.
- Expert commentary or case studies published in 2026.
- Emerging challenges or controversies that are active right now.
- Recent EU/Ireland-specific regulatory or adoption developments.

You will be provided with the specific "LinkedIn post topic" as input. All generated queries must directly relate to this topic and be framed for effective web searching. Ensure the tone of the queries is neutral and objective, suitable for research purposes. Avoid using placeholder text or overly generic phrases; each query must be actionable and designed to retrieve substantive information. Do not invent proper nouns unless they are explicitly provided as part of the topic to be researched.` },
    { role: 'user', content: primarySource ? `Topic: ${topic}\n\nPrimary source content (expand on this, do not contradict):\n${primarySource.fullContent.slice(0, 1000)}` : topic },
  ]);
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

  const synthesis = await llmText(getSystemModelId('linkedin_synthesiser', user, 'anthropic/claude-sonnet-4-6'), [
    { role: 'system', content: `You are a research analyst briefing a senior technology leader (Douglas McLellan — M365, AI strategy, healthcare IT, Ireland/EU) who is writing LinkedIn content. Today's date is ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.${primaryNote}

Do not summarise the sources. Analyse them and extract:
1. The most non-obvious or counterintuitive finding — what would surprise a practitioner?
2. Specific statistics, percentages, named organisations, or concrete outcomes — quote them exactly and note when they were published
3. Real-world examples of success or failure from 2026 — name organisations where possible
4. The gap between what the evidence shows and what most organisations actually do
5. The EU/Ireland-specific angle — regulations, adoption patterns, funding, or policy context where relevant
6. The clear "so what" for a senior leader making decisions today

RECENCY: Prioritise findings from 2026. If a source is from 2025 or earlier, flag it with its year so Douglas can judge whether it is still current. Discard anything pre-2025 unless it is the only available evidence on a key point — and if so, say so explicitly.

Write 400–600 words. Be direct and analytical. Use source numbers [1], [2] etc. No filler. No hedging.` },
    { role: 'user', content: `Topic: ${topic}\n\nSources:\n${context}` },
  ]);

  pipelineLog('synthesis', synthesis);
  return { synthesis, sources: sources.slice(0, 20) };
}

// ── Draft ─────────────────────────────────────────────────────────────────────
async function draftPost(topic, synthesis, user, onStatus) {
  onStatus('Writing draft…');
  const draft = await llmText(getSystemModelId('linkedin_drafter', user, 'deepseek/deepseek-v4-flash'), [
    { role: 'system', content: `You are Douglas McLellan's LinkedIn ghostwriter. Douglas is a senior technology and digital transformation leader based in Ireland — M365, AI strategy, healthcare IT, operational leadership. Today's date is ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.

RECENCY: Use only statistics, examples, and findings from the research provided. Do not supplement with your own training data — your knowledge may be out of date. If the research cites a 2024 or older source, do not present it as current. If you have no 2025–2026 evidence for a specific claim, omit the claim rather than invent or recycle stale data.

Write a SHORT TEASER post — exactly 2 paragraphs, 75–100 words total. This post exists to intrigue, not to inform completely. The carousel PDF has the full detail.

Paragraph 1: A specific, concrete observation drawn from the research — name the tension, the problem, or the surprising finding. Sharp enough that a practitioner recognises it immediately.

Paragraph 2: Hint at the insight WITHOUT fully revealing it. End naturally at the edge of the finding — the reader should feel slightly unsatisfied, in a good way.

CRITICAL — this post is NOT about Douglas's career:
- Do NOT reference his years of experience, past roles, clients, or personal career history
- Do NOT write "In my X years...", "After advising...", "Throughout my career...", "In my work with...", "I have seen...", "My clients...", or any variation
- This is Douglas commenting on what the research shows — not sharing his personal story
- Douglas will add his own real examples manually before publishing. Your job is the research-based observation only.

Hard rules:
- All specifics must come from the research provided. Do NOT invent statistics, timeframes, or outcomes not present in the research.
- No em dashes (—). Restructure the sentence or use a full stop instead.
- No engagement-bait endings ("What do you think?", "Drop a comment")
- No generic opening ("In today's fast-moving…")
- No explicit CTA, no "see below", no "link in comments"
- Sound like an informed practitioner commenting on what the evidence shows, not a content creator
- Every line must earn its place` },
    { role: 'user', content: `Topic: ${topic}\n\nResearch:\n${synthesis}` },
  ], 0.8);
  pipelineLog('draft-original', draft);
  return draft;
}

// ── Score ─────────────────────────────────────────────────────────────────────
async function scorePost(draftText, user, onStatus) {
  onStatus('Scoring against rubric…');
  const score = await llmJson(getSystemModelId('linkedin_scorer', user, 'anthropic/claude-sonnet-4-6'), [
    { role: 'system', content: `Score this LinkedIn post against the rubric. Return JSON only — no commentary, no markdown fences:
{
  "overall_score": 3.8,
  "recruiter_value": "STRONG",
  "axis_scores": {
    "demonstrated_expertise": 4,
    "professional_positioning": 4,
    "signal_to_noise": 3,
    "industry_relevance": 4,
    "credibility_markers": 4
  },
  "required_elements": {
    "technical_strategic_depth": { "present": false },
    "clear_expertise_signal": { "present": true, "quality": "strong" }
  },
  "anti_patterns_present": [],
  "recruiter_perspective": "A hiring manager would see: [seniority/role], credible experience in [domain], but unclear on [gap]. Likely to prompt a conversation if hiring for [type of role].",
  "critical_gaps": [],
  "top_fixes": [
    { "priority": 1, "problem": "describe the problem", "fix": "specific actionable fix", "impact": "what improves" },
    { "priority": 2, "problem": "describe the problem", "fix": "specific actionable fix", "impact": "what improves" }
  ]
}

recruiter_value must be exactly one of: STRONG, MODERATE, WEAK

${RUBRIC}` },
    { role: 'user', content: draftText },
  ]);
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
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1350 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    return await page.pdf({ width: '1080px', height: '1350px', printBackground: true });
  } finally {
    await browser.close();
  }
}

async function generateCarousel(topic, synthesis, draft, scoring, user, onStatus) {
  onStatus('Planning carousel slides…');

  // Summarise teaser gaps so carousel can compensate
  const weakAxes = Object.entries(scoring.axis_scores || {})
    .filter(([, v]) => v < 4).map(([k, v]) => `${k} (${v}/5)`).join(', ') || 'none';
  const gapList = [
    ...(scoring.critical_gaps || []),
    ...(scoring.top_fixes || []).map(f => f.problem),
  ].filter(Boolean).join('; ') || 'none';

  const slides = await llmJson(getSystemModelId('linkedin_carousel', user, 'deepseek/deepseek-v4-flash'), [
    { role: 'system', content: `Generate rich content for a 4-slide LinkedIn carousel PDF for Douglas McLellan, senior technology and digital transformation leader, Ireland. This is the detailed companion to a short teaser post — give it real substance, analysis, and depth. Target 500+ words total. Today's date is ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.

RECENCY: Every statistic, example, and named outcome must come from the research provided. Do not use your training data to fill gaps — your knowledge may be dated to 2024 or earlier. If the research does not support a specific claim, write around it or omit it. Never present a 2024 or older figure as if it is current evidence.

The teaser post has already been written and scored. Where the teaser was weak, the carousel must compensate with more depth, evidence, or specificity.

CRITICAL — this content is NOT about Douglas's career. These rules are absolute:
- Do NOT write in first-person Douglas voice under any circumstances
- Do NOT reference his years of experience, client types, past roles, or career history
- Do NOT name any organisation as if Douglas worked there — including HSE, NHS, any health body, any named company
- Do NOT invent metrics, timeframes, or outcomes attributed to Douglas personally
- Prohibited phrases: "In my work with...", "In my deployment...", "When I led...", "My experience shows...", "After X years...", "I have seen...", "My clients..."
- Every specific fact, statistic, percentage, or named example must come directly from the research provided
- Write about what "organisations", "leaders", or "practitioners" do — this is research commentary, not career storytelling

Return JSON exactly:
{
  "slide1": {
    "headline": "Bold specific claim, max 10 words",
    "subheadline": "Sharp supporting context, 20–25 words",
    "context": "2–3 sentences (60–80 words) explaining what this topic is, why it matters right now, and what the reader will learn. Written for a senior practitioner."
  },
  "slide2": {
    "title": "Specific problem-framing title",
    "points": [
      { "lead": "Bold lead phrase, 4–6 words", "body": "50–70 words with a specific fact, named scenario, or real example from the research. No vague generalities. No first-person Douglas anecdotes." },
      { "lead": "Bold lead phrase, 4–6 words", "body": "50–70 words exposing a common mistake, hidden cost, or gap between what organisations do vs what works. Cite research evidence." },
      { "lead": "Bold lead phrase, 4–6 words", "body": "50–70 words on what separates organisations that get this wrong from those that get it right. Name real examples from the research where possible." }
    ]
  },
  "slide3": {
    "title": "Specific solution-framing title",
    "points": [
      { "lead": "Bold lead phrase, 4–6 words", "body": "50–70 words with an actionable insight, concrete mechanism, or specific outcome from the research. Not a platitude." },
      { "lead": "Bold lead phrase, 4–6 words", "body": "50–70 words with the why or how — data point, named example, or real-world evidence from the research." },
      { "lead": "Bold lead phrase, 4–6 words", "body": "50–70 words on what senior leaders who get this right do differently, grounded in research evidence." }
    ]
  },
  "slide4": {
    "insight": "One memorable sentence (20–25 words) practitioners will save and share",
    "detail": "2–3 sentences (60–80 words) expanding the insight — what it means in practice, what it replaces, why it's hard. Grounded in research, not personal anecdote.",
    "question": "Specific thought-provoking question (20–25 words) — not generic engagement bait"
  }
}

Voice: direct, third-party practitioner view, no corporate fluff. Include EU/Ireland context where the research supports it. No em dashes (—) anywhere in the output.` },
    { role: 'user', content: `Topic: ${topic}\n\nResearch:\n${synthesis}\n\nTeaser post:\n${draft}\n\nTeaser score gaps to compensate for:\n- Weak axes: ${weakAxes}\n- Gaps identified: ${gapList}\n\nThe carousel must directly address these weaknesses with evidence, specifics, and depth the teaser could not fit.` },
  ]);

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
    const reviewed = await llmJson(getSystemModelId('linkedin_refiner', user, 'mistralai/mistral-medium-3'), [
      { role: 'system', content: `You are a senior editor reviewing LinkedIn carousel slide content for Douglas McLellan, a technology leader in Ireland (M365, AI strategy, healthcare IT). Apply the rubric and return an improved version of the slides JSON. Make targeted, specific improvements — fix weak evidence, add EU/Ireland specifics where missing, strengthen the takeaway. Preserve the JSON structure exactly. Today's date is ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.

RECENCY: Do not introduce statistics or examples from your training data. Work only from what is already in the carousel and the teaser provided. If a body point cites 2024 or older data as if current, flag it in your review by replacing it with a note that a 2025–2026 source is needed — do not silently retain stale figures.

CRITICAL — this content is NOT about Douglas's career. Enforce these rules actively:
- Remove any first-person Douglas voice immediately: "In my work with...", "In my deployment...", "When I led...", "My experience shows...", "After X years...", "I have seen...", "My clients..." — rewrite using third-party evidence instead
- Remove any reference to his years of experience, client types (e.g. "healthcare clients"), past roles, or career history
- Remove any reference to HSE, NHS, or any named organisation as if Douglas worked there
- Remove invented metrics, timeframes, or outcomes attributed to Douglas
- If a point lacks evidence, rewrite it as a practitioner observation grounded in the research — never substitute personal narrative

${CAROUSEL_RUBRIC}

Return the improved slides as JSON only — no commentary, no markdown fences:
{
  "slide1": { "headline": "...", "subheadline": "...", "context": "..." },
  "slide2": { "title": "...", "points": [{ "lead": "...", "body": "..." }, { "lead": "...", "body": "..." }, { "lead": "...", "body": "..." }] },
  "slide3": { "title": "...", "points": [{ "lead": "...", "body": "..." }, { "lead": "...", "body": "..." }, { "lead": "...", "body": "..." }] },
  "slide4": { "insight": "...", "detail": "...", "question": "..." }
}` },
      { role: 'user', content: `Teaser post:\n${draft}\n\nTeaser gaps: ${(scoring.critical_gaps || []).join('; ') || 'none'}\n\nCarousel to review:\n${JSON.stringify(slides, null, 2)}` },
    ]);
    return { slides: reviewed, wasReviewed: true };
  } catch (err) {
    onStatus(`Carousel review skipped: ${err.message}`);
    return { slides, wasReviewed: false };
  }
}

// ── Refine ────────────────────────────────────────────────────────────────────
async function refineDraft(draft, synthesis, scoring, user, onStatus) {
  onStatus('Refining draft…');
  const antiPatterns = (scoring.anti_patterns_present || []).join('; ') || 'none';

  const topFixes = (scoring.top_fixes || [])
    .sort((a, b) => (a.priority || 0) - (b.priority || 0))
    .map(f => `P${f.priority}: ${f.problem} → ${f.fix} (impact: ${f.impact})`)
    .join('\n') || 'none';
  const refined = await llmText(getSystemModelId('linkedin_refiner', user, 'mistralai/mistral-medium-3'), [
    { role: 'system', content: `You are a precise editor making targeted improvements to a LinkedIn TEASER post for Douglas McLellan, a senior technology and digital transformation leader in Ireland (M365, AI strategy, healthcare IT, operational leadership). Today's date is ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.

You have the full research synthesis the draft was built from. Use it to fix specific weaknesses — pull a better statistic, sharpen a vague claim, add EU/Ireland context — rather than rewriting from scratch. The draft's structure and core insight are the starting point. Your job is surgical improvement, not a full rewrite.

RECENCY: Draw only from the research synthesis provided and what is already in the draft. Do not introduce statistics or examples from your own training data. If the draft contains a 2024 or older figure presented as current, replace it with a 2025–2026 equivalent from the research, or remove the figure entirely.

This is a teaser — not a complete post. It should intrigue, not inform completely. A companion carousel PDF has the full detail. The teaser's job is to hook a practitioner with one sharp observation and leave them slightly unsatisfied — wanting more — without any explicit CTA.

Scoring rubric this draft is measured against:
${RUBRIC}

CRITICAL — this post is NOT about Douglas's career. Remove any sentence that:
- References his years of experience, tenure, past roles, or career history
- Names client types he has worked with ("healthcare clients", "enterprise clients", "public sector")
- Uses phrases like "In my X years...", "After advising...", "Throughout my career...", "In my experience...", "I have seen...", "My clients...", "I've worked with..."
- Implies personal involvement in any project, programme, or outcome
This is Douglas sharing what the research shows — not his personal story. If the rubric flags missing expertise signal, strengthen it by referencing the research evidence more precisely, not by inventing career context.

Hard rules:
- Exactly 2 paragraphs, 75–100 words total
- All specifics must come from the research synthesis. Do NOT invent statistics, timeframes, or outcomes.
- No em dashes (—). Restructure the sentence or use a full stop instead.
- No engagement-bait endings ("What's your experience?", "What do you think?")
- No generic opening ("In today's fast-moving…")
- No explicit CTA, no "see the carousel", no "link in comments"
- Open with something specific and concrete from the research
- Return ONLY the improved post — no commentary, no preamble` },
    { role: 'user', content: `Research synthesis:\n${synthesis}\n\nDraft:\n${draft}\n\nScore: ${scoring.overall_score}/5 (${scoring.recruiter_value})\nPrioritised fixes:\n${topFixes}\nAnti-patterns: ${antiPatterns}\nCritical gaps: ${(scoring.critical_gaps || []).join('; ') || 'none'}\n\nMake targeted improvements to address these specific issues. Keep what is already working.` },
  ]);
  pipelineLog('draft-refined', refined);
  return refined;
}

// ── Image ─────────────────────────────────────────────────────────────────────
async function generateImage(topic, user, onStatus) {
  const key = process.env.GOOGLE_AI_API_KEY;
  if (!key) { onStatus('Image gen skipped — GOOGLE_AI_API_KEY not set'); return null; }

  onStatus('Generating image…');
  const imagePrompt = await llmText(getSystemModelId('linkedin_image', user, 'deepseek/deepseek-chat'), [
    { role: 'user', content: `Write a concise Gemini image generation prompt for a professional LinkedIn post image about: "${topic}". Clean editorial style, no text in the image, no people, professional. Under 60 words.` },
  ]);

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

// ── Main pipeline ─────────────────────────────────────────────────────────────
async function runPipeline(user, topic, onStatus = () => {}, existingPostId = null, sourceUrl = null) {
  if (!OR_KEY()) throw new Error('OPENROUTER_API_KEY not set');

  const postId = existingPostId || randomUUID();
  const hub = db.hub();
  if (!existingPostId) {
    hub.prepare(`INSERT INTO linkedin_posts (id, user, topic, status) VALUES (?, ?, ?, 'processing')`)
      .run(postId, user, topic);
  }

  const persist = (fields) => {
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    try { hub.prepare(`UPDATE linkedin_posts SET ${sets} WHERE id = ?`).run(...Object.values(fields), postId); } catch (_) {}
  };

  try {
    const { synthesis, sources } = await research(topic, user, onStatus, sourceUrl);
    persist({ research: synthesis });

    const draft = await draftPost(topic, synthesis, user, onStatus);
    persist({ draft });

    const scoring = await scorePost(draft, user, onStatus);
    persist({ score_json: JSON.stringify(scoring) });

    // Refine based on score feedback — graceful skip
    let refinedDraft = null;
    let teaserRefined = false;
    try {
      refinedDraft = await refineDraft(draft, synthesis, scoring, user, onStatus);
      teaserRefined = true;
      persist({ refined_draft: refinedDraft });
    } catch (err) {
      onStatus(`Refinement skipped: ${err.message}`);
    }

    // Carousel PDF
    let carouselUrl = null;
    let carouselReviewed = false;
    try {
      const { pdf: pdfBuffer, wasReviewed } = await generateCarousel(topic, synthesis, refinedDraft || draft, scoring, user, onStatus);
      carouselReviewed = wasReviewed;
      const { drive } = getGoogleClients(user);
      const dateStr = new Date().toISOString().slice(0, 10);
      const slug = topic.slice(0, 40).replace(/[^a-z0-9]/gi, '-').toLowerCase();
      const { driveUrl: url } = await uploadToDrive(
        drive, pdfBuffer.toString('base64'), 'application/pdf', `${dateStr}-${slug}-carousel.pdf`, onStatus
      );
      carouselUrl = url;
      persist({ carousel_url: carouselUrl });
    } catch (err) {
      onStatus(`Carousel skipped: ${err.message}`);
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
    return { postId, topic, draft, refinedDraft, score: scoring, sources, localImagePath, carouselUrl, driveUrl, sheetUrl };

  } catch (err) {
    persist({ status: 'error' });
    throw err;
  }
}

// ── Resume a stuck post (carousel + sheet only) ───────────────────────────────
async function resumePost(postId, user, onStatus = () => {}) {
  const hub = db.hub();
  const post = hub.prepare('SELECT * FROM linkedin_posts WHERE id = ?').get(postId);
  if (!post) throw new Error(`Post ${postId} not found`);

  const persist = (fields) => {
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    hub.prepare(`UPDATE linkedin_posts SET ${sets} WHERE id = ?`).run(...Object.values(fields), postId);
  };

  const scoring = JSON.parse(post.score_json || '{}');
  const draft   = post.refined_draft || post.draft;

  let carouselUrl = null;
  let carouselReviewed = false;
  try {
    const { pdf: pdfBuffer, wasReviewed } = await generateCarousel(post.topic, post.research, draft, scoring, user, onStatus);
    carouselReviewed = wasReviewed;
    const { drive } = getGoogleClients(user);
    const dateStr = new Date().toISOString().slice(0, 10);
    const slug = post.topic.slice(0, 40).replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const { driveUrl: url } = await uploadToDrive(
      drive, pdfBuffer.toString('base64'), 'application/pdf', `${dateStr}-${slug}-carousel.pdf`, onStatus
    );
    carouselUrl = url;
    persist({ carousel_url: carouselUrl });
  } catch (err) {
    onStatus(`Carousel skipped: ${err.message}`);
    console.error('[linkedin] resumePost carousel error:', err.message);
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
  onStatus('Done.');
  return { postId, carouselUrl };
}

module.exports = { runPipeline, resumePost };
