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
  ['Montana Division of Banking and Financial Institutions', 'https://doa.mt.gov/bfid/'],
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
  ['Oregon Division of Financial Regulation', 'https://dfr.oregon.gov/news/Pages/index.aspx'],
  ['Pennsylvania Department of Banking and Securities', 'https://www.pa.gov/agencies/dobs'],
  ['Rhode Island Department of Business Regulation', 'https://dbr.ri.gov/'],
  ['South Carolina State Board of Financial Institutions', 'https://banking.sc.gov/'],
  ['South Dakota Division of Banking', 'https://dlr.sd.gov/banking/default.aspx'],
  ['Tennessee Department of Financial Institutions', 'https://www.tn.gov/tdfi/news.html'],
  ['Texas Department of Banking', 'https://www.dob.texas.gov'],
  ['Utah Department of Financial Institutions', 'https://dfi.utah.gov/'],
  ['Vermont Department of Financial Regulation', 'https://dfr.vermont.gov/'],
  ['Virginia Bureau of Financial Institutions', 'https://www.scc.virginia.gov/regulated-industries/bureau-of-financial-institutions/'],
  ['Washington State Department of Financial Institutions', 'https://dfi.wa.gov/'],
  ['West Virginia Division of Financial Institutions', 'https://dfi.wv.gov/Pages/default.aspx'],
  ['Wisconsin Department of Financial Institutions', 'https://dfi.wi.gov/Pages/About/NewsEvents/NewsReleases.aspx'],
  ['Wyoming Division of Banking', 'https://wyomingbankingdivision.wyo.gov/'],
  ['Puerto Rico Office of the Commissioner of Financial Institutions', 'https://www.ocif.pr.gov/en'],
  ['Guam Department of Revenue and Taxation', 'https://www.guamtax.com/about/regulatory.html'],
  ['US Virgin Islands Division of Banking, Insurance and Financial Regulation', 'https://ltg.gov.vi/departments/banking-insurance-and-financial-regulation/'],
  ['Northern Mariana Islands Department of Commerce', 'https://commerce.gov.mp/'],
].map(([name, url]) => ({ name, url }));

// State Attorney General newsroom URLs supplied by Douglas. These are direct
// public news/press pages, so they flow through the same daily page scraper as
// every other regulatory monitor site. Google wrapper links are deliberately
// excluded; only the canonical authority URLs are retained.
const US_STATE_AG_NEWSROOMS = [
  ['Alabama Attorney General', 'https://www.alabamaag.gov/category/press-release/'],
  ['Alaska Department of Law', 'https://law.alaska.gov/department/news/news.html'],
  ['Arizona Attorney General', 'https://www.azag.gov/press-releases'],
  ['Arkansas Attorney General', 'https://arkansasag.gov/news-alerts/news-releases/'],
  ['California Department of Justice', 'https://oag.ca.gov/media/news'],
  ['Colorado Attorney General', 'https://coag.gov/press-releases/'],
  ['Connecticut Attorney General', 'https://portal.ct.gov/AG/Press-Releases'],
  ['Delaware Department of Justice', 'https://news.delaware.gov/category/justice/prs/'],
  ['Florida Attorney General', 'https://www.myfloridalegal.com/newsreleases'],
  ['Georgia Department of Law', 'https://law.georgia.gov/press-releases'],
  ['Hawaii Department of the Attorney General', 'https://ag.hawaii.gov/news-releases/'],
  ['Idaho Attorney General', 'https://ag.idaho.gov/newsroom/'],
  ['Illinois Attorney General', 'https://illinoisattorneygeneral.gov/news-room/'],
  ['Indiana Attorney General', 'https://www.in.gov/attorneygeneral/newsroom/'],
  ['Iowa Attorney General', 'https://www.iowaattorneygeneral.gov/newsroom'],
  ['Kansas Attorney General', 'https://ag.ks.gov/media-center'],
  ['Kentucky Attorney General', 'https://www.ag.ky.gov/Press-Releases'],
  ['Louisiana Attorney General', 'https://www.ag.state.la.us/News/Page/1'],
  ['Maine Attorney General', 'https://www.maine.gov/ag/news/'],
  ['Maryland Attorney General', 'https://www.marylandattorneygeneral.gov/Pages/news.aspx'],
  ['Massachusetts Attorney General', 'https://www.mass.gov/orgs/office-of-the-attorney-general/news?page=1'],
  ['Michigan Attorney General', 'https://www.michigan.gov/ag/news/press-releases'],
  ['Minnesota Attorney General', 'https://www.ag.state.mn.us/Office/Communications/'],
  ['Mississippi Attorney General', 'https://ago.state.ms.us/news/'],
  ['Missouri Attorney General', 'https://ago.mo.gov/category/press-release/'],
  ['Montana Department of Justice', 'https://dojmt.gov/news/'],
  ['Nebraska Attorney General', 'https://ago.nebraska.gov/news'],
  ['Nevada Attorney General', 'https://ag.nv.gov/News/Press_Releases/'],
  ['New Hampshire Department of Justice', 'https://www.doj.nh.gov/news/'],
  ['New Jersey Attorney General', 'https://www.njoag.gov/newsroom/'],
  ['New Mexico Department of Justice', 'https://www.nmag.gov/newsroom/'],
  ['New York Attorney General', 'https://ag.ny.gov/press-releases'],
  ['North Carolina Department of Justice', 'https://ncdoj.gov/newsroom/'],
  ['North Dakota Attorney General', 'https://attorneygeneral.nd.gov/news/'],
  ['Ohio Attorney General', 'https://www.ohioattorneygeneral.gov/Media/News-Releases'],
  ['Oklahoma Attorney General', 'https://www.oag.ok.gov/articles'],
  ['Oregon Department of Justice', 'https://www.doj.state.or.us/media/'],
  ['Pennsylvania Attorney General', 'https://www.attorneygeneral.gov/taking-action/press-releases/'],
  ['Rhode Island Attorney General', 'https://riag.ri.gov/press-releases'],
  ['South Carolina Attorney General', 'https://www.scag.gov/about-the-office/news/'],
  ['South Dakota Attorney General', 'https://atg.sd.gov/OurOffice/Media/default.aspx'],
  ['Tennessee Attorney General', 'https://www.tn.gov/attorneygeneral/news.html'],
  ['Texas Attorney General', 'https://www.texasattorneygeneral.gov/news'],
  ['Utah Attorney General', 'https://attorneygeneral.utah.gov/news/'],
  ['Vermont Attorney General', 'https://ago.vermont.gov/blog/category/press-releases'],
  ['Virginia Attorney General', 'https://www.oag.state.va.us/media-center/news-releases'],
  ['Washington Attorney General', 'https://www.atg.wa.gov/news/news-releases'],
  ['District of Columbia Attorney General', 'https://oag.dc.gov/newsroom'],
  ['West Virginia Attorney General', 'https://ago.wv.gov/news'],
  ['Wisconsin Department of Justice', 'https://www.doj.state.wi.us/news-releases'],
  ['Wyoming Attorney General', 'https://ag.wyo.gov/home'],
].map(([name, url]) => ({ name, url }));

const NAAG_NEWSROOM = {
  name: 'National Association of Attorneys General',
  url: 'https://www.naag.org/news-resources/newsroom/',
};

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
  US_STATE_AG_NEWSROOMS,
  NAAG_NEWSROOM,
  PRODUCT_REGULATORY_QUERIES,
  regulatorForUrl,
  sourceIsFresh,
  officialDiscoverySources,
};
