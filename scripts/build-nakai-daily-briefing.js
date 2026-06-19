'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const fetch = require('../lib/fetch');
const { PROMPTS } = require('../lib/prompts');
const { getSystemModelId, getSystemPrompt } = require('../lib/settings');
const { buildBriefingPdfHtml } = require('../lib/newsletter-pipeline');
const { TASK_CODES, openRouterHeaders } = require('../lib/openrouter-attribution');
const { logUsageFromResponse } = require('../lib/openrouter-usage');
const { captureNakaiDailyBriefing } = require('../lib/knowledge-format');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'output', 'pdf');
const STORE_DIR = path.join(ROOT, 'data', 'nakai-briefings');
const START_DATE = process.env.NAKAI_DAILY_BRIEFING_START_DATE || '2026-06-19';

function briefingMeta(date = new Date()) {
  const now = date instanceof Date ? date : new Date(date);
  const iso = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const label = now.toLocaleDateString('en-GB', {
    timeZone: 'Europe/Dublin',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const edition = editionForDate(iso);
  const title = edition ? `Daily Briefing ${edition}` : 'Daily Briefing';
  const previousEdition = previousEditionFor(edition);
  return { iso, label, edition, title, previousEdition };
}

function editionForDate(isoDate) {
  const start = Date.parse(`${START_DATE}T00:00:00Z`);
  const current = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(current) || current < start) return null;
  const days = Math.floor((current - start) / 86400000) + 1;
  return String(days).padStart(3, '0');
}

function previousEditionFor(edition) {
  if (!edition) return null;
  const n = Number(edition);
  if (!Number.isFinite(n) || n <= 1) return null;
  return String(n - 1).padStart(3, '0');
}

function adminBaseUrl() {
  return process.env.HUB_URL || 'https://dchat.mclellan.scot';
}

function resendUrl(edition) {
  return edition ? `${adminBaseUrl().replace(/\/$/, '')}/admin/nakai-briefings/${edition}/resend` : '';
}

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
  {
    id: 'S16',
    title: 'FCA: Our Consumer Duty focus areas',
    date: 'Published 30 September 2025, updated 7 May 2026',
    url: 'https://www.fca.org.uk/publications/corporate-documents/consumer-duty-focus-areas',
    notes: [
      'The FCA says the Consumer Duty remains a priority under its 2025 to 2030 strategy to deepen trust, rebalance risk, support growth and improve lives.',
      'The page sets out 2025 to 2026 priorities for embedding the Duty, support for firms and sector-specific focus areas.',
      'This is a high-credibility audit-horizon source for Consumer Duty planning because it signals current FCA supervisory emphasis rather than only the original rules.',
    ],
  },
  {
    id: 'S17',
    title: 'FCA: Year 2 Consumer Duty Board Reports - progress and what comes next',
    date: 'April 2026',
    url: 'https://www.fca.org.uk/news/blogs/year-2-consumer-duty-board-reports-progress-and-what-comes-next',
    notes: [
      'The FCA says firms increasingly set out comprehensive action plans, with clear responsibilities, timelines and progress updates.',
      'The FCA says most reports now identify accountable owners for improvements and track delivery status so Boards can monitor progress more systematically.',
      'Audit relevance: board reporting should evidence ownership, outcome monitoring, action tracking, governance challenge and closure discipline.',
    ],
  },
  {
    id: 'S18',
    title: 'FCA: Consumer understanding - good practice and areas for improvement',
    date: 'March 2026',
    url: 'https://www.fca.org.uk/publications/good-and-poor-practice/consumer-understanding-good-practice-areas-improvement',
    notes: [
      'The FCA says firms should make communication design, testing, monitoring and governance a coherent end-to-end process.',
      'This is directly relevant to Consumer Duty audits of customer journeys, disclosures, fees, product terms, complaints and support channels.',
      'Audit relevance: test whether communications are designed, tested, monitored and escalated using evidence rather than assumed to be understandable.',
    ],
  },
  {
    id: 'S19',
    title: "FCA blog: What do we mean when we say 'fair value'?",
    date: 'February 2026',
    url: 'https://www.fca.org.uk/news/blogs/what-do-we-mean-when-we-say-fair-value',
    notes: [
      'The FCA frames fair value as whether customers are paying a reasonable price for a product compared with the benefits they get in return.',
      'The FCA says firms need evidence that customers are getting a fair deal; if they cannot provide it, they need to look again.',
      'Audit relevance: fair value work should connect pricing, fees, customer cohorts, benefits, outcomes data, complaints and remedial action.',
    ],
  },
  {
    id: 'S20',
    title: 'FCA: Operational resilience - insights and observations one year on',
    date: '27 March 2026',
    url: 'https://www.fca.org.uk/publications/good-and-poor-practice/operational-resilience-insights-observations-one-year',
    notes: [
      'The FCA tells firms to continue complying with operational resilience rules and to use observations from self-assessments to review and evolve their approach.',
      'The FCA highlights important business services, impact tolerances and the need for clear shared understanding of each service and how disruption could cause intolerable harm to consumers or threaten market integrity.',
      'Audit relevance: test service definitions, impact tolerances, mapping, scenario testing, vulnerabilities, remediation, self-assessment quality and senior ownership.',
    ],
  },
  {
    id: 'S21',
    title: 'FCA: Operational resilience',
    date: 'Updated June 2026',
    url: 'https://www.fca.org.uk/firms/operational-resilience',
    notes: [
      'The FCA says firms in scope had until 31 March 2025 to ensure they could operate important business services within impact tolerances.',
      'The page links the operational resilience regime to cyber resilience observations and incident reporting preparations.',
      'Audit relevance: the post-transition question is no longer whether mapping exists, but whether the firm can evidence operation within tolerances under severe but plausible scenarios.',
    ],
  },
  {
    id: 'S22',
    title: 'FCA: Reporting operational incidents',
    date: '18 March 2026',
    url: 'https://www.fca.org.uk/firms/operational-resilience/reporting-operational-incidents',
    notes: [
      'The FCA says firms should prepare for new reporting rules coming into force on 18 March 2027.',
      'The page is relevant to material operational incident governance, escalation thresholds, data capture and regulatory reporting readiness.',
      'Audit relevance: test whether incident taxonomy, escalation, MI, ownership and reporting playbooks are aligned to the forthcoming regime.',
    ],
  },
  {
    id: 'S23',
    title: 'Bank of England/PRA: PS7/26 Operational incident and third-party reporting',
    date: 'March 2026',
    url: 'https://www.bankofengland.co.uk/prudential-regulation/publication/2026/march/operational-incident-and-third-party-reporting-policy-statement',
    notes: [
      'The PRA policy statement covers operational incident reporting and material third-party arrangement reporting.',
      'The PRA says flexibility is important because the same operational incident may have varying impacts across firms depending on size, business model, services or customer base.',
      'Audit relevance: test materiality judgements, third-party inventory completeness, incident severity assessment, governance challenge and reporting evidence.',
    ],
  },
  {
    id: 'S24',
    title: 'PRA Business Plan 2026/27',
    date: 'April 2026',
    url: 'https://www.bankofengland.co.uk/prudential-regulation/publication/2026/april/pra-business-plan-2026-27',
    notes: [
      'The PRA says its operational resilience policy was fully implemented in March 2025.',
      'During 2026/27 the PRA will continue robust supervisory standards through operational and cyber resilience assessments such as CBEST, working with the National Cyber Security Centre.',
      'Audit relevance: UK operational resilience audit work should consider cyber resilience, testing, remediation and evidence of senior-level oversight.',
    ],
  },
  {
    id: 'S25',
    title: 'Central Bank of Ireland: Digital Operational Resilience Act (DORA)',
    date: 'Updated 2026',
    url: 'https://www.centralbank.ie/regulation/digital-operational-resilience-act-dora',
    notes: [
      'The Central Bank says DORA has applied since 17 January 2025 and applies to a wide range of financial entities regulated by the Central Bank of Ireland.',
      'The Central Bank says DORA brings together provisions addressing digital operational risk in the financial sector in a consistent manner.',
      'Audit relevance: DORA audit work should cover ICT risk management, incident reporting, resilience testing, third-party ICT risk and governance ownership.',
    ],
  },
  {
    id: 'S26',
    title: 'Central Bank of Ireland: Operational Resilience',
    date: 'Updated July 2025',
    url: 'https://www.centralbank.ie/financial-system/operational-resilience-and-cyber/operational-resilience',
    notes: [
      'The Central Bank says it updated and republished its operational resilience guidance in July 2025 to align with DORA and withdrew its 2016 IT and cybersecurity risk guidance.',
      'The Central Bank says the guidance explains how to prepare for, respond to, recover and learn from operational disruptions affecting critical or important business services.',
      'Audit relevance: Irish operational resilience audit work should bridge DORA minimum standards with Central Bank expectations on important services and disruption response.',
    ],
  },
  {
    id: 'S27',
    title: 'Central Bank of Ireland: Reporting Registers of Information',
    date: '2026',
    url: 'https://www.centralbank.ie/regulation/digital-operational-resilience-act-dora/reporting-registers-of-information',
    notes: [
      'The Central Bank says financial entities subject to DORA must submit Registers of Information on contractual arrangements for ICT third-party services.',
      'Audit relevance: test RoI completeness, data lineage, ownership, contract population, validation checks and reconciliation to vendor/outsourcing inventories.',
    ],
  },
  {
    id: 'S28',
    title: 'Central Bank of Ireland: Reporting major ICT-related incidents and significant cyber threats',
    date: '2026',
    url: 'https://www.centralbank.ie/regulation/digital-operational-resilience-act-dora/reporting-major-ict-related-incidents-and-significant-cyber-threats',
    notes: [
      'The Central Bank says financial entities subject to DORA have been obliged since 17 January 2025 to submit major ICT-related incident reports where criteria and thresholds are met.',
      'The page also covers significant cyber-threat submissions.',
      'Audit relevance: test threshold assessment, reporting workflow, incident evidence, cyber-threat escalation and post-incident lessons learned.',
    ],
  },
  {
    id: 'S29',
    title: 'Central Bank of Ireland: Regulatory and Supervisory Outlook 2026',
    date: 'February 2026',
    url: 'https://www.centralbank.ie/publication/regulatory---supervisory-outlook-report',
    notes: [
      'The Central Bank says its 2026 Outlook sets out key trends, risks and regulatory and supervisory priorities for the next two years.',
      'Search-result excerpts from the report highlight DORA, ICT risk management, and maintaining resilient financial services to consumers and investors.',
      'Audit relevance: use the Outlook to frame operational resilience as customer/investor service continuity, not only technology compliance.',
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

function fallbackBriefing(meta = briefingMeta()) {
  const editionLine = meta.previousEdition
    ? `\nPrevious edition: Daily Briefing ${meta.previousEdition}`
    : meta.edition
      ? '\nPrevious edition: none'
      : '';
  return `# ${meta.title}

${meta.label}${editionLine}

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

## Audit Horizon: Consumer Duty and Operational Resilience

### Consumer Duty - UK
The strongest one-year audit-planning signals are the FCA's Consumer Duty focus areas, Year 2 board-report commentary, consumer understanding work, and fair-value commentary. For audit purposes, this points away from a simple policy-existence review and toward evidence of outcomes monitoring, accountable action owners, board challenge, delivery tracking, communications testing, customer cohort analysis, fair-value evidence, complaints/root-cause feedback and remediation closure [S16] [S17] [S18] [S19].

Implication for Nakai: a Consumer Duty audit should test whether governance forums can show how they know customers are receiving good outcomes, not only whether the firm has mapped the Duty. Strong work papers should connect MI, customer journeys, fee/value assessments, support performance, vulnerable-customer considerations, complaints, incidents and product changes to documented decisions and action plans [S16] [S17] [S18] [S19].

### Operational Resilience - UK
The FCA's post-transition operational-resilience material and PRA 2026 policy/business-plan material make clear that the UK regime is now in evidence-and-operation mode. Firms had until 31 March 2025 to be able to operate important business services within impact tolerances; the current audit question is whether the firm can evidence service definitions, tolerances, mapping, scenario testing, vulnerabilities, remediation and senior ownership under severe but plausible disruption [S20] [S21] [S23] [S24].

The FCA and PRA incident-reporting material also creates a forward-looking audit angle: incident materiality, escalation, third-party dependency data, reporting thresholds, and evidence quality need to be ready before new reporting obligations take effect in 2027 [S22] [S23].

### Operational Resilience - Ireland/EU
For Ireland, the live frame is DORA plus the Central Bank's updated operational-resilience guidance. DORA has applied since 17 January 2025; the Central Bank's 2025 guidance refresh aligns its operational resilience expectations with DORA and withdraws older IT/cyber guidance. The audit emphasis should therefore cover ICT risk management, major incident reporting, cyber-threat reporting, registers of information, ICT third-party arrangements, service continuity and lessons learned from disruption [S25] [S26] [S27] [S28].

Implication for Nakai: an Irish operational-resilience audit should reconcile DORA artifacts, Central Bank expectations, outsourcing/vendor inventories, incident playbooks and important-service mapping. The likely evidence gaps are register completeness, ownership of ICT third-party data, threshold decisions, validation evidence and proof that operational resilience is managed as service continuity for users rather than as a standalone technology compliance exercise [S25] [S26] [S27] [S28] [S29].

## US Regulatory Watch

No new US federal or state regulator item about Block, Cash App, Square, Afterpay, or the listed product categories was found in today's source pack.

## Watchlist for Nakai
- Confirm Clearpay readiness against the 15 July FCA BNPL regime, including temporary-permission obligations, customer information, affordability, customer-difficulty support, and product-sales data [S9].
- Watch for any FCA follow-up or supervisory messaging after the 17 June financial-crime speech, especially themes that touch payments, scams, mule activity, and proactive detection [S1].
- Monitor Irish warning notices for misuse of Block, Square, Cash App, Afterpay/Clearpay, Bitkey, Proto, or TIDAL branding [S2].
- Build Consumer Duty audit criteria around evidence of outcomes, board reporting, communications testing, fair value and action-plan closure, using FCA 2025/26 focus material as the supervisory anchor [S16] [S17] [S18] [S19].
- Build UK/Ireland operational-resilience audit criteria around important services, impact tolerances, scenario testing, DORA, ICT third-party data, incident reporting and senior ownership [S20] [S21] [S25] [S26] [S27] [S28].
- Track FATF Week June 2026 for any new virtual-asset, stablecoin, unhosted-wallet, P2P transaction, fraud, or payment-transparency output [S5] [S6].
- Keep the Cash App Afterpay Card launch under EU read-across review while FCA BNPL implementation is live [S8] [S9].

## Standing Context
- Block's January Dublin hub announcement remains useful background for why Ireland is the centre of the European policy-engagement posture, but it is not today's news [S7].
- The 2025 CSBS and NYDFS Cash App actions remain standing control context for AML, virtual-currency, and remediation expectations, but no new US enforcement item was identified today [S12] [S13].
- The 2023 Payments Dive item on European retrenchment is historical context only and should not be used as a daily item [S15].

## Sources
${sources
  .filter(source => ['S1', 'S2', 'S5', 'S6', 'S7', 'S8', 'S9', 'S12', 'S13', 'S15', 'S16', 'S17', 'S18', 'S19', 'S20', 'S21', 'S22', 'S23', 'S24', 'S25', 'S26', 'S27', 'S28', 'S29'].includes(source.id))
  .map(source => `- [${source.id}] ${source.title} - ${source.url}`)
  .join('\n')}`;
}

async function generateMarkdown(meta = briefingMeta()) {
  loadDotEnv();
  if (process.env.NAKAI_DAILY_BRIEFING_SOURCE_MD && fs.existsSync(process.env.NAKAI_DAILY_BRIEFING_SOURCE_MD)) {
    return fs.readFileSync(process.env.NAKAI_DAILY_BRIEFING_SOURCE_MD, 'utf8');
  }
  const prompt = getSystemPrompt('nakai_daily_briefing', 'system', PROMPTS.nakai_daily_briefing);
  const modelId = getSystemModelId('nakai_daily_briefing', 'system', 'anthropic/claude-sonnet-4-6');
  const editionContext = meta.edition
    ? `Briefing edition: ${meta.edition}\nPrevious edition: ${meta.previousEdition || 'none'}\nResend admin action: ${resendUrl(meta.edition)}\n`
    : '';
  const previousContext = previousEditionContext(meta);
  const fullPrompt = `${prompt}\n\nCurrent date: ${meta.label}\n${editionContext}${previousContext}\nSource pack:\n\n${sourcePackMarkdown()}`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'nakai-daily-briefing-prompt.md'), fullPrompt, 'utf8');

  if (process.env.NAKAI_DAILY_BRIEFING_FORCE_FALLBACK) return fallbackBriefing(meta);
  if (!process.env.OPENROUTER_API_KEY) return fallbackBriefing(meta);

  try {
    const started = Date.now();
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      timeout: 60000,
      headers: openRouterHeaders(TASK_CODES.NAKAI_DAILY_BRIEFING),
      body: JSON.stringify({
        model: modelId,
        temperature: 0.2,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `Current date: ${meta.label}\n${editionContext}${previousContext}\nSource pack:\n\n${sourcePackMarkdown()}` },
        ],
      }),
    });
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
    return text && /^# Daily Briefing/m.test(text) ? text : fallbackBriefing(meta);
  } catch (err) {
    console.warn(`[nakai-briefing] model generation failed, using fallback: ${err.message}`);
    return fallbackBriefing(meta);
  }
}

async function renderPdf(markdown, meta = briefingMeta()) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const normalized = normalizeForBriefingPdf(stripEditorialLeakage(markdown), meta);
  const html = buildBriefingPdfHtml(normalized, meta.label, meta.title)
    .replace(/Douglas McLellan/g, 'Nakai McLellan')
    .replace(/Technology Leader/g, 'Block EU Intelligence')
    .replace(/douglas\.mclellan\.scot/g, 'Private briefing');

  const fileStem = meta.edition
    ? `nakai-daily-briefing-${meta.edition}-${meta.iso}`
    : `nakai-daily-briefing-${meta.iso}`;
  const htmlPath = path.join(OUT_DIR, `${fileStem}.html`);
  const mdPath = path.join(OUT_DIR, `${fileStem}.md`);
  const pdfPath = path.join(OUT_DIR, `${fileStem}.pdf`);
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

function normalizeForBriefingPdf(markdown, meta = briefingMeta()) {
  const lines = String(markdown || '').split(/\r?\n/);
  const out = [];
  let skippedTitle = false;
  let skippedDate = false;

  for (let line of lines) {
    if (!skippedTitle && /^#\s+Daily Briefing(?:\s+\d{3})?\s*$/i.test(line.trim())) {
      skippedTitle = true;
      continue;
    }
    if (skippedTitle && !skippedDate && line.trim() === meta.label) {
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

function nakaiEmail() {
  const raw = process.env.NAKAI_GOOGLE_EMAILS || process.env.NAKAI_GOOGLE_EMAIL || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean)[0] || '';
}

function storedDir(edition) {
  if (!edition || !/^\d{3}$/.test(String(edition))) throw new Error(`Invalid edition: ${edition}`);
  return path.join(STORE_DIR, String(edition));
}

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return fallback; }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function archiveBriefing(result, meta) {
  if (!meta.edition) return null;
  const dir = storedDir(meta.edition);
  fs.mkdirSync(dir, { recursive: true });
  const stored = {
    edition: meta.edition,
    date: meta.iso,
    label: meta.label,
    title: meta.title,
    previousEdition: meta.previousEdition,
    mdPath: path.join(dir, 'briefing.md'),
    htmlPath: path.join(dir, 'briefing.html'),
    pdfPath: path.join(dir, 'briefing.pdf'),
    promptPath: path.join(dir, 'prompt.md'),
    generatedAt: new Date().toISOString(),
    sentAt: null,
    to: null,
  };
  fs.writeFileSync(stored.mdPath, withArchiveMarkdownHeader(fs.readFileSync(result.mdPath, 'utf8'), meta), 'utf8');
  fs.copyFileSync(result.htmlPath, stored.htmlPath);
  fs.copyFileSync(result.pdfPath, stored.pdfPath);
  const promptPath = path.join(OUT_DIR, 'nakai-daily-briefing-prompt.md');
  if (fs.existsSync(promptPath)) fs.copyFileSync(promptPath, stored.promptPath);
  const prior = readJson(path.join(dir, 'manifest.json'), {});
  const manifest = { ...prior, ...stored, sentAt: prior.sentAt || null, to: prior.to || null };
  writeJson(path.join(dir, 'manifest.json'), manifest);
  writeBriefingIndex();
  return manifest;
}

function withArchiveMarkdownHeader(markdown, meta) {
  const text = String(markdown || '')
    .trim()
    .replace(/^(?:Previous edition:\s*(?:none|Daily Briefing \d{3})\s*\n+)+/i, '')
    .trim();
  if (/^#\s+Daily Briefing(?:\s+\d{3})?/i.test(text)) return `${text}\n`;
  const lines = [`# ${meta.title}`, '', meta.label];
  if (meta.previousEdition) lines.push('', `Previous edition: Daily Briefing ${meta.previousEdition}`);
  else if (meta.edition) lines.push('', 'Previous edition: none');
  lines.push('', text, '');
  return lines.join('\n');
}

function listStoredBriefings() {
  if (!fs.existsSync(STORE_DIR)) return [];
  return fs.readdirSync(STORE_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{3}$/.test(entry.name))
    .map(entry => readJson(path.join(STORE_DIR, entry.name, 'manifest.json'), null))
    .filter(Boolean)
    .sort((a, b) => String(b.edition).localeCompare(String(a.edition)));
}

function getStoredBriefing(edition) {
  const manifest = readJson(path.join(storedDir(edition), 'manifest.json'), null);
  if (!manifest) throw new Error(`Stored briefing ${edition} not found`);
  return manifest;
}

function previousEditionContext(meta) {
  if (!meta.previousEdition) return '';
  try {
    const prior = getStoredBriefing(meta.previousEdition);
    const markdown = fs.readFileSync(prior.mdPath, 'utf8').slice(0, 12000);
    return `Previous edition context for continuity (Daily Briefing ${meta.previousEdition}; use for cross-reference, do not repeat unchanged material):\n\n${markdown}\n\n`;
  } catch (_) {
    return `Previous edition context: Daily Briefing ${meta.previousEdition} is expected but no stored copy was found.\n`;
  }
}

function writeBriefingIndex() {
  const list = listStoredBriefings().sort((a, b) => String(a.edition).localeCompare(String(b.edition)));
  const lines = [
    '# Nakai Daily Briefing Archive',
    '',
    'Private operational archive. Use the Hub admin page to resend a stored briefing to Nakai.',
    '',
    ...list.map(item => `- Daily Briefing ${item.edition} - ${item.label} - ${item.sentAt ? `sent ${item.sentAt}` : 'not sent'}`),
    '',
  ];
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STORE_DIR, 'index.md'), lines.join('\n'), 'utf8');
}

function markSent(edition, to) {
  const manifest = getStoredBriefing(edition);
  const updated = { ...manifest, sentAt: new Date().toISOString(), to };
  writeJson(path.join(storedDir(edition), 'manifest.json'), updated);
  writeBriefingIndex();
  return updated;
}

function emailHtml(manifest) {
  const html = fs.readFileSync(manifest.htmlPath, 'utf8');
  const link = resendUrl(manifest.edition);
  const footer = `
<div style="font:13px system-ui,-apple-system,Segoe UI,sans-serif;color:#666;margin:32px 0 0;padding-top:16px;border-top:1px solid #ddd;">
  Daily Briefing ${manifest.edition} · stored private copy.
  <a href="${link}" style="color:#5b4ac4;">Click here to send this briefing to Nakai again</a>.
</div>`;
  return html.includes('</body>') ? html.replace('</body>', `${footer}</body>`) : `${html}${footer}`;
}

async function sendStoredBriefing(edition, { force = false } = {}) {
  loadDotEnv();
  const manifest = getStoredBriefing(edition);
  if (manifest.sentAt && !force) return { ok: true, skipped: true, manifest };
  const to = nakaiEmail();
  if (!to) throw new Error('No Nakai email configured. Set NAKAI_GOOGLE_EMAIL or NAKAI_GOOGLE_EMAILS.');
  const { sendEmail } = require('../lib/agentmail');
  const pdf = fs.readFileSync(manifest.pdfPath);
  const markdown = fs.readFileSync(manifest.mdPath, 'utf8');
  const subject = `${manifest.title} - ${manifest.label}`;
  await sendEmail({
    to,
    subject,
    text: `${markdown}\n\n---\nStored copy: Daily Briefing ${manifest.edition}\nResend: ${resendUrl(manifest.edition)}`,
    html: emailHtml(manifest),
    attachments: [{
      filename: `Daily Briefing ${manifest.edition}.pdf`,
      content_type: 'application/pdf',
      content: pdf.toString('base64'),
    }],
  });
  return { ok: true, skipped: false, manifest: markSent(edition, to) };
}

async function buildNakaiDailyBriefing({ date = new Date() } = {}) {
  const meta = briefingMeta(date);
  const markdown = await generateMarkdown(meta);
  const result = await renderPdf(markdown, meta);
  try {
    result.knowledgePath = captureNakaiDailyBriefing({
      markdown: fs.readFileSync(result.mdPath, 'utf8'),
      dateSlug: meta.iso,
      edition: meta.edition,
      htmlPath: result.htmlPath,
      pdfPath: result.pdfPath,
    });
  } catch (err) {
    console.warn(`[nakai-briefing] knowledge capture failed: ${err.message}`);
  }
  result.meta = meta;
  result.archive = archiveBriefing(result, meta);
  return result;
}

async function sendTodayNakaiDailyBriefing({ force = false, date = new Date() } = {}) {
  const meta = briefingMeta(date);
  if (!meta.edition) {
    console.log(`[nakai-briefing] schedule not active before ${START_DATE} (${meta.iso})`);
    return { ok: true, skipped: true, reason: 'before-start-date', meta };
  }
  const existing = listStoredBriefings().find(item => item.edition === meta.edition);
  const manifest = existing || (await buildNakaiDailyBriefing({ date })).archive;
  if (!manifest) throw new Error(`Could not build Daily Briefing ${meta.edition}`);
  return sendStoredBriefing(meta.edition, { force });
}

async function main() {
  const result = await buildNakaiDailyBriefing();
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  START_DATE,
  briefingMeta,
  buildNakaiDailyBriefing,
  sendTodayNakaiDailyBriefing,
  sendStoredBriefing,
  listStoredBriefings,
  getStoredBriefing,
  resendUrl,
};
