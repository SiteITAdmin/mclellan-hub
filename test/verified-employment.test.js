const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  VERIFIED_DOUGLAS_EMPLOYMENT,
  syncDouglasVerifiedEmployment,
} = require('../lib/verifiedEmployment');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE experiences (
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      description TEXT,
      is_cv_context INTEGER DEFAULT 1,
      display_order INTEGER DEFAULT 0
    );
  `);
  return db;
}

test('sync installs only the verified Douglas employment ledger', () => {
  const db = createDb();
  db.prepare(`
    INSERT INTO experiences
      (id, company, role, start_date, end_date, description, is_cv_context, display_order)
    VALUES ('fake', 'Imaginary Employer', 'Chief Everything Officer', '2025', NULL, 'Fake', 1, 0)
  `).run();

  syncDouglasVerifiedEmployment(db);

  const rows = db.prepare(
    'SELECT id, company, role, start_date, end_date FROM experiences ORDER BY display_order'
  ).all();
  assert.deepEqual(
    rows,
    VERIFIED_DOUGLAS_EMPLOYMENT.map(({ id, company, role, start_date, end_date }) => ({
      id, company, role, start_date, end_date,
    }))
  );
  db.close();
});

test('database rejects additions, deletions, and verified identity changes', () => {
  const db = createDb();
  syncDouglasVerifiedEmployment(db);
  const first = VERIFIED_DOUGLAS_EMPLOYMENT[0];

  assert.throws(
    () => db.prepare(`
      INSERT INTO experiences
        (id, company, role, start_date, end_date, description)
      VALUES ('fake', 'Imaginary Employer', 'Invented Role', '2025', NULL, 'Fake')
    `).run(),
    /cannot be added/
  );
  assert.throws(
    () => db.prepare('DELETE FROM experiences WHERE id = ?').run(first.id),
    /cannot be deleted/
  );
  assert.throws(
    () => db.prepare('UPDATE experiences SET company = ? WHERE id = ?').run('Different Company', first.id),
    /immutable/
  );
  assert.throws(
    () => db.prepare('UPDATE experiences SET role = ? WHERE id = ?').run('Different Title', first.id),
    /immutable/
  );
  assert.throws(
    () => db.prepare('UPDATE experiences SET start_date = ? WHERE id = ?').run('Apr 2026', first.id),
    /immutable/
  );
  assert.throws(
    () => db.prepare('UPDATE experiences SET end_date = ? WHERE id = ?').run('May 2026', first.id),
    /immutable/
  );

  db.close();
});

test('descriptions, CV visibility, and display order remain editable', () => {
  const db = createDb();
  syncDouglasVerifiedEmployment(db);
  const first = VERIFIED_DOUGLAS_EMPLOYMENT[0];

  db.prepare(`
    UPDATE experiences
       SET description = ?, is_cv_context = 0, display_order = 999
     WHERE id = ?
  `).run('Revised evidence-backed description', first.id);

  const row = db.prepare(
    'SELECT description, is_cv_context, display_order FROM experiences WHERE id = ?'
  ).get(first.id);
  assert.deepEqual(row, {
    description: 'Revised evidence-backed description',
    is_cv_context: 0,
    display_order: 999,
  });
  db.close();
});
