'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveContactIdentityFromContacts } = require('../lib/contact-identity');

const contacts = [
  { id: 'nakai', name: 'Nakai McLellan', aliases: '["Nakai Mutenga","Kai"]', email: '', phone: '0896003149' },
  { id: 'alan', name: 'Alan Garland', aliases: '["Alan"]', email: 'alan@example.test', phone: '' },
  { id: 'alec', name: 'Alec Hirst', aliases: '["Alec Kangley"]', email: 'alec@example.test', phone: '' },
];

test('canonical names and aliases resolve before model reasoning', () => {
  assert.equal(resolveContactIdentityFromContacts(contacts, { names: ['Kai'] }).contact.id, 'nakai');
  assert.equal(resolveContactIdentityFromContacts(contacts, { names: ['Alan Garland'] }).contact.id, 'alan');
  assert.equal(resolveContactIdentityFromContacts(contacts, { names: ['Alec Kangley'] }).contact.id, 'alec');
  assert.equal(resolveContactIdentityFromContacts(contacts, { names: ['Alec'] }).contact.id, 'alec');
  assert.equal(resolveContactIdentityFromContacts(contacts, { addresses: ['+353 89 600 3149'] }).contact.id, 'nakai');
});

test('a composite observed name can combine corroborating tokens from one contact aliases', () => {
  const resolved = resolveContactIdentityFromContacts(contacts, { names: ['Kai Mutenga'] });
  assert.equal(resolved.status, 'matched');
  assert.equal(resolved.contact.id, 'nakai');
  assert.deepEqual(resolved.matchedBy, ['composite_alias']);
});

test('near names never fuzzy-match and conflicting identity signals fail closed', () => {
  assert.equal(resolveContactIdentityFromContacts(contacts, { names: ['Alen'] }).status, 'unresolved');
  assert.equal(resolveContactIdentityFromContacts(contacts, { names: ['Alan Hirst'] }).status, 'unresolved');

  const conflict = resolveContactIdentityFromContacts(contacts, {
    names: ['Alan'],
    addresses: ['alec@example.test'],
  });
  assert.equal(conflict.status, 'ambiguous');
  assert.equal(conflict.contact, null);
  assert.deepEqual(new Set(conflict.candidateIds), new Set(['alan', 'alec']));
});

test('a duplicated alias is ambiguous rather than first-row-wins', () => {
  const duplicated = [...contacts, { id: 'other-kai', name: 'Kaia Other', aliases: '["Kai"]' }];
  const resolved = resolveContactIdentityFromContacts(duplicated, { names: ['Kai'] });
  assert.equal(resolved.status, 'ambiguous');
  assert.equal(resolved.contact, null);
});

test('a bare first name resolves only while it is unique', () => {
  const duplicated = [...contacts, { id: 'other-alec', name: 'Alec Other', aliases: '[]' }];
  const resolved = resolveContactIdentityFromContacts(duplicated, { names: ['Alec'] });
  assert.equal(resolved.status, 'ambiguous');
  assert.equal(resolved.contact, null);
});
