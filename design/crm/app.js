(() => {
  const { TODAY, people, spaces, person, review, days } = window.CRM;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const path = (d) => `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const icon = {
    today: path('<rect x="2.5" y="3" width="11" height="10.5" rx="2"/><path d="M2.5 6.5h11M5.5 1.5v3M10.5 1.5v3"/>'),
    people: path('<circle cx="6" cy="5.5" r="2.5"/><path d="M1.5 13.5c.5-2.5 2.3-4 4.5-4s4 1.5 4.5 4"/><path d="M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12 9.8c1.3.6 2.2 1.9 2.5 3.7"/>'),
    projects: path('<path d="M1.5 4.5a1 1 0 0 1 1-1h3.3l1.4 1.5h6.3a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>'),
    promises: path('<circle cx="8" cy="8" r="6"/><path d="M5.5 8.2l1.7 1.7 3.3-3.6"/>'),
    captured: path('<path d="M1.5 9.5l2-6h9l2 6v3a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/><path d="M1.5 9.5h4l1 1.5h3l1-1.5h4"/>'),
    search: path('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3.5 3.5"/>'),
    review: path('<circle cx="6.5" cy="5.5" r="2.5"/><path d="M2 13.5c.5-2.4 2.2-4 4.5-4 1 0 1.9.3 2.6.8"/><path d="M11 9.3a1.6 1.6 0 1 1 1.9 1.6c-.4.1-.4.4-.4.8M12.5 13.4v.1"/>'),
    plus: path('<path d="M8 3v10M3 8h10"/>'),
    email: path('<rect x="1.5" y="3" width="13" height="10" rx="1.5"/><path d="M2 4l6 5 6-5"/>'),
    meeting: path('<rect x="2.5" y="3" width="11" height="10.5" rx="2"/><path d="M2.5 6.5h11M5.5 1.5v3M10.5 1.5v3"/>'),
    note: path('<path d="M10.5 2.5l3 3-8 8H2.5v-3z"/>'),
    report: path('<path d="M4 1.5h5l3.5 3.5v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1z"/><path d="M9 1.5v3.5h3.5M5.5 9h5M5.5 11.5h3"/>'),
    message: path('<path d="M2 3.5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6l-3 2.5v-2.5H3a1 1 0 0 1-1-1z"/>'),
    contact: path('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><circle cx="8" cy="6.5" r="1.8"/><path d="M5 11c.5-1.3 1.6-2 3-2s2.5.7 3 2"/>'),
    check: path('<path d="M3.5 8.5l3 3 6-7"/>'),
    tasks: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="3"/><path d="M5 8.3l2 2 4-4.3"/></svg>',
    menu: path('<path d="M2 4.5h12M2 8h12M2 11.5h12"/>'),
    inArrow: path('<path d="M11 5L5 11M5 6v5h5"/>'),
    outArrow: path('<path d="M5 11l6-6M6 5h5v5"/>'),
  };
  const mark = '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M11 2a9 9 0 0 0 0 18z" fill="var(--accent)"/><path d="M11 2.75a8.25 8.25 0 0 1 0 16.5" fill="none" stroke="var(--accent)" stroke-width="1.5"/></svg>';

  const avatar = (id, cls = '') => {
    if (!id) return `<span class="avatar none ${cls}" aria-hidden="true">${icon.projects}</span>`;
    const p = people[id];
    return `<span class="avatar ${cls}" style="--h:${p.hue}" aria-hidden="true">${esc(p.initials)}</span>`;
  };
  const shortDate = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' });
  const dueWords = (iso) => {
    const d = days(TODAY, iso);
    if (d === 0) return { text: 'Today', late: false };
    if (d < 0) return { text: `${-d} ${d === -1 ? 'day' : 'days'} late`, late: true };
    if (d === 1) return { text: 'Tomorrow', late: false };
    if (d < 7) return { text: new Date(iso + 'T12:00:00').toLocaleDateString('en-IE', { weekday: 'long' }), late: false };
    return { text: shortDate(iso), late: false };
  };
  const waitedWords = (iso) => { const d = days(iso, TODAY); return d === 1 ? '1 day' : `${d} days`; };

  // ---------- shell ----------
  const shell = (space, page, body) => {
    const sp = space || 'shared';
    const base = space || 'work';
    const navItem = (href, ic, label, key, extra = '') =>
      `<a href="${href}" ${page === key ? 'aria-current="page"' : ''}>${icon[ic]}<span>${label}</span>${extra}</a>`;
    return `
    <div class="shell" data-space="${sp}">
      <aside class="sidebar" aria-label="Main">
        <div class="brand">${mark}<span>Hub</span></div>
        <nav class="switch" aria-label="Space">
          <a href="#/work" aria-current="${space === 'work'}">Work</a>
          <a href="#/personal" aria-current="${space === 'personal'}">Personal</a>
        </nav>
        <nav class="nav">
          ${navItem(`#/${base}`, 'today', 'Today', 'today')}
          ${navItem(`#/${base}/people/alec-byrne`, 'people', 'People', 'people')}
          ${navItem(`#/${base}`, 'projects', 'Projects', 'projects')}
          ${navItem(`#/${base}`, 'promises', 'Promises', 'promises')}
          ${navItem(`#/${base}`, 'captured', 'Captured', 'captured')}
          ${navItem(`#/${base}`, 'search', 'Search', 'search')}
          <div class="nav-group">Both spaces</div>
          ${navItem('#/review', 'review', 'Who is this?', 'review', `<span class="count">${review.items.length}<span class="sr-only"> waiting</span></span>`)}
        </nav>
        <div class="sidebar-foot">
          <button class="btn primary" type="button">${icon.plus} Add a note</button>
          <div class="user">${avatarSelf()}<div>Douglas McLellan<small>Google Tasks synced 07:58</small></div></div>
        </div>
      </aside>
      <header class="topbar">
        <button class="menu-btn" type="button" aria-label="Open menu">${icon.menu}</button>
        <span class="brand" style="padding:0">${mark}</span>
        <span class="t">${page === 'review' ? 'Who is this?' : page === 'people' ? 'People' : 'Today'}</span>
        <nav class="switch" aria-label="Space">
          <a href="#/work" aria-current="${space === 'work'}">Work</a>
          <a href="#/personal" aria-current="${space === 'personal'}">Personal</a>
        </nav>
      </header>
      <main class="canvas"><div class="column">${body}</div></main>
    </div>`;
  };
  const avatarSelf = () => '<span class="avatar" style="--h:0;background:var(--active);color:var(--text)" aria-hidden="true">DM</span>';

  // ---------- Today ----------
  const today = (key) => {
    const s = spaces[key];
    const c = s.counts;
    const first = s.owe.find((r) => r.due === TODAY);
    const finding = key === 'work'
      ? `Morning, Douglas. <span class="who">${esc(people[first.who].name.split(' ')[0])}</span> expects the Intune plan today.`
      : `Morning, Douglas. Order <span class="who">Dad’s</span> prescription by Wednesday.`;
    const lateCount = c.overdue;

    const oweRow = (r) => {
      const d = dueWords(r.due);
      const who = r.who ? people[r.who].name : r.project;
      return `<div class="rowcard owe">
        ${avatar(r.who)}
        <div class="main"><div class="what">${esc(r.what)}</div><div class="meta">${esc(who)}${r.project && r.who ? `, ${esc(r.project)} project` : ''}</div></div>
        <div class="end"><span class="when ${d.late ? 'late' : ''}">${d.text}</span><small>${r.task ? `<span class="tasks-mark">${icon.tasks} In Tasks</span>` : esc(r.from)}</small></div>
        <button class="done" type="button" aria-label="Mark done: ${esc(r.what)}">${icon.check}</button>
      </div>`;
    };
    const owedRow = (r) => `<div class="rowcard">
        ${avatar(r.who)}
        <div class="main"><div class="what">${esc(r.what)}</div><div class="meta">${esc(people[r.who].name)}, ${esc(r.from)}</div></div>
        <div class="end"><span class="when">${waitedWords(r.asked)}</span><small>waiting</small></div>
      </div>`;

    const maxWeeks = 14;
    const pct = (w) => `${((maxWeeks - w) / maxWeeks) * 100}%`;
    const driftRow = (d) => {
      const over = d.last - d.every;
      return `<div class="drift-row">
        <div class="name">${avatar(d.who)}<span>${esc(people[d.who].name)}</span></div>
        <div class="track" role="img" aria-label="Last contact ${d.last} weeks ago, due every ${d.every} weeks, ${over} weeks over">
          <span class="span" style="left:${pct(d.last)};width:${(d.every / maxWeeks) * 100}%"></span>
          <span class="overrun" style="left:${pct(d.last - d.every)};right:0"></span>
          <span class="last" style="left:${pct(d.last)}"></span>
          <span class="due" style="left:${pct(d.last - d.every)}"></span>
        </div>
        <div class="over">${over} ${over === 1 ? 'week' : 'weeks'} over<small>every ${d.every} weeks</small></div>
      </div>`;
    };
    const ticks = [12, 8, 4, 0];

    const capRow = (r) => {
      const pill = r.state === 'unreadable' ? '<span class="pill neg">Couldn’t read</span>'
        : r.state === 'review' ? '<span class="pill warn">1 to decide</span>' : '';
      return `<div class="rowcard">
        <span class="kind-icon" aria-hidden="true">${icon[r.kind]}</span>
        <div class="main"><div class="what">${esc(r.title)}</div><div class="meta">${esc(r.detail)}</div></div>
        <div class="end">${pill || `<span class="when">${esc(r.when)}</span>`}${pill ? `<small>${esc(r.when)}</small>` : ''}</div>
      </div>`;
    };

    return shell(key, 'today', `
      <div class="greeting">
        <div>
          <h1>${finding}</h1>
          <p class="subline"><span class="space-name">${s.label}</span>, ${s.dateLine}. ${c.dueToday} due today, ${lateCount} late.</p>
        </div>
      </div>

      <section class="grid first" aria-label="Counts">
        <div class="tile s3"><span class="label">Due today</span><span class="value">${c.dueToday}</span><span class="caption">Things you said you’d do</span></div>
        <div class="tile s3"><span class="label">Late</span><span class="value ${c.overdue ? 'alert' : ''}">${c.overdue}</span><span class="caption">${c.overdue ? 'Past the date you gave' : 'Nothing late'}</span></div>
        <div class="tile s3"><span class="label">Waiting on others</span><span class="value">${c.waiting}</span><span class="caption">Longest ${waitedWords(s.owed[0].asked)}</span></div>
        <div class="tile s3"><span class="label">Drifting</span><span class="value">${c.drifting}</span><span class="caption">Past their keep-in-touch</span></div>
      </section>

      <section class="grid stretch">
        <div class="panel s9">
          <div class="panel-head"><h2>Promises</h2><a class="end" href="#/${key}">View all</a></div>
          <div class="ledger">
            <div class="lane"><h3><b>You owe</b> ${s.owe.length}</h3><div class="rows">${s.owe.map(oweRow).join('')}</div></div>
            <div class="lane"><h3><b>Owed to you</b> ${s.owed.length}</h3><div class="rows">${s.owed.map(owedRow).join('')}</div></div>
          </div>
        </div>
        <div class="panel s3 side agenda">
          <div class="panel-head"><h2>${s.agenda.title}</h2></div>
          <div class="rows">${s.agenda.items.map((m) => `<div class="rowcard">
            <span class="time">${esc(m.time)}</span>
            <div class="main"><div class="what">${esc(m.what)}</div><div class="meta">${esc(m.note)}</div>
            <div class="avatars" style="margin-top:6px">${m.with.map((w) => avatar(w)).join('')}</div></div>
          </div>`).join('')}</div>
        </div>
      </section>

      <section class="grid">
        <div class="panel s6">
          <div class="panel-head"><h2>Drifting</h2><span class="end drift-key"><span><i class="k-last"></i>Last contact</span><span><i class="k-due"></i>Due</span><span><i class="k-over"></i>Over</span></span></div>
          <div class="drift">${s.drift.map(driftRow).join('')}</div>
          <div class="drift-axis"><span></span><div class="ticks">${ticks.map((w) => `<span style="left:${pct(w)}">${w === 0 ? 'Today' : `${w} wk`}</span>`).join('')}</div><span></span></div>
        </div>
        <div class="panel s6 feed">
          <div class="panel-head"><h2>Captured</h2><span class="chip">last 24 hours</span><a class="end" href="#/${key}">View all</a></div>
          <div class="rows">${s.captured.map(capRow).join('')}</div>
        </div>
      </section>`);
  };

  // ---------- Person ----------
  const personPage = () => {
    const p = people[person.id];
    const s = spaces.work;
    const loopsOwe = s.owe.filter((r) => r.who === person.id);
    const loopsOwed = s.owed.filter((r) => r.who === person.id);
    const summary = person.summary.text.map(([t, n]) => `${esc(t)}${n ? `<a class="cite" href="#" data-src="${n}" aria-label="Source ${n}">${n}</a>` : ''}`).join('');
    const tl = person.timeline.map((e) => `<div class="tl-item" id="src-${e.n}">
        <div class="tl-date">${esc(e.date)}<small>${esc(e.time)}</small></div>
        <span class="kind-icon" aria-hidden="true">${icon[e.kind]}</span>
        <div><div class="tl-title"><span class="cite">${e.n}</span>${esc(e.title)}${e.dir ? `<span class="pill neutral">${e.dir === 'in' ? 'From Alec' : 'From you'}</span>` : ''}</div><div class="tl-text">${esc(e.text)}</div></div>
      </div>`).join('');
    const t = person.counts;
    return shell('work', 'people', `
      <div class="crumbs"><a href="#/work">Work</a> / <a href="#/work/people/alec-byrne">People</a> / ${esc(p.name)}</div>
      <div class="person-head">
        ${avatar(person.id, 'lg')}
        <div><h1>${esc(p.name)}</h1><p>${esc(p.role)}, ${esc(p.org)}. ${esc(person.projects.join(', '))}.</p></div>
        <div class="actions"><button class="btn" type="button">${icon.note} Add a note</button><button class="btn" type="button">Edit</button></div>
      </div>

      <section class="grid first">
        <div class="s8" style="display:flex;flex-direction:column;gap:var(--gap)">
          <div class="panel summary">
            <div class="panel-head"><h2>Where things stand</h2></div>
            <p>${summary}</p>
            <div class="stamp">Written from ${person.summary.sources} sources at ${person.summary.updated} today. Every sentence links to its source below.</div>
          </div>
          <div class="panel">
            <div class="panel-head"><h2>Timeline</h2><span class="chip">${person.timeline.length} of ${person.totalSources}: ${t.email} emails, ${t.meeting} meetings, ${t.note} note</span><a class="end" href="#/work/people/alec-byrne">View all</a></div>
            <div class="timeline">${tl}</div>
          </div>
        </div>
        <div class="s4 side-stack">
          <div class="panel">
            <div class="panel-head"><h2>Promises</h2></div>
            ${loopsOwe.map((r) => `<div class="mini-loop"><span class="dir">You owe</span><div>${esc(r.what)}<small>${dueWords(r.due).text}, in Tasks</small></div></div>`).join('')}
            ${loopsOwed.map((r) => `<div class="mini-loop"><span class="dir">${esc(p.name.split(' ')[0])} owes</span><div>${esc(r.what)}<small>Waiting ${waitedWords(r.asked)}</small></div></div>`).join('')}
          </div>
          <div class="panel">
            <div class="panel-head"><h2>Worth knowing</h2></div>
            <div class="kv">${person.facts.map((f) => `<div class="kv-row" style="grid-template-columns:1fr auto"><dd>${esc(f.text)}</dd><a class="cite" href="#" data-src="${f.src}" aria-label="Source ${f.src}">${f.src}</a></div>`).join('')}</div>
          </div>
          <div class="panel">
            <div class="panel-head"><h2>Who ${esc(p.name.split(' ')[0])} is</h2></div>
            <dl class="kv" style="margin:0">
              ${person.identifiers.map((i) => `<div class="kv-row"><dt>${esc(i.kind)}</dt><dd>${esc(i.value)}<small>From ${esc(i.via)}${i.count ? `, ${i.count} emails` : ''}</small></dd></div>`).join('')}
              <div class="kv-row"><dt>Also called</dt><dd>${person.aliases.map(esc).join(', ')}</dd></div>
              <div class="kv-row"><dt>Keep in touch</dt><dd>Every ${person.cadence.every} ${person.cadence.unit}<small>Last contact ${esc(person.cadence.lastContact)}</small></dd></div>
            </dl>
          </div>
          <div class="panel">
            <div class="panel-head"><h2>Not the same as</h2></div>
            <div class="not-them">
              ${person.distinctFrom.map((d) => d.who
                ? `<div class="rowcard">${avatar(d.who)}<div class="main"><div class="what">${esc(people[d.who].name)}</div><div class="meta">Confirmed different on ${esc(d.confirmed)}</div></div></div>`
                : `<a class="rowcard" href="#/review"><span class="avatar none" aria-hidden="true">${icon.review}</span><div class="main"><div class="what">${esc(d.label)}</div><div class="meta">${esc(d.note)}</div></div></a>`).join('')}
            </div>
          </div>
        </div>
      </section>`);
  };

  // ---------- Who is this? ----------
  const reviewPage = () => {
    const d = review.detail;
    const cand = people[d.candidate];
    const spacePill = (sp) => `<span class="pill space-${sp}">${sp === 'work' ? 'Work' : 'Personal'}</span>`;
    const q = review.items.map((it) => `<a href="#/review" aria-current="${it.id === review.selected}">
        <span class="q-title">${esc(it.title)}</span><span class="q-when">${esc(it.when)}</span>
        <span class="q-sub" style="grid-column:1/-1">${esc(it.sub)}</span>
        <span class="q-tags"><span class="pill neutral">${esc(it.reason)}</span>${spacePill(it.space)}</span>
      </a>`).join('');
    const markDiff = (a, b) => {
      // highlight the characters where two names part ways
      let i = 0; while (i < a.length && a[i] === b[i]) i++;
      let j = 0; while (j < a.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
      return `${esc(a.slice(0, i))}<span class="diff">${esc(a.slice(i, a.length - j))}</span>${esc(a.slice(a.length - j))}`;
    };
    const rows = d.compare.map((r) => {
      const cell = (v, other) => v == null ? '<span class="dash" aria-label="none">—</span>'
        : r.field === 'Name' ? markDiff(v, other) : esc(v);
      return `<tr class="${r.differs ? 'differs' : ''}"><td>${esc(r.field)}${r.note ? `<span class="diff-note">${esc(r.note)}</span>` : ''}</td>
        <td class="v">${cell(r.a, r.b)}</td><td class="v">${cell(r.b, r.a)}</td></tr>`;
    }).join('');
    return shell(null, 'review', `
      <div class="review-title">
        <h1>Who is this?</h1>
        <p class="subline">${review.items.length} waiting from both spaces. Nothing is linked to a person until you decide here.</p>
      </div>
      <section class="grid first">
        <div class="s4"><div class="queue">${q}</div></div>
        <div class="s8" style="display:flex;flex-direction:column;gap:var(--gap)">
          <div class="panel">
            <div class="panel-head"><h2>Someone you know?</h2><span class="chip">First seen ${esc(d.firstSeen)}</span></div>
            <div class="compare-head">
              <span></span>
              <div class="who"><span class="avatar none" aria-hidden="true">?</span><div>New sender<small>${d.emails} emails received</small></div></div>
              <div class="who">${avatar(d.candidate)}<div>${esc(cand.name)}<small>Closest name in your people</small></div></div>
            </div>
            <table class="compare"><caption class="sr-only">New sender compared with ${esc(cand.name)}</caption>
              <thead class="sr-only"><tr><th>Field</th><th>New sender</th><th>${esc(cand.name)}</th></tr></thead>
              <tbody>${rows}</tbody></table>
            <div class="verdict">${esc(d.verdict)}</div>
          </div>
          <div class="panel">
            <div class="panel-head"><h2>Decide</h2><span class="actions"><button class="btn text small" type="button">Not a person</button><button class="btn text small" type="button">Decide later</button></span></div>
            <div class="decide">
              <button class="btn primary" type="button">${icon.plus} Add as a new person</button>
              <label class="sr-only" for="space">Space</label>
              <select class="select" id="space"><option selected>in Personal</option><option>in Work</option></select>
              <button class="btn" type="button">Same person as ${esc(cand.name)}</button>
            </div>
            <p class="subline" style="font-size:13px;margin-top:12px">Suggested Personal: ${esc(d.why)}</p>
          </div>
          <div class="panel">
            <div class="panel-head"><h2>Where they appeared</h2><span class="chip">${d.evidence.length} emails</span></div>
            <div class="evidence">${d.evidence.map((e) => `<div class="rowcard"><span class="kind-icon" aria-hidden="true">${icon.email}</span>
              <div class="main"><div class="what">${esc(e.title)}</div><div class="meta">${esc(e.date)}. ${esc(e.text)}</div></div></div>`).join('')}</div>
          </div>
        </div>
      </section>`);
  };

  const render = () => {
    const h = location.hash || '#/work';
    const app = document.getElementById('app');
    if (h.startsWith('#/review')) app.innerHTML = reviewPage();
    else if (h.includes('/people/')) app.innerHTML = personPage();
    else if (h.startsWith('#/personal')) app.innerHTML = today('personal');
    else app.innerHTML = today('work');
    document.title = `${document.querySelector('h1').textContent.slice(0, 40)} – Hub`;
    window.scrollTo(0, 0);
  };
  addEventListener('hashchange', render);
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-src]');
    if (!c) return;
    e.preventDefault();
    document.getElementById(`src-${c.dataset.src}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  render();
})();
