(() => {
  'use strict';

  // ── Toast notifications ──────────────────────────────────────────────────
  let toastTimer = null;
  function showToast(text, isError) {
    let el = document.getElementById('hub-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'hub-toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.toggle('bad', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
  }

  // ── Mobile drawer (replaces CSS :target hash navigation) ─────────────────
  const drawer = document.getElementById('menu');
  const openBtn = document.querySelector('[data-drawer-open]');
  const closeBtn = document.querySelector('[data-drawer-close]');
  function setDrawer(open) {
    if (!drawer) return;
    drawer.classList.toggle('is-open', open);
    document.body.classList.toggle('drawer-open', open);
    if (openBtn) openBtn.setAttribute('aria-expanded', String(open));
    if (open) closeBtn?.focus();
    else openBtn?.focus();
  }
  if (drawer && openBtn) {
    openBtn.addEventListener('click', e => { e.preventDefault(); setDrawer(true); });
    closeBtn?.addEventListener('click', e => { e.preventDefault(); setDrawer(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && drawer.classList.contains('is-open')) setDrawer(false); });
    drawer.addEventListener('click', e => { if (e.target === drawer) setDrawer(false); });
  }

  // ── Inline async micro-actions (progressive enhancement on forms) ────────
  document.addEventListener('submit', async e => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-async')) return;
    if (e.defaultPrevented) return;
    e.preventDefault();

    const submitter = e.submitter instanceof HTMLButtonElement || e.submitter instanceof HTMLInputElement ? e.submitter : null;
    const mode = form.getAttribute('data-async') || 'remove';
    const data = new URLSearchParams(new FormData(form));
    if (submitter && submitter.name) data.append(submitter.name, submitter.value);

    const row = form.closest('[data-async-row], .promise, .task-row, .suggest, .rowcard');
    if (submitter) submitter.disabled = true;
    try {
      const res = await fetch(form.action, {
        method: (form.method || 'POST').toUpperCase(),
        headers: {
          'Accept': 'application/json',
          'X-Requested-With': 'fetch',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: data.toString(),
        credentials: 'same-origin',
      });
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        // Fallback for endpoints that returned a full redirect/HTML page.
        window.location.href = res.url || window.location.href;
        return;
      }
      const json = await res.json();
      if (!res.ok || json.ok === false) {
        showToast(json.message || 'Could not save change.', true);
        if (submitter) submitter.disabled = false;
        return;
      }
      showToast(json.message || 'Saved.', false);
      if (mode === 'remove' && row) {
        row.classList.add('is-dismissing');
        setTimeout(() => row.remove(), 180);
      } else if (mode === 'toggle-task' && row) {
        row.classList.add('is-dismissing');
        setTimeout(() => row.remove(), 180);
      } else if (mode === 'reload') {
        window.location.reload();
      } else if (submitter) {
        submitter.disabled = false;
      }
    } catch (_) {
      form.removeAttribute('data-async');
      form.submit();
    }
  });

  // ── Smooth status polling (replaces <meta http-equiv="refresh">) ─────────
  const pollEl = document.querySelector('[data-poll-interval]');
  if (pollEl) {
    const ms = Math.max(3000, Number(pollEl.getAttribute('data-poll-interval')) || 6000);
    const url = pollEl.getAttribute('data-poll-url') || window.location.href;
    const poll = async () => {
      if (document.hidden) { setTimeout(poll, ms); return; }
      try {
        const res = await fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'poll' } });
        if (!res.ok) { setTimeout(poll, ms); return; }
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const nextMain = doc.querySelector('main.canvas .column, main.tool-canvas .column');
        const curMain = document.querySelector('main.canvas .column, main.tool-canvas .column');
        const stillWaiting = !!doc.querySelector('[data-poll-interval]');
        if (nextMain && curMain) {
          // Only replace if user isn't actively typing in an input inside main.
          const active = document.activeElement;
          const typing = active && curMain.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
          if (!typing) curMain.innerHTML = nextMain.innerHTML;
        }
        if (stillWaiting) setTimeout(poll, ms);
      } catch (_) {
        setTimeout(poll, ms * 2);
      }
    };
    setTimeout(poll, ms);
  }

  // ── WhatsApp approval: filter single Project dropdown by chosen Space ────
  document.querySelectorAll('[data-wa-space]').forEach(spaceSel => {
    const form = spaceSel.closest('form');
    const projSel = form?.querySelector('[data-wa-project]');
    if (!projSel) return;
    const sync = () => {
      const sp = spaceSel.value;
      for (const opt of projSel.options) {
        const optSpace = opt.getAttribute('data-space');
        if (!optSpace) { opt.hidden = false; continue; }
        opt.hidden = optSpace !== sp;
      }
      if (projSel.selectedOptions[0]?.hidden) projSel.value = '';
    };
    spaceSel.addEventListener('change', sync);
    sync();
  });

  // ── Keyboard shortcuts on "Who is this?" triage screen ───────────────────
  const reviewRoot = document.querySelector('[data-review-shortcuts]');
  if (reviewRoot) {
    document.addEventListener('keydown', e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;
      const key = e.key.toLowerCase();
      if (key === 'v' || key === 'i' || key === 'l') {
        const action = key === 'v' ? 'vendor' : key === 'i' ? 'ignore' : 'later';
        const btn = reviewRoot.querySelector(`[data-shortcut-action="${action}"]`);
        if (btn) { e.preventDefault(); btn.click(); }
      } else if (key === 'j' || key === 'k') {
        const links = [...document.querySelectorAll('.queue a')];
        if (!links.length) return;
        const idx = links.findIndex(a => a.getAttribute('aria-current') === 'true');
        const next = key === 'j' ? links[Math.min(links.length - 1, idx + 1)] : links[Math.max(0, idx - 1)];
        if (next && next !== links[idx]) { e.preventDefault(); next.click(); }
      }
    });
  }

  // ── Bulk select all checkboxes (Imports, Facts) ──────────────────────────
  document.querySelectorAll('[data-check-all]').forEach(master => {
    const targetName = master.getAttribute('data-check-all');
    const form = master.closest('form') || document;
    const boxes = () => [...form.querySelectorAll(`input[type="checkbox"][name="${targetName}"]`)];
    master.addEventListener('change', () => {
      for (const b of boxes()) b.checked = master.checked;
    });
  });
})();
