/* Idempotent CV seed. Run: node scripts/seed-cv.js
   Populates cv_context, experiences, skills for both portfolios. */

const Database = require('better-sqlite3');
const path = require('path');
const { uuid } = require('../lib/id');
const { getAiAssistedBuildsText } = require('../lib/aiBuilds');

const DATA_DIR = path.join(__dirname, '..', 'data');

const CV = {
  nakai: {
    cv: {
      role_label: 'Head of Internal Audit',
      hero_title: 'Head of Internal Audit & Regional Lead.',
      credentials: 'FCCA CIA CAMS MSc',
      tagline: 'Senior executive specialising in audit, risk management, and regulatory compliance within high-growth financial technology and investment services.',
      summary: 'Head of Internal Audit-level leader with over 10 years of experience shaping and leading independent audit functions within complex, multi-jurisdictional regulated financial services, including Electronic Money Institutions and Fund Administration. Currently lead the European Internal Audit agenda for Block\'s European regulated entities, holding a Controlled Function (CF2) status under the CBI\'s Fitness & Probity Standards.',
      companies: 'Block, Maples Group, Western Union',
      vision_title: 'The Vision of Audit',
      vision_body1: 'With over a decade of leadership in regulated financial services, I operate as a pragmatic, forward-looking business partner and change agent. My approach transcends traditional compliance; it is about building resilient frameworks that enable innovation.',
      vision_body2: 'Having spearheaded audit functions at global leaders like Block and Maples Group, I specialise in navigating the intricate intersections of traditional finance and the digital asset frontier, across CBI, FCA, CSSF, DNB, JFSA, CIMA, BVI and DFSA jurisdictions.',
      essay_title: 'Governance in the Age of Agility',
      essay_body: 'I believe that effective audit isn\'t about finding what\'s wrong, but about verifying what\'s right — providing the confidence for businesses to take calculated risks and scale with velocity.',
      stat1_num: '10+',
      stat1_label: 'Years experience',
      stat2_num: '8',
      stat2_label: 'Regulatory jurisdictions',
      portrait_url: '/img/nakai.jpg',
      education: 'MSc Accounting & Finance, Napier University Edinburgh · Post Graduate Diploma Economics & Finance, University of Edinburgh · BA (Hons) Business Economics, University of Reading',
      linkedin_url: 'https://www.linkedin.com/in/nakaimclellan',
    },
    experiences: [
      {
        company: 'Block',
        role: 'Internal Audit Lead — International',
        start_date: 'Aug 2025',
        end_date: null,
        description: 'Driving the European audit strategy with a focus on regulatory engagement and board-level governance as a CF2-designated executive under the CBI\'s Fitness & Probity regime. Leading risk-based audits across AML, Privacy, and Information Security while shaping control frameworks aligned with EU regulatory expectations.',
        order: 10,
      },
      {
        company: 'Maples Group',
        role: 'Senior Vice President, Internal Audit',
        start_date: 'Nov 2021',
        end_date: 'Aug 2025',
        description: 'Led a multi-jurisdictional Internal Audit team delivering independent, risk-based assurance across highly regulated financial services operations in Ireland, Luxembourg, Netherlands, BVI, Dubai, Jersey, the UK and Cayman Islands. Served as Acting Head of Internal Audit during leadership transitions.',
        order: 20,
      },
      {
        company: 'Maples Group',
        role: 'Vice President, Internal Audit',
        start_date: 'Feb 2019',
        end_date: 'Nov 2021',
        description: 'Managed the global, risk-based audit plan execution across international locations, focusing on high-risk operational and compliance areas. Led complex, end-to-end audits into financial crime, regulatory reporting, and operational failures.',
        order: 30,
      },
      {
        company: 'Western Union',
        role: 'Senior Internal Auditor',
        start_date: 'Oct 2017',
        end_date: 'Feb 2019',
        description: 'Executed end-to-end audits across high-risk areas including AML/financial crime, sanctions, regulatory reporting, finance systems, customer operations and emerging technologies within a complex, global, regulated payments environment.',
        order: 40,
      },
    ],
    skills: [
      { name: 'Internal Audit Strategy', level: 'strong', order: 10 },
      { name: 'Regulatory Engagement', level: 'strong', order: 20 },
      { name: 'Board & Audit Committee Advisory', level: 'strong', order: 30 },
      { name: 'Governance & Risk-based Audit', level: 'strong', order: 40 },
      { name: 'Financial Crime / AML', level: 'strong', order: 50 },
      { name: 'Data Analytics (Tableau, Alteryx)', level: 'moderate', order: 60 },
      { name: 'AI Governance', level: 'moderate', order: 70 },
      { name: 'Fund Administration', level: 'moderate', order: 80 },
      { name: 'M&A Due Diligence', level: 'gap', order: 90 },
      { name: 'Product Management', level: 'gap', order: 100 },
    ],
  },

  douglas: {
    cv: {
      role_label: 'IT Manager — Microsoft 365, Identity & Security',
      hero_title: 'Microsoft 365, Identity & Security.',
      credentials: 'M365 · ENTRA ID · POWER PLATFORM',
      tagline: 'IT Manager turning complex, fast-moving requirements into secure, reliable, and user-friendly technology — on and off the field. I operate at the intersection of security, usability, and delivery.',
      summary: 'IT Manager with a track record of modernising Microsoft 365 environments, raising cybersecurity maturity, and ensuring technology actually works for the people using it. Recent work includes DMARC enforcement, identity and collaboration modernisation for staff and players, analytics and automation that reduce friction, and live scoring and broadcast connectivity for high-profile events.',
      companies: 'Beacon Hospital, Cricket Ireland, Liffey Partnership',
      vision_title: 'Technology that Actually Works',
      vision_body1: 'I lead a co-managed IT operating model: owning strategy, standards, risk and escalation across endpoints, identity, collaboration, and connectivity — while partnering with an MSP on delivery.',
      vision_body2: 'From Microsoft 365 governance and Power Platform automation through to event-critical infrastructure for broadcast and live scoring, my focus is durable outcomes — documented, secure, and usable by the people the technology serves.',
      essay_title: 'Security, Usability, Delivery',
      essay_body: 'The best technology is the technology you don\'t notice. My work is about making things secure and reliable enough that teams can forget they\'re there — and get on with their jobs.',
      stat1_num: '20+',
      stat1_label: 'Years IT & ops',
      stat2_num: '5',
      stat2_label: 'Sites migrated to M365',
      portrait_url: '/img/douglas.png',
      education: 'Bachelor\'s Degree (Open), The Open University · Inverkeithing High School',
      linkedin_url: 'https://www.linkedin.com/in/douglasmclellan',
      ai_assisted_app_builds: getAiAssistedBuildsText(),
    },
    experiences: [
      {
        company: 'Beacon Hospital',
        role: 'M365 Administrator',
        start_date: 'Mar 2026',
        end_date: null,
        description: 'Supporting the hospital\'s transition to Microsoft 365, with a focus on secure administration, user support, and the practical rollout of SharePoint, Teams, OneDrive and Entra ID.',
        order: 10,
      },
      {
        company: 'Cricket Ireland',
        role: 'IT Manager',
        start_date: 'Apr 2024',
        end_date: 'Mar 2026',
        description: 'Led a co-managed IT operating model with an MSP across endpoints, identity, collaboration and connectivity. Modernised Microsoft 365 tenant governance, delivered DMARC enforcement and tighter enterprise app permissions, built Power Apps and Power Automate solutions, and supported event-critical technology including live scoring and broadcast connectivity.',
        order: 20,
      },
      {
        company: 'Cricket Ireland',
        role: 'IT Systems Administrator',
        start_date: 'May 2023',
        end_date: 'May 2024',
        description: 'Supported co-managed IT operations across end-user devices, identity, file services and collaboration tools. Planned and delivered migration of priority workloads from AWS to Microsoft 365.',
        order: 30,
      },
      {
        company: 'Liffey Partnership',
        role: 'ICT Manager / Community Development Co-ordinator',
        start_date: 'Mar 2020',
        end_date: 'Apr 2023',
        description: 'Led ICT operations across five Dublin sites. Drove the org-wide move to SharePoint and OneDrive, retiring on-prem Windows Server 2012. Implemented a VoIP/softphone solution and enabled secure remote working at the onset of COVID-19.',
        order: 40,
      },
      {
        company: 'Liffey Partnership',
        role: 'Community Development Co-ordinator',
        start_date: 'Mar 2017',
        end_date: 'Mar 2020',
        description: 'Led a community development team delivering multi-stream programmes spanning social inclusion, health promotion and restorative practice.',
        order: 50,
      },
      {
        company: 'Inclusion Scotland',
        role: 'Project Officer — Routes to Inclusion',
        start_date: 'Oct 2015',
        end_date: 'Oct 2016',
        description: 'Researched the impact of health and social care integration on disabled people, and evaluated the accessibility implications of new technologies (Scottish Government-funded).',
        order: 60,
      },
      {
        company: 'Humanist Society Scotland',
        role: 'Senior Manager',
        start_date: '2013',
        end_date: '2015',
        description: 'Brought structure and operational maturity to a growing organisation — replacing Excel-based membership with CiviCRM and implementing Google Workspace for a distributed team.',
        order: 70,
      },
      {
        company: 'ICAS',
        role: 'Head / Trust Secretary — ICAS Foundation',
        start_date: 'Aug 2012',
        end_date: 'Dec 2013',
        description: 'Established the ICAS Foundation from inception, building partnerships with Scottish universities, schools and professional bodies to support progression to higher education.',
        order: 80,
      },
      {
        company: 'Age Scotland',
        role: 'Community Development Officer',
        start_date: 'Nov 2002',
        end_date: 'Aug 2012',
        description: 'Supported service development across local member groups in East Central Scotland. Contributed to an organisation-wide Raiser\'s Edge CRM implementation.',
        order: 90,
      },
      {
        company: 'Bank of Scotland',
        role: 'Corporate Banking Analyst',
        start_date: 'Feb 1999',
        end_date: 'Oct 2003',
        description: 'Business Continuity team: assessing staffing and ICT requirements for mission-critical operations during disruptions, and supporting operational testing of reserve locations.',
        order: 100,
      },
    ],
    skills: [
      { name: 'Microsoft 365 Administration', level: 'strong', order: 10 },
      { name: 'Identity & Access (Entra ID)', level: 'strong', order: 20 },
      { name: 'SharePoint & Teams', level: 'strong', order: 30 },
      { name: 'Power Platform (Apps / Automate)', level: 'strong', order: 40 },
      { name: 'Email Security & DMARC', level: 'strong', order: 50 },
      { name: 'Power BI / DOMO', level: 'moderate', order: 60 },
      { name: 'VoIP & Unified Comms', level: 'moderate', order: 70 },
      { name: 'Vendor & MSP Management', level: 'moderate', order: 80 },
      { name: 'Cloud Architecture (AWS)', level: 'gap', order: 90 },
      { name: 'Kubernetes', level: 'gap', order: 100 },
    ],
  },
};

function seed(userKey) {
  const db = new Database(path.join(DATA_DIR, `${userKey}.db`));
  const data = CV[userKey];

  // Dedupe any existing rows on section before adding the unique index
  db.exec(`
    DELETE FROM cv_context WHERE id NOT IN (
      SELECT MIN(id) FROM cv_context GROUP BY section
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cv_section ON cv_context(section);
  `);

  const upsertCv = db.prepare(`
    INSERT INTO cv_context (id, section, content) VALUES (?, ?, ?)
    ON CONFLICT(section) DO UPDATE SET content = excluded.content, updated_at = unixepoch()
  `);

  for (const [section, content] of Object.entries(data.cv)) {
    if (content == null) continue;
    upsertCv.run(uuid(), section, String(content));
  }

  // Replace experiences
  db.prepare('DELETE FROM experiences').run();
  const insExp = db.prepare(
    'INSERT INTO experiences (id, company, role, start_date, end_date, description, is_cv_context, display_order) VALUES (?, ?, ?, ?, ?, ?, 1, ?)'
  );
  for (const e of data.experiences) {
    insExp.run(uuid(), e.company, e.role, e.start_date, e.end_date, e.description, e.order);
  }

  // Replace skills
  db.prepare('DELETE FROM skills').run();
  const insSkill = db.prepare(
    'INSERT INTO skills (id, name, level, category, display_order) VALUES (?, ?, ?, NULL, ?)'
  );
  for (const s of data.skills) {
    insSkill.run(uuid(), s.name, s.level, s.order);
  }

  db.close();
  console.log(`✓ Seeded ${userKey}: ${data.experiences.length} roles, ${data.skills.length} skills, ${Object.keys(data.cv).length} cv fields`);
}

seed('nakai');
seed('douglas');
console.log('Done.');
