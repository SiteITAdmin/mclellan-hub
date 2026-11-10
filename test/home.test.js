'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-home-'));
process.env.HUB_DB_PATH = path.join(tmp, 'hub.db');
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db');

const express = require('express');

function serve(signedIn) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use((req, res, next) => { req.portfolioUser = 'douglas'; req.session = signedIn ? { adminUser: 'douglas' } : {}; next(); });
  app.use(require('../routes/home'));
  app.use(require('../routes/crm'));
  app.use(require('../routes/flights'));
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('the landing page is only for the signed-in owner', async () => {
  const { server, base } = serve(false);
  try {
    const res = await fetch(`${base}/home`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/admin/login');
  } finally { server.close(); }
});

test('every link on the landing page opens a real screen', async () => {
  const { server, base } = serve(true);
  try {
    const res = await fetch(`${base}/home`);
    const body = await res.text();
    assert.strictEqual(res.status, 200, body.slice(0, 300));
    const links = [...new Set([...body.matchAll(/<a href="([^"]+)"/g)].map(m => m[1]))];
    for (const want of ['/crm/work', '/crm/personal', '/flights', '/crm/review', '/crm/vendors', '/crm/work/calendar', '/crm/work/meetings', '/crm/personal/meetings', '/crm/personal/note', '/admin', '/'])
      assert.ok(links.includes(want), `links to ${want}`);
    // The public site and its editor are served by other routers with their own tests.
    const elsewhere = ['/', '/admin', '/chat'];
    const outside = links.filter(h => !h.startsWith('/'));
    assert.deepStrictEqual(outside, ['https://dev-server.tailc6e5c3.ts.net/'], 'Change Desk is the only link off the site');
    assert.match(body, /Change Desk<\/span><span class="what">[^<]*Needs Tailscale/, 'and it says where it works');
    for (const href of links.filter(h => h.startsWith('/') && !elsewhere.includes(h))) {
      const page = await fetch(base + href);
      assert.strictEqual(page.status, 200, `${href} → ${page.status}`);
    }
  } finally { server.close(); }
});
