'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { counties, salesFor, registerUrl } = require('../lib/crm/house/sales-register');

const T = Date.parse('2026-11-19T12:00:00Z') / 1000;
const DAY = 86400;
const HEADER = 'Date of Sale (dd/mm/yyyy),Address,County,Eircode,Price (€),Not Full Market Price,VAT Exclusive,Description of Property,Property Size Description';

function csv(rows) {
  const text = [HEADER, ...rows].join('\r\n').replaceAll('€', '\x80');
  return new Response(Buffer.from(text, 'latin1'));
}

test('official county files preserve evidence and parse CP1252 prices while excluding invalid and non-market records', async () => {
  const urls = [];
  const fetcher = async (url, options) => {
    urls.push(url);
    assert.equal(options.redirect, 'error');
    const year = /PPR-(\d{4})-Wicklow/.exec(url)[1];
    const valid = `"03/03/${year}","APT 1, Dún ""Ridge""","Wicklow","A67 F2K2","€385,000.50","No","No","Second-Hand Dwelling house /Apartment",""`;
    return csv([
      valid, valid,
      `"04/03/${year}","17 OAK ROAD","Wicklow","","€340,000.00","No","Yes","Dwelling",""`,
      `"04/03/${year}","18 OAK ROAD","Wicklow","","€360,000.00","No","No","New Dwelling house /Apartment",""`,
      `"04/03/${year}","BELOW MARKET","Wicklow","","€34,000.00","Yes","No","Dwelling",""`,
      `"30/02/${year}","BAD DATE","Wicklow","","€340,000.00","No","No","Dwelling",""`,
      `"04/03/${year}","BAD PRICE","Wicklow","","€3,40,000.00","No","No","Dwelling",""`,
      `"04/03/${year}","WRONG COUNTY","Dublin","","€389,000.00","No","No","Dwelling",""`,
    ]);
  };
  const result = await salesFor('wicklow', { fetcher, t: T });
  assert.deepEqual(urls, [2026, 2025, 2024].map(year => registerUrl('Wicklow', year)));
  assert.equal(counties.length, 26);
  assert.equal(result.asOf, T);
  assert.equal(result.rows.length, 9);
  assert.deepEqual(result.rows[0], {
    address: 'APT 1, Dún "Ridge"', county: 'Wicklow', eircode: 'A67F2K2', day: '2026-03-03',
    sold: 385000.5, newBuild: false, url: registerUrl('Wicklow', 2026),
  });
  assert.equal(result.rows[1].newBuild, true);
  assert.equal(result.rows[2].newBuild, true);
  assert.throws(() => registerUrl('../Wicklow', 2026), /county and sale year/);
});

test('concurrent requests share downloads and refresh errors fall back to dated cached sales briefly', async () => {
  let requests = 0, fail = false;
  const fetcher = async url => {
    requests += 1;
    if (fail) throw new Error('Failed download');
    const year = /PPR-(\d{4})-Cork/.exec(url)[1];
    return csv([`"11/03/${year}","15 MAIN STREET","Cork","","€277,000.00","No","No","Dwelling",""`]);
  };
  const list = t => salesFor('Cork', { fetcher, t });
  await Promise.all([list(T), list(T)]);
  assert.equal(requests, 3);

  fail = true;
  assert.equal((await list(T + DAY)).asOf, T);
  assert.equal((await list(T + DAY + 60)).asOf, T);
  assert.equal(requests, 6);

  fail = false;
  assert.equal((await list(T + DAY + 900)).asOf, T + DAY + 900);
  assert.equal(requests, 9);
  fail = true;
  await assert.rejects(list(T + 9 * DAY), /Failed download/);
});

test('unexpected response hosts and wrong-county files are rejected', async () => {
  await assert.rejects(salesFor('Louth', { t: T, fetcher: async () => ({
    ok: true, url: 'https://unrelated.example/sales.csv',
  }) }), /response URL/);
  await assert.rejects(salesFor('Louth', { t: T, fetcher: async () => csv([
    '"03/03/2026","15 MAIN STREET","Cork","","€277,000.00","No","No","Dwelling",""',
  ]) }), /different county/);
});
