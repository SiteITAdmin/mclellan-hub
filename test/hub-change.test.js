'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  slugify,
  makeId,
  generateId,
  branchNameFor,
  requiredStepsFor,
  defaultCommitSubject,
  formatStep,
  stepsUntilClosed,
  nextStep,
  isTerminal,
  AREAS,
  TYPE_INFO,
  STEPS,
  BRANCH_PREFIX,
} = require('../scripts/hub-change');

describe('slugify', () => {
  it('lowercases and strips non-alphanumeric', () => {
    assert.equal(slugify('CRM Task Calendar!!'), 'crm-task-calendar');
  });
  it('collapses multiple dashes/spaces', () => {
    assert.equal(slugify('fix   the -- thing'), 'fix-the-thing');
  });
  it('trims leading and trailing dashes', () => {
    assert.equal(slugify('--hello world--'), 'hello-world');
  });
  it('truncates at 60 chars', () => {
    const long = 'a'.repeat(100);
    assert.equal(slugify(long).length, 60);
  });
  it('handles empty string', () => {
    assert.equal(slugify(''), '');
  });
  it('handles special characters', () => {
    assert.equal(slugify('Outlook 365 (beta) — sync!'), 'outlook-365-beta-sync');
  });
});

describe('makeId', () => {
  it('returns datePart and timePart strings from given date', () => {
    const d = new Date('2026-08-11T14:05:00Z');
    const { datePart, timePart } = makeId(d);
    assert.equal(datePart, '20260811');
    // timePart uses local getHours — just check format
    assert.match(timePart, /^\d{4}$/);
  });
  it('uses current date when no arg', () => {
    const { datePart, timePart } = makeId();
    assert.equal(typeof datePart, 'string');
    assert.equal(typeof timePart, 'string');
    assert.equal(datePart.length, 8);
    assert.equal(timePart.length, 4);
  });
});

describe('generateId', () => {
  it('produces YYYYMMDD-HHMM-area-slug format', () => {
    const d = new Date('2026-03-15T09:30:00Z');
    const id = generateId('fix', 'CRM', 'Task calendar wrong dates', d);
    assert.match(id, /^20260315-0930-crm-/);
    assert.match(id, /task-calendar-wrong-dates$/);
  });
  it('truncates area to 8 chars', () => {
    const id = generateId('fix', 'Documents / Projects', 'test', new Date());
    const areaPart = id.split('-').slice(2).join('-').split('-')[0];
    assert.ok(areaPart.length <= 8);
  });
});

describe('branchNameFor', () => {
  it('maps fix to fix/', () => {
    assert.equal(branchNameFor('fix', 'crm-bug'), 'fix/crm-bug');
  });
  it('maps incident to repair/', () => {
    assert.equal(branchNameFor('incident', 'outage-now'), 'repair/outage-now');
  });
  it('maps emergency to hotfix/', () => {
    assert.equal(branchNameFor('emergency', 'db-corrupt'), 'hotfix/db-corrupt');
  });
  it('maps feature to feature/', () => {
    assert.equal(branchNameFor('feature', 'new-thing'), 'feature/new-thing');
  });
  it('maps refactor to refactor/', () => {
    assert.equal(branchNameFor('refactor', 'clean-up'), 'refactor/clean-up');
  });
  it('maps unknown type to change/', () => {
    assert.equal(branchNameFor('unknown', 'foo'), 'change/foo');
  });
});

describe('requiredStepsFor', () => {
  it('chore is short (fast-track)', () => {
    const steps = requiredStepsFor('chore');
    assert.ok(steps.length <= 8, `chore has ${steps.length} steps, expected ≤8`);
    assert.ok(!steps.includes('investigating'));
    assert.ok(!steps.includes('planned'));
    assert.ok(!steps.includes('pushed'));
    assert.ok(!steps.includes('pr'));
  });
  it('incident includes investigating', () => {
    const steps = requiredStepsFor('incident');
    assert.ok(steps.includes('investigating'));
    assert.ok(steps.includes('planned'));
  });
  it('feature includes pushed', () => {
    const steps = requiredStepsFor('feature');
    assert.ok(steps.includes('pushed'));
    assert.ok(steps.includes('pr'));
  });
  it('emergency is fast-track', () => {
    const steps = requiredStepsFor('emergency');
    assert.ok(!steps.includes('investigating') || steps.length <= 7);
  });
  it('all types end with closed', () => {
    for (const type of Object.keys(TYPE_INFO)) {
      const steps = requiredStepsFor(type);
      assert.equal(steps[steps.length - 1], 'closed', `${type} should end with closed`);
    }
  });
});

describe('defaultCommitSubject', () => {
  it('formats type(area): title', () => {
    const t = { type: 'fix', area: 'CRM', title: 'calendar bug' };
    assert.equal(defaultCommitSubject(t), 'fix(CRM): calendar bug');
  });
  it('omits parens when area missing', () => {
    const t = { type: 'feature', area: '', title: 'new thing' };
    assert.equal(defaultCommitSubject(t), 'feature: new thing');
  });
});

describe('formatStep', () => {
  it('returns a string with icon and step name', () => {
    assert.match(formatStep('new'), /●/);
    assert.match(formatStep('closed'), /■/);
    assert.match(formatStep('committed'), /✓/);
  });
});

describe('stepsUntilClosed', () => {
  it('returns all steps after current', () => {
    const ticket = { step: 'planned' };
    const remaining = stepsUntilClosed(ticket);
    assert.ok(remaining.includes('branching'));
    assert.ok(remaining.includes('closed'));
    assert.ok(!remaining.includes('planned'));
    assert.ok(!remaining.includes('new'));
  });
  it('returns empty for closed', () => {
    const remaining = stepsUntilClosed({ step: 'closed' });
    assert.equal(remaining.length, 0);
  });
});

describe('nextStep', () => {
  it('returns the step after current', () => {
    assert.equal(nextStep({ step: 'new' }), 'investigating');
    assert.equal(nextStep({ step: 'investigating' }), 'planned');
  });
  it('returns null for closed', () => {
    assert.equal(nextStep({ step: 'closed' }), null);
  });
});

describe('isTerminal', () => {
  it('true for closed', () => {
    assert.ok(isTerminal({ step: 'closed' }));
  });
  it('false for others', () => {
    assert.ok(!isTerminal({ step: 'deployed' }));
    assert.ok(!isTerminal({ step: 'new' }));
  });
});

describe('constants', () => {
  it('AREAS is a non-empty array', () => {
    assert.ok(Array.isArray(AREAS));
    assert.ok(AREAS.length > 10);
  });
  it('TYPE_INFO has all expected types', () => {
    for (const type of ['fix', 'feature', 'refactor', 'incident', 'emergency', 'chore']) {
      assert.ok(TYPE_INFO[type], `missing type: ${type}`);
      assert.equal(typeof TYPE_INFO[type].needsInvestigate, 'boolean');
      assert.equal(typeof TYPE_INFO[type].needsPlan, 'boolean');
      assert.equal(typeof TYPE_INFO[type].fast, 'boolean');
    }
  });
  it('STEPS is ordered and ends with closed', () => {
    assert.equal(STEPS[0], 'new');
    assert.equal(STEPS[STEPS.length - 1], 'closed');
  });
  it('BRANCH_PREFIX covers all types', () => {
    for (const type of Object.keys(TYPE_INFO)) {
      assert.ok(BRANCH_PREFIX[type], `missing prefix for type: ${type}`);
    }
  });
});
