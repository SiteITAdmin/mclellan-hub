const session = require('express-session');
const db = require('./db');

class BetterSqliteSessionStore extends session.Store {
  constructor() {
    super();
    this.database = db.hub();
    this.tableName = 'app_sessions';
    this.ensureSchema();
    this.readStmt = this.database.prepare(`SELECT sess, expire FROM ${this.tableName} WHERE sid = ?`);
    this.writeStmt = this.database.prepare(`
      INSERT INTO ${this.tableName} (sid, sess, expire)
      VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire
    `);
    this.deleteStmt = this.database.prepare(`DELETE FROM ${this.tableName} WHERE sid = ?`);
    this.deleteExpiredStmt = this.database.prepare(`DELETE FROM ${this.tableName} WHERE expire < ?`);
  }

  ensureSchema() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expire INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_expire ON ${this.tableName}(expire);
    `);
  }

  cleanupExpired() {
    this.deleteExpiredStmt.run(Date.now());
  }

  get(sid, cb) {
    try {
      this.cleanupExpired();
      const row = this.readStmt.get(sid);
      if (!row) return cb(null, null);
      if (row.expire < Date.now()) {
        this.deleteStmt.run(sid);
        return cb(null, null);
      }
      return cb(null, JSON.parse(row.sess));
    } catch (err) {
      return cb(err);
    }
  }

  set(sid, sess, cb = () => {}) {
    try {
      const maxAge = sess?.cookie?.maxAge || 24 * 60 * 60 * 1000;
      const expire = Date.now() + maxAge;
      this.writeStmt.run(sid, JSON.stringify(sess), expire);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb = () => {}) {
    try {
      this.deleteStmt.run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb = () => {}) {
    this.set(sid, sess, cb);
  }
}

module.exports = BetterSqliteSessionStore;
