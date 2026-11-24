const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const script = fs.readFileSync(require.resolve('../public/crm-enhance.js'), 'utf8');

for (const decision of ['vendor', 'ignore']) {
  test('Quick triage posts ' + decision + ' to the review item once', async () => {
    let onSubmit;
    let pending = false;
    let removed = false;
    const requests = [];
    class Button { hasAttribute() { return false; } }
    const buttons = [new Button(), new Button()];
    const row = {
      hasAttribute: () => pending,
      setAttribute: () => { pending = true; },
      querySelectorAll: () => buttons,
      classList: { add() {} },
      remove: () => { removed = true; },
    };
    class Form {
      // A named form control takes precedence over the action property in browsers.
      action = { value: decision };
      hasAttribute(name) { return name === 'data-async'; }
      getAttribute(name) { return { action: '/crm/review/71', method: 'post', 'data-async': 'remove' }[name]; }
      closest() { return row; }
    }
    const document = {
      getElementById: id => id === 'hub-toast' ? { classList: { add() {}, toggle() {}, remove() {} } } : null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (type, fn) => { if (type === 'submit') onSubmit = fn; },
    };
    vm.runInNewContext(script, {
      document, HTMLFormElement: Form, HTMLButtonElement: Button, HTMLInputElement: class {},
      FormData: class extends URLSearchParams { constructor(form) { super({ action: form.action.value }); } },
      URLSearchParams, setTimeout: fn => fn(), clearTimeout() {},
      fetch: async (url, options) => { requests.push([url, options.method, options.body]); return Response.json({ ok: true }); },
    });
    const submit = button => onSubmit({ target: new Form(), submitter: button, preventDefault() {} });
    const first = submit(buttons[0]);
    assert.ok(buttons.every(button => button.disabled));
    await submit(buttons[1]);
    await first;
    assert.deepEqual(requests, [['/crm/review/71', 'POST', 'action=' + decision]]);
    assert.ok(removed);
  });
}
