'use strict';

// State banking/financial regulators, sourced from the Conference of State
// Bank Supervisors directory: https://www.csbs.org/contact-your-state-bank-agency
// These are authority boundaries for discovery, not a deterministic relevance
// list: the regulatory-monitor LLM still decides whether a discovered item is
// relevant to Block and Nakai's briefing.
const US_STATE_FINANCIAL_REGULATORS = [
  ['Alabama State Banking Department', 'https://banking.alabama.gov'],
  ['Alaska Division of Banking and Securities', 'https://www.commerce.alaska.gov/web/dbs'],
  ['Arizona Department of Insurance and Financial Institutions', 'https://difi.az.gov/'],
  ['Arkansas State Bank Department', 'https://banking.arkansas.gov/'],
  ['California Department of Financial Protection and Innovation', 'https://dfpi.ca.gov/'],
  ['Colorado Division of Banking', 'https://banking.colorado.gov/'],
  ['Connecticut Department of Banking', 'https://portal.ct.gov/dob'],
  ['Delaware Office of the State Bank Commissioner', 'https://banking.delaware.gov'],
  ['District of Columbia DISB', 'https://disb.dc.gov/'],
  ['Florida Office of Financial Regulation', 'https://www.flofr.gov/'],
  ['Georgia Department of Banking and Finance', 'https://dbf.georgia.gov/'],
  ['Hawaii Division of Financial Institutions', 'https://cca.hawaii.gov/dfi/'],
  ['Idaho Department of Finance', 'https://www.finance.idaho.gov/'],
  ['Illinois Department of Financial and Professional Regulation', 'https://idfpr.illinois.gov/'],
  ['Indiana Department of Financial Institutions', 'https://www.in.gov/dfi/'],
  ['Iowa Division of Banking', 'https://idob.iowa.gov'],
  ['Kansas Office of the State Bank Commissioner', 'https://www.osbckansas.gov'],
  ['Kentucky Department of Financial Institutions', 'https://kfi.ky.gov/'],
  ['Louisiana Office of Financial Institutions', 'https://ofi.la.gov/'],
  ['Maine Bureau of Financial Institutions', 'https://www.maine.gov/pfr/financialinstitutions/'],
  ['Maryland Office of Financial Regulation', 'https://www.dllr.state.md.us/finance'],
  ['Massachusetts Division of Banks', 'https://www.mass.gov/orgs/division-of-banks'],
  ['Michigan Department of Insurance and Financial Services', 'https://www.michigan.gov/difs/industry/banking'],
  ['Minnesota Department of Commerce', 'https://mn.gov/commerce/'],
  ['Mississippi Department of Banking and Consumer Finance', 'https://dbcf.ms.gov/'],
  ['Missouri Division of Finance', 'https://finance.mo.gov/'],
  ['Montana Division of Banking and Financial Institutions', 'https://www.banking.mt.gov'],
  ['Nebraska Department of Banking and Finance', 'https://ndbf.nebraska.gov/'],
  ['Nevada Financial Institutions Division', 'https://fid.nv.gov/'],
  ['New Hampshire Banking Department', 'https://www.banking.nh.gov/'],
  ['New Jersey Department of Banking and Insurance', 'https://www.nj.gov/dobi/index.html'],
  ['New Mexico Financial Institutions Division', 'https://www.rld.nm.gov/financial-institutions/'],
  ['New York State Department of Financial Services', 'https://www.dfs.ny.gov/'],
  ['North Carolina Commissioner of Banks', 'https://nccob.nc.gov/'],
  ['North Dakota Department of Financial Institutions', 'https://www.nd.gov/dfi/'],
  ['Ohio Division of Financial Institutions', 'https://com.ohio.gov/divisions-and-programs/financial-institutions/'],
  ['Oklahoma Banking Department', 'https://banking.ok.gov'],
  ['Oregon Division of Financial Regulation', 'https://dfr.oregon.gov/Pages/index.aspx'],
  ['Pennsylvania Department of Banking and Securities', 'https://www.pa.gov/agencies/dobs'],
  ['Rhode Island Department of Business Regulation', 'https://dbr.ri.gov/'],
  ['South Carolina State Board of Financial Institutions', 'https://banking.sc.gov/'],
  ['South Dakota Division of Banking', 'https://dlr.sd.gov/banking/default.aspx'],
  ['Tennessee Department of Financial Institutions', 'https://www.tn.gov/tdfi'],
  ['Texas Department of Banking', 'https://www.dob.texas.gov'],
  ['Utah Department of Financial Institutions', 'https://dfi.utah.gov/'],
  ['Vermont Department of Financial Regulation', 'https://dfr.vermont.gov/'],
  ['Virginia Bureau of Financial Institutions', 'https://www.scc.virginia.gov/regulated-industries/bureau-of-financial-institutions/'],
  ['Washington State Department of Financial Institutions', 'https://dfi.wa.gov/'],
  ['West Virginia Division of Financial Institutions', 'https://www.dfi.wv.gov'],
  ['Wisconsin Department of Financial Institutions', 'https://dfi.wi.gov/Pages/Home.aspx'],
  ['Wyoming Division of Banking', 'https://wyomingbankingdivision.wyo.gov/'],
  ['Puerto Rico Office of the Commissioner of Financial Institutions', 'https://ocif.pr.gov/'],
  ['Guam Department of Revenue and Taxation', 'https://www.guamtax.com/about/regulatory.html'],
  ['US Virgin Islands Division of Banking, Insurance and Financial Regulation', 'https://ltg.gov.vi/departments/banking-insurance-and-financial-regulation/'],
  ['Northern Mariana Islands Department of Commerce', 'https://commerce.gov.mp/'],
].map(([name, url]) => ({ name, url }));

const PRODUCT_REGULATORY_QUERIES = [
  'official US regulator attorney general enforcement settlement investigation Block Inc Cash App',
  'official US regulator enforcement settlement investigation Square Afterpay Clearpay',
  'official US regulator government action Bitkey Proto TIDAL Block Inc',
];

function hostname(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function regulatorForUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const host = hostname(url);
  if (!host) return null;
  const matched = US_STATE_FINANCIAL_REGULATORS.find(source => {
    const sourceUrl = new URL(source.url);
    const sourceHost = hostname(source.url);
    const hostMatches = host === sourceHost || host.endsWith(`.${sourceHost}`) || sourceHost.endsWith(`.${host}`);
    if (!hostMatches) return false;
    const sourcePath = sourceUrl.pathname.replace(/\/+$/, '');
    return !sourcePath || sourcePath === '' || parsed.pathname === sourcePath || parsed.pathname.startsWith(`${sourcePath}/`);
  });
  if (matched) return matched.name;
  if (host === 'csbs.org' || host.endsWith('.csbs.org')) return 'Conference of State Bank Supervisors';
  if (host === 'consumerfinance.gov' || host.endsWith('.consumerfinance.gov')) return 'Consumer Financial Protection Bureau';
  if (host === 'ftc.gov' || host.endsWith('.ftc.gov')) return 'Federal Trade Commission';
  if (host === 'justice.gov' || host.endsWith('.justice.gov')) return 'US Department of Justice';
  if (host === 'doj.state.or.us') return 'Oregon Department of Justice';
  // Other federal, state and attorney-general sites remain authoritative even
  // when they are not the prudential regulator listed by CSBS.
  if (host.endsWith('.gov') || host.endsWith('.us')) return `US official source (${host})`;
  return null;
}

function sourceIsFresh(source, { days = 14, now = new Date() } = {}) {
  if (source.publishedAt) {
    const published = new Date(source.publishedAt);
    if (Number.isFinite(published.getTime())) {
      return published.getTime() >= now.getTime() - days * 864e5;
    }
  }
  try {
    const yearInPath = new URL(source.url).pathname.match(/\/(20\d{2})(?:\/|$)/)?.[1];
    if (yearInPath && Number(yearInPath) < now.getUTCFullYear()) return false;
  } catch { return false; }
  return true;
}

function officialDiscoverySources(sources, options) {
  const seen = new Set();
  const official = [];
  for (const source of (sources || [])) {
    const regulator = regulatorForUrl(source.url);
    if (!regulator || !sourceIsFresh(source, options) || seen.has(source.url)) continue;
    seen.add(source.url);
    official.push({ ...source, regulator });
  }
  return official;
}

module.exports = {
  US_STATE_FINANCIAL_REGULATORS,
  PRODUCT_REGULATORY_QUERIES,
  regulatorForUrl,
  sourceIsFresh,
  officialDiscoverySources,
};
