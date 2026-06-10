const VERIFIED_DOUGLAS_EMPLOYMENT = Object.freeze([
  {
    id: 'douglas-beacon-m365-administrator-2026',
    company: 'Beacon Hospital',
    role: 'M365 Administrator',
    start_date: 'Mar 2026',
    end_date: null,
    description: 'Supporting the hospital\'s transition to Microsoft 365, with a focus on secure administration, user support, and the practical rollout of SharePoint, Teams, OneDrive and Entra ID.',
    display_order: 10,
  },
  {
    id: 'douglas-cricket-ireland-it-manager-2024',
    company: 'Cricket Ireland',
    role: 'IT Manager',
    start_date: 'Apr 2024',
    end_date: 'Mar 2026',
    description: 'Led a co-managed IT operating model with an MSP across endpoints, identity, collaboration and connectivity. Modernised Microsoft 365 tenant governance, delivered DMARC enforcement and tighter enterprise app permissions, built Power Apps and Power Automate solutions, and supported event-critical technology including live scoring and broadcast connectivity.',
    display_order: 20,
  },
  {
    id: 'douglas-cricket-ireland-systems-administrator-2023',
    company: 'Cricket Ireland',
    role: 'IT Systems Administrator',
    start_date: 'May 2023',
    end_date: 'May 2024',
    description: 'Supported co-managed IT operations across end-user devices, identity, file services and collaboration tools. Planned and delivered migration of priority workloads from AWS to Microsoft 365.',
    display_order: 30,
  },
  {
    id: 'douglas-liffey-partnership-ict-manager-2020',
    company: 'Liffey Partnership',
    role: 'ICT Manager / Community Development Co-ordinator',
    start_date: 'Mar 2020',
    end_date: 'Apr 2023',
    description: 'Led ICT operations across five Dublin sites. Drove the organisation-wide move to SharePoint and OneDrive, retiring on-premises Windows Server 2012. Implemented a VoIP/softphone solution and enabled secure remote working at the onset of COVID-19.',
    display_order: 40,
  },
  {
    id: 'douglas-liffey-partnership-community-development-2017',
    company: 'Liffey Partnership',
    role: 'Community Development Co-ordinator',
    start_date: 'Mar 2017',
    end_date: 'Mar 2020',
    description: 'Led a community development team delivering multi-stream programmes spanning social inclusion, health promotion and restorative practice.',
    display_order: 50,
  },
  {
    id: 'douglas-inclusion-scotland-project-officer-2015',
    company: 'Inclusion Scotland',
    role: 'Project Officer — Routes to Inclusion',
    start_date: 'Oct 2015',
    end_date: 'Oct 2016',
    description: 'Researched the impact of health and social care integration on disabled people, and evaluated the accessibility implications of new technologies (Scottish Government-funded).',
    display_order: 60,
  },
  {
    id: 'douglas-humanist-society-scotland-senior-manager-2013',
    company: 'Humanist Society Scotland',
    role: 'Senior Manager',
    start_date: '2013',
    end_date: '2015',
    description: 'Brought structure and operational maturity to a growing organisation, replacing Excel-based membership with CiviCRM and implementing Google Workspace for a distributed team.',
    display_order: 70,
  },
  {
    id: 'douglas-icas-foundation-head-2012',
    company: 'ICAS',
    role: 'Head / Trust Secretary — ICAS Foundation',
    start_date: 'Aug 2012',
    end_date: 'Dec 2013',
    description: 'Established the ICAS Foundation from inception, building partnerships with Scottish universities, schools and professional bodies to support progression to higher education.',
    display_order: 80,
  },
  {
    id: 'douglas-age-scotland-community-development-2002',
    company: 'Age Scotland',
    role: 'Community Development Officer',
    start_date: 'Nov 2002',
    end_date: 'Aug 2012',
    description: 'Supported service development across local member groups in East Central Scotland. Contributed to an organisation-wide Raiser\'s Edge CRM implementation.',
    display_order: 90,
  },
  {
    id: 'douglas-bank-of-scotland-corporate-banking-analyst-1999',
    company: 'Bank of Scotland',
    role: 'Corporate Banking Analyst',
    start_date: 'Feb 1999',
    end_date: 'Oct 2003',
    description: 'Business Continuity team: assessing staffing and ICT requirements for mission-critical operations during disruptions, and supporting operational testing of reserve locations.',
    display_order: 100,
  },
].map(Object.freeze));

const DOUGLAS_EMPLOYMENT_TRIGGER_NAMES = [
  'protect_douglas_employment_insert',
  'protect_douglas_employment_delete',
  'protect_douglas_employment_identity',
];

function dropDouglasEmploymentTriggers(db) {
  for (const name of DOUGLAS_EMPLOYMENT_TRIGGER_NAMES) {
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }
}

function installDouglasEmploymentTriggers(db) {
  db.exec(`
    CREATE TRIGGER protect_douglas_employment_insert
    BEFORE INSERT ON experiences
    BEGIN
      SELECT RAISE(ABORT, 'Douglas verified employment rows cannot be added outside the code-reviewed ledger');
    END;

    CREATE TRIGGER protect_douglas_employment_delete
    BEFORE DELETE ON experiences
    BEGIN
      SELECT RAISE(ABORT, 'Douglas verified employment rows cannot be deleted');
    END;

    CREATE TRIGGER protect_douglas_employment_identity
    BEFORE UPDATE OF id, company, role, start_date, end_date ON experiences
    WHEN NEW.id IS NOT OLD.id
      OR NEW.company IS NOT OLD.company
      OR NEW.role IS NOT OLD.role
      OR NEW.start_date IS NOT OLD.start_date
      OR NEW.end_date IS NOT OLD.end_date
    BEGIN
      SELECT RAISE(ABORT, 'Douglas company, title and employment dates are immutable');
    END;
  `);
}

function syncDouglasVerifiedEmployment(db) {
  const sync = db.transaction(() => {
    dropDouglasEmploymentTriggers(db);

    const findById = db.prepare('SELECT * FROM experiences WHERE id = ?');
    const findExact = db.prepare(`
      SELECT * FROM experiences
       WHERE company = ? AND role = ? AND start_date IS ? AND end_date IS ?
       LIMIT 1
    `);
    const insert = db.prepare(`
      INSERT INTO experiences
        (id, company, role, start_date, end_date, description, is_cv_context, display_order)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `);
    const adopt = db.prepare('UPDATE experiences SET id = ? WHERE id = ?');
    const enforceIdentity = db.prepare(`
      UPDATE experiences
         SET company = ?, role = ?, start_date = ?, end_date = ?
       WHERE id = ?
    `);

    for (const item of VERIFIED_DOUGLAS_EMPLOYMENT) {
      let row = findById.get(item.id);
      if (!row) {
        row = findExact.get(item.company, item.role, item.start_date, item.end_date);
        if (row) {
          adopt.run(item.id, row.id);
        } else {
          insert.run(
            item.id,
            item.company,
            item.role,
            item.start_date,
            item.end_date,
            item.description,
            item.display_order
          );
        }
      }
      enforceIdentity.run(item.company, item.role, item.start_date, item.end_date, item.id);
    }

    const ids = VERIFIED_DOUGLAS_EMPLOYMENT.map(item => item.id);
    const placeholders = ids.map(() => '?').join(', ');
    db.prepare(`DELETE FROM experiences WHERE id NOT IN (${placeholders})`).run(...ids);

    installDouglasEmploymentTriggers(db);
  });

  sync();
}

module.exports = {
  VERIFIED_DOUGLAS_EMPLOYMENT,
  syncDouglasVerifiedEmployment,
};
