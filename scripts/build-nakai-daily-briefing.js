'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { PROMPTS } = require('../lib/prompts');
const { getSystemModelId, getSystemPrompt } = require('../lib/settings');
const { buildBriefingPdfHtml } = require('../lib/newsletter-pipeline');
const { TASK_CODES, openRouterHeaders } = require('../lib/openrouter-attribution');
const { logUsageFromResponse } = require('../lib/openrouter-usage');
const { captureNakaiDailyBriefing } = require('../lib/knowledge-format');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'output', 'pdf');

function briefingToday() {
  const now = new Date();
  const iso = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const label = now.toLocaleDateString('en-GB', {
    timeZone: 'Europe/Dublin',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return { iso, label };
}

const TODAY = briefingToday();
const DATE = TODAY.label;
const DATE_SLUG = TODAY.iso;

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

const sources = [
  {
    id: 'S1',
    title: 'FCA speech: Beyond the headlines: the unseen fight against financial crime',
    date: '17 June 2026',
    url: 'https://www.fca.org.uk/news/speeches/beyond-headlines-unseen-fight-against-financial-crime',
    notes: [
      'The FCA says financial crime is becoming faster, more complex and more widespread.',
      'The FCA says it is making fuller use of tools including the credible threat of enforcement to step in before harm escalates.',
      'The FCA frames enforcement as including supervision, market oversight and proactive detection, not only headline enforcement actions.',
    ],
  },
  {
    id: 'S2',
    title: 'Central Bank of Ireland warning notices listing',
    date: '17 June 2026',
    url: 'https://www.centralbank.ie/news/article/speech-gabriel-makhlouf-blavatnik-school-of-government-18-february-2026',
    notes: [
      'The Central Bank of Ireland latest article rail showed multiple 17 June 2026 warning notices, including Lambestone Holding Limited (clone), MakoTrade, AllianceBernstein Limited (clone), and SMH Markets (clone).',
    ],
  },
  {
    id: 'S3',
    title: 'EBA press releases page',
    date: '2026 listing',
    url: 'https://www.eba.europa.eu/publications-and-media/press-releases',
    notes: [
      'Recent EBA items include final Guidelines on instruments for the capital endowment requirement for third-country branches under CRD.',
      'The EBA says the Guidelines specify minimum operational conditions to ensure instruments are available when needed.',
      'The EBA page also records work on central validation of ISDA SIMM and consistent, robust, transparent supervisory oversight of initial margin models.',
    ],
  },
  {
    id: 'S4',
    title: 'ESMA statement on smooth implementation of the Listing Act',
    date: '2026',
    url: 'https://www.esma.europa.eu/press-news/esma-news/esma-publishes-statement-supporting-smooth-implementation-listing-act',
    notes: [
      'ESMA clarifies that registration documents and universal registration documents approved or filed until 4 June 2026 fall within the Article 48a transitional regime.',
      'ESMA says the approach aligns with simplification and burden-reduction efforts while maintaining investor protection.',
    ],
  },
  {
    id: 'S5',
    title: 'FATF publications: Stablecoins and Unhosted Wallets',
    date: '3 March 2026',
    url: 'https://www.fatf-gafi.org/en/publications.html',
    notes: [
      'FATF highlights illicit finance risks from criminals misuse of stablecoins, particularly P2P transactions through unhosted wallets.',
      'FATF says the report sets out recommended actions for countries and the private sector to strengthen controls protecting financial-system integrity.',
    ],
  },
  {
    id: 'S6',
    title: 'FATF targeted update on virtual assets and VASPs',
    date: '2025 targeted update, still current context',
    url: 'https://www.fatf-gafi.org/en/publications/Fatfrecommendations/targeted-update-virtual-assets-vasps-2025.html',
    notes: [
      'FATF says regulatory failures in one jurisdiction can have global consequences because virtual assets are borderless.',
      'FATF highlights increased illicit use of stablecoins by DPRK actors, terrorist financiers, and drug traffickers.',
      'FATF cites the ByBit theft of $1.46 billion and says only 3.8 percent had been recovered.',
      'FATF notes an estimate of about $51 billion in illicit on-chain activity relating to fraud and scams in 2024.',
    ],
  },
  {
    id: 'S7',
    title: 'Block announces opening of strategic European hub in Dublin',
    date: '29 January 2026',
    url: 'https://block.xyz/inside/block-announces-opening-of-strategic-european-hub-in-dublin',
    notes: [
      'Block says the One Park Place Dublin office reinforces its commitment to European growth.',
      'John O Beirne, CEO of Square International at Block, says Dublin is the natural home for Block European growth.',
      'The office includes spaces for regulatory roundtables, industry working groups, seller workshops, and local financial-institution engagement.',
      'Block describes the office as a strategic gateway for policy engagement, seller empowerment, and talent development.',
      'The company description names Square, Cash App, Afterpay, TIDAL, Bitkey, and Proto.',
    ],
  },
  {
    id: 'S8',
    title: 'Cash App: Afterpay on Cash App Card generally available',
    date: '2 June 2026',
    url: 'https://cash.app/press/afterpay-on-cash-app-card-ga',
    notes: [
      'Cash App announced Afterpay on Cash App Card for eligible customers.',
      'The product brings BNPL into everyday spend categories such as groceries, gas, restaurants, and utilities.',
      'Cash App says the product pairs near real-time data underwriting based on cash-flow patterns and financial behaviors with Afterpay pay-over-time expertise.',
      'Terms cited by Cash App include a flat 7.5 percent finance fee, six-week repayment, no revolving debt, no down payment, and no impact to customer credit score.',
      'Cash App says the rollout extends to all eligible Cash App Card customers across 59 million monthly transacting actives.',
    ],
  },
  {
    id: 'S9',
    title: 'FCA: Regulating Buy Now Pay Later',
    date: 'Updated 8 June 2026',
    url: 'https://www.fca.org.uk/firms/regulating-buy-now-pay-later',
    notes: [
      'The FCA will start regulating Deferred Payment Credit, often known as BNPL, on 15 July 2026.',
      'From regulation day, DPC lenders need relevant consumer credit authorisation or temporary permission and must comply with FCA rules.',
      'The FCA register lists Clearpay (Clearpay Finance Ltd) as registered for temporary permission.',
      'The FCA says the regime aims to reduce consumer harm while allowing DPC innovation and sustainable growth.',
      'The FCA aims include effective consumer information, responsible and affordable lending, support for customers in difficulty, and better product-sales data for supervision.',
    ],
  },
  {
    id: 'S10',
    title: 'Block investor release: Pay-over-time for Cash App P2P transfers',
    date: '2 April 2026',
    url: 'https://investors.block.xyz/investor-news/news-details/2026/Cash-App-Breaks-New-Ground-as-First-to-Enable-Pay-Over-Time-for-P2P-Money-Transfers/default.aspx',
    notes: [
      'Cash App says eligible customers can convert recent P2P payments into short-term installment plans for an upfront fee.',
      'The feature is framed as clear upfront fee, short fixed term, no revolving balance, no compounding interest, and flexible repayment options.',
      'The product applies to eligible P2P sends of $25 or more made within the last 30 days.',
      'Cash App disclosures say Bitcoin services are not licensable activity in all US states and that Block operates in New York as Block of Delaware and is licensed for virtual currency business activity by NYDFS.',
    ],
  },
  {
    id: 'S11',
    title: 'Block 2025 Form 10-K',
    date: '2026 filing for FY2025',
    url: 'https://www.sec.gov/Archives/edgar/data/1512673/000162828026012254/xyz-20251231.htm',
    notes: [
      'Block says Cash App Commerce Enablement products connect consumers and merchants through Pay Now and Pay Later capabilities.',
      'Block says Cash App and Afterpay offer Pay Later capabilities to make purchases more flexible and accessible for consumers and improve merchant conversion and average order value.',
    ],
  },
  {
    id: 'S12',
    title: 'CSBS: State regulators issue $80 million penalty to Block, Inc., Cash App',
    date: '15 January 2025',
    url: 'https://www.csbs.org/newsroom/state-regulators-issue-80-million-penalty-block-inc-cash-app-bsaaml-violations',
    notes: [
      'In a coordinated action by 48 state financial regulators, Block agreed to pay an $80 million fine and undertake corrective action for BSA/AML violations.',
      'The action concerned laws safeguarding the financial system from illicit use.',
    ],
  },
  {
    id: 'S13',
    title: 'NYDFS settlement with Block over AML and virtual currency compliance',
    date: '10 April 2025',
    url: 'https://www.dfs.ny.gov/reports_and_publications/press_releases/pr202504101',
    notes: [
      'NYDFS announced a $40 million penalty for significant failures in Block anti-money-laundering compliance and virtual currency compliance on the Cash App platform.',
      'NYDFS required Block to retain an independent monitor for comprehensive evaluation of compliance and remediation.',
    ],
  },
  {
    id: 'S14',
    title: 'CFPB newsroom: BNPL enforcement-priority announcement and payments items',
    date: '2025 context',
    url: 'https://www.consumerfinance.gov/about-us/newsroom/',
    notes: [
      'CFPB announced it would not prioritize enforcement based on its BNPL interpretive rule under Regulation Z.',
      'CFPB newsroom also records enforcement and policy activity around electronic payments, mobile financial services, money transfers, supervision, and small-business lending.',
    ],
  },
  {
    id: 'S15',
    title: 'Payments Dive: Block shutters some European operations',
    date: '4 August 2023, context only',
    url: 'https://www.paymentsdive.com/news/block-shutters-some-operations-cashapp-verse-clearpay-afterpay-bnpl-europe-dorsey/689976/',
    notes: [
      'Payments Dive reported Block shuttered Cash App Verse in the EU and Clearpay operations in Spain, France, and Italy.',
      'This is stale context, useful only for interpreting the current Dublin/Europe posture and should not be presented as current news.',
    ],
  },
];

function sourcePackMarkdown() {
  return sources.map(source => [
    `[${source.id}] ${source.title}`,
    `Date: ${source.date}`,
    `URL: ${source.url}`,
    'Evidence:',
    ...source.notes.map(note => `- ${note}`),
  ].join('\n')).join('\n\n---\n\n');
}

function fallbackBriefing() {
  return `# Daily Briefing

${DATE}

## Executive Readout
- The live regulatory signal today is the FCA's 17 June financial-crime speech: it points to earlier intervention through supervision, market oversight, proactive detection, and the credible threat of enforcement [S1].
- Central Bank of Ireland warning notices from 17 June are relevant as customer-harm and clone-firm signals for brand protection and scams monitoring in Ireland [S2].
- The live product-adjacent deadline is UK BNPL regulation on 15 July 2026. Clearpay is already listed by the FCA as having temporary permission, so the near-term issue is execution against the new conduct and reporting expectations [S9].
- No new US federal or state regulator item about Block was found in today's source pack.

## EU, UK and International Regulatory Watch

### FCA - financial crime posture (17 June)
The FCA speech on 17 June says financial crime is becoming faster, more complex and more widespread. The important point for Nakai is not only enforcement volume; it is the FCA's statement that it is using supervision, market oversight, proactive detection, and the credible threat of enforcement to intervene before harm escalates [S1].

Implication for Block Europe: treat financial-crime controls, customer-risk signals, scams/fraud typologies, and cross-product monitoring as a live supervisory narrative. This is relevant to Cash App-adjacent product design, Square seller risk, Afterpay/Clearpay affordability and fraud controls, and any virtual-asset or bitcoin-related exposure [S1].

### FCA - BNPL regulation countdown (live July deadline)
The FCA says Deferred Payment Credit, commonly BNPL, becomes regulated on 15 July 2026. DPC lenders must be authorised for consumer-credit activities or have temporary permission, and must comply with FCA rules from regulation day [S9].

Clearpay is named on the FCA register of lenders with temporary permission. The FCA states that its aims include effective consumer information, responsible and affordable lending, support for customers in difficulty, and better product-sales data for supervision [S9].

Implication for Block Europe: Clearpay is now inside the live transition period. The key monitoring questions are authorisation readiness, product-sales data, customer-difficulty handling, affordability evidence, and whether Cash App Afterpay style features create future UK/EU read-across even when launched in the US [S8] [S9].

### Central Bank of Ireland - warnings and clones (17 June)
The Central Bank's latest article rail showed several 17 June warning notices, including clone and unauthorised-firm warnings. These should be treated as a financial-crime and customer-harm signal rather than as product-specific Block news [S2].

Implication for Block Europe: Irish warnings matter for brand protection, onboarding controls, seller-risk education, and scams monitoring. The practical read-across is stronger clone-firm monitoring and seller/customer education around scams [S2].

### FATF/taskforce watch
No fresh FATF publication from the last 7 days was identified in today's source pack. The relevant live taskforce point is to monitor FATF Week June 2026 outputs and any new statements on virtual assets, stablecoins, unhosted wallets, fraud, or payment transparency [S5] [S6].

## Block Product Watch

### Cash App and Afterpay (2 June, still within product-watch window)
Cash App announced general availability of Afterpay on Cash App Card for eligible customers on 2 June. The product extends BNPL into everyday spend categories and uses near real-time cash-flow and behavioural underwriting, with a flat 7.5 percent finance fee, six-week repayment, no revolving debt, no down payment, and no credit-score impact according to the company release [S8].

This remains useful today because it intersects with the live FCA BNPL countdown. The EU/UK question is whether product designs based on cash-flow underwriting, repeat usage, and everyday spend categories generate read-across for affordability, customer understanding, and supervisory product-sales data [S8] [S9].

### Square, Bitkey, Proto and TIDAL
No new official or financial-press items from the last 14 days were identified in today's source pack for Square, Bitkey, Proto, or TIDAL.

## US Regulatory Watch

No new US federal or state regulator item about Block, Cash App, Square, Afterpay, or the listed product categories was found in today's source pack.

## Watchlist for Nakai
- Confirm Clearpay readiness against the 15 July FCA BNPL regime, including temporary-permission obligations, customer information, affordability, customer-difficulty support, and product-sales data [S9].
- Watch for any FCA follow-up or supervisory messaging after the 17 June financial-crime speech, especially themes that touch payments, scams, mule activity, and proactive detection [S1].
- Monitor Irish warning notices for misuse of Block, Square, Cash App, Afterpay/Clearpay, Bitkey, Proto, or TIDAL branding [S2].
- Track FATF Week June 2026 for any new virtual-asset, stablecoin, unhosted-wallet, P2P transaction, fraud, or payment-transparency output [S5] [S6].
- Keep the Cash App Afterpay Card launch under EU read-across review while FCA BNPL implementation is live [S8] [S9].

## Standing Context
- Block's January Dublin hub announcement remains useful background for why Ireland is the centre of the European policy-engagement posture, but it is not today's news [S7].
- The 2025 CSBS and NYDFS Cash App actions remain standing control context for AML, virtual-currency, and remediation expectations, but no new US enforcement item was identified today [S12] [S13].
- The 2023 Payments Dive item on European retrenchment is historical context only and should not be used as a daily item [S15].

## Sources
${sources
  .filter(source => ['S1', 'S2', 'S5', 'S6', 'S7', 'S8', 'S9', 'S12', 'S13', 'S15'].includes(source.id))
  .map(source => `- [${source.id}] ${source.title} - ${source.url}`)
  .join('\n')}`;
}

async function generateMarkdown() {
  loadDotEnv();
  if (process.env.NAKAI_DAILY_BRIEFING_SOURCE_MD && fs.existsSync(process.env.NAKAI_DAILY_BRIEFING_SOURCE_MD)) {
    return fs.readFileSync(process.env.NAKAI_DAILY_BRIEFING_SOURCE_MD, 'utf8');
  }
  const prompt = getSystemPrompt('nakai_daily_briefing', 'system', PROMPTS.nakai_daily_briefing);
  const modelId = getSystemModelId('nakai_daily_briefing', 'system', 'anthropic/claude-sonnet-4-6');
  const fullPrompt = `${prompt}\n\nCurrent date: ${DATE}\n\nSource pack:\n\n${sourcePackMarkdown()}`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'nakai-daily-briefing-prompt.md'), fullPrompt, 'utf8');

  if (process.env.NAKAI_DAILY_BRIEFING_FORCE_FALLBACK) return fallbackBriefing();
  if (!process.env.OPENROUTER_API_KEY) return fallbackBriefing();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    const started = Date.now();
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: openRouterHeaders(TASK_CODES.NAKAI_DAILY_BRIEFING),
      body: JSON.stringify({
        model: modelId,
        temperature: 0.2,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `Current date: ${DATE}\n\nSource pack:\n\n${sourcePackMarkdown()}` },
        ],
      }),
    });
    clearTimeout(timeout);
    if (!r.ok) throw new Error(`OpenRouter HTTP ${r.status}`);
    const data = await r.json();
    logUsageFromResponse({
      user: 'nakai',
      feature: 'nakai-daily-briefing',
      modelKey: 'nakai_daily_briefing',
      fallbackModelId: modelId,
      data,
      durationMs: Date.now() - started,
      taskCode: TASK_CODES.NAKAI_DAILY_BRIEFING,
    });
    const text = data.choices?.[0]?.message?.content?.trim();
    return text && /^# Daily Briefing/m.test(text) ? text : fallbackBriefing();
  } catch (err) {
    console.warn(`[nakai-briefing] model generation failed, using fallback: ${err.message}`);
    return fallbackBriefing();
  }
}

async function renderPdf(markdown) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const normalized = normalizeForBriefingPdf(stripEditorialLeakage(markdown));
  const html = buildBriefingPdfHtml(normalized, DATE, 'Daily Briefing')
    .replace(/Douglas McLellan/g, 'Nakai McLellan')
    .replace(/Technology Leader/g, 'Block EU Intelligence')
    .replace(/douglas\.mclellan\.scot/g, 'Private briefing');

  const htmlPath = path.join(OUT_DIR, `nakai-daily-briefing-${DATE_SLUG}.html`);
  const mdPath = path.join(OUT_DIR, `nakai-daily-briefing-${DATE_SLUG}.md`);
  const pdfPath = path.join(OUT_DIR, `nakai-daily-briefing-${DATE_SLUG}.pdf`);
  fs.writeFileSync(mdPath, normalized, 'utf8');
  fs.writeFileSync(htmlPath, html, 'utf8');

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync(pdfPath, pdf);
    return { pdfPath, mdPath, htmlPath };
  } finally {
    await browser.close();
  }
}

function normalizeForBriefingPdf(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const out = [];
  let skippedTitle = false;
  let skippedDate = false;

  for (let line of lines) {
    if (!skippedTitle && /^#\s+Daily Briefing\s*$/i.test(line.trim())) {
      skippedTitle = true;
      continue;
    }
    if (skippedTitle && !skippedDate && line.trim() === DATE) {
      skippedDate = true;
      continue;
    }
    if (/^\s*\*\s+/.test(line)) line = line.replace(/^\s*\*\s+/, '- ');
    out.push(line);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripEditorialLeakage(markdown) {
  return String(markdown || '')
    .replace(/;\s*ignore Irish-language duplicates when English versions exist/gi, '')
    .replace(/\bFor the briefing workflow,\s*English-language Central Bank items are enough;\s*Irish-language duplicates should be ignored\.?\s*/gi, '')
    .replace(/\bIrish-language duplicates should be ignored for this briefing workflow\.?\s*/gi, '')
    .replace(/\bThis is a source-selection rule only:.*?(?:\n|$)/gi, '');
}

async function main() {
  const markdown = await generateMarkdown();
  const result = await renderPdf(markdown);
  try {
    result.knowledgePath = captureNakaiDailyBriefing({
      markdown: fs.readFileSync(result.mdPath, 'utf8'),
      dateSlug: DATE_SLUG,
      htmlPath: result.htmlPath,
      pdfPath: result.pdfPath,
    });
  } catch (err) {
    console.warn(`[nakai-briefing] knowledge capture failed: ${err.message}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
