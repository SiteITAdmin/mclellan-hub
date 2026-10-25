// Sample data for the CRM design mockup. Every person, organisation and message here is invented.
// "Today" is Monday 26 October 2026, Dublin time.
window.CRM = (() => {
  const TODAY = '2026-10-26';

  // Stable identity hues: neighbours in any list sit at least 60 degrees apart.
  const people = {
    'aileen-kavanagh': { name: 'Aileen Kavanagh', initials: 'AK', hue: 205, space: 'work', org: 'Ardmore Health', role: 'Head of IT' },
    'alec-byrne':      { name: 'Alec Byrne',      initials: 'AB', hue: 25,  space: 'work', org: 'Northwall Group', role: 'Migration lead' },
    'ciaran-doyle':    { name: 'Ciarán Doyle',    initials: 'CD', hue: 140, space: 'work', org: 'Ardmore Health', role: 'Finance director' },
    'priya-nair':      { name: 'Priya Nair',      initials: 'PN', hue: 290, space: 'work', org: 'Ardmore Health', role: 'Security architect' },
    'alan-burke':      { name: 'Alan Burke',      initials: 'AB', hue: 80,  space: 'work', org: 'Ardmore Health', role: 'Vendor manager' },
    'siobhan-walsh':   { name: 'Siobhán Walsh',   initials: 'SW', hue: 330, space: 'work', org: 'Northwall Group', role: 'Comms lead' },
    'tomas-ryan':      { name: 'Tomás Ryan',      initials: 'TR', hue: 175, space: 'work', org: 'Ardmore Health', role: 'Infrastructure engineer' },
    'grainne-lynch':   { name: 'Gráinne Lynch',   initials: 'GL', hue: 250, space: 'work', org: 'Former colleague', role: '' },
    'mark-delaney':    { name: 'Mark Delaney',    initials: 'MD', hue: 40,  space: 'work', org: 'Kestrel Partners', role: 'Partner' },
    'orla-fitzgerald': { name: 'Orla Fitzgerald', initials: 'OF', hue: 160, space: 'work', org: 'Northwall Group', role: 'CIO' },

    'dad':             { name: 'Dad',             initials: 'D',  hue: 30,  space: 'personal', org: '', role: '' },
    'gemma-quinn':     { name: 'Gemma Quinn',     initials: 'GQ', hue: 320, space: 'personal', org: '', role: '' },
    'ruairi-kelly':    { name: 'Ruairí Kelly',    initials: 'RK', hue: 200, space: 'personal', org: '', role: '' },
    'sinead-moran':    { name: 'Sinéad Moran',    initials: 'SM', hue: 100, space: 'personal', org: '', role: '' },
    'declan-hayes':    { name: 'Declan Hayes',    initials: 'DH', hue: 260, space: 'personal', org: 'Hayes Plumbing', role: 'Plumber' },
    'eoin-gallagher':  { name: 'Eoin Gallagher',  initials: 'EG', hue: 15,  space: 'personal', org: '', role: '' },
    'margaret':        { name: 'Aunt Margaret',   initials: 'M',  hue: 180, space: 'personal', org: '', role: '' },
    'conor-brennan':   { name: 'Conor Brennan',   initials: 'CB', hue: 280, space: 'personal', org: '', role: '' },
  };

  const spaces = {
    work: {
      label: 'Work',
      dateLine: 'Monday 26 October',
      owe: [
        { who: 'aileen-kavanagh', what: 'Send the Intune phase 2 rollout plan', due: '2026-10-26', from: 'Email, 22 Oct', task: true },
        { who: 'ciaran-doyle', what: 'Share the E5 licence count for the renewal', due: '2026-10-26', from: 'Meeting, 23 Oct', task: true },
        { who: 'priya-nair', what: 'Review the Conditional Access draft', due: '2026-10-22', from: 'Note, 19 Oct', task: true },
        { who: 'alec-byrne', what: 'Book the cutover weekend with the service desk', due: '2026-10-30', from: 'Email, 26 Oct', task: true },
      ],
      owed: [
        { who: 'tomas-ryan', what: 'Access to the Ardmore test tenant', asked: '2026-10-17', from: 'Email, 17 Oct' },
        { who: 'alec-byrne', what: 'The wave 3 user list', asked: '2026-10-20', from: 'Email, 20 Oct' },
        { who: 'alan-burke', what: 'Revised SentinelOne renewal quote', asked: '2026-10-23', from: 'Meeting, 23 Oct' },
        { who: 'siobhan-walsh', what: 'Sign-off on the migration comms plan', asked: '2026-10-25', from: 'Email, 25 Oct' },
      ],
      agenda: {
        title: 'Meetings today',
        items: [
          { time: '09:30', what: 'Intune phase 2 check-in', with: ['aileen-kavanagh', 'alec-byrne'], note: '1 promise due to Aileen' },
          { time: '11:00', what: 'E5 renewal', with: ['ciaran-doyle', 'alan-burke'], note: 'Alan owes you a quote' },
          { time: '14:30', what: '1:1', with: ['priya-nair'], note: 'Your review is 4 days late' },
        ],
      },
      drift: [
        { who: 'grainne-lynch', every: 8, last: 13 },
        { who: 'mark-delaney', every: 6, last: 8 },
        { who: 'orla-fitzgerald', every: 4, last: 5 },
        { who: 'siobhan-walsh', every: 3, last: 4 },
      ],
      captured: [
        { kind: 'email', title: 'Wave 3: two blockers', who: 'alec-byrne', when: '08:12', state: 'ok', detail: 'Matched by email address' },
        { kind: 'report', title: 'Ardmore M365 security review v2.pdf', who: null, when: 'Yesterday 21:40', state: 'review', detail: '14 facts, 3 people. "Alan" needs a decision' },
        { kind: 'note', title: 'Ciarán: budget freeze likely in Q1', who: 'ciaran-doyle', when: 'Yesterday 17:40', state: 'ok', detail: 'Your note' },
        { kind: 'report', title: 'Scan_0042.pdf', who: null, when: 'Yesterday 16:05', state: 'unreadable', detail: 'A scanned image with no text. Upload a text version' },
      ],
    },
    personal: {
      label: 'Personal',
      dateLine: 'Monday 26 October',
      owe: [
        { who: 'gemma-quinn', what: 'Send her the photos from Lisbon', due: '2026-10-26', from: 'WhatsApp, 24 Oct', task: true },
        { who: 'dad', what: 'Order his repeat prescription at the pharmacy', due: '2026-10-28', from: 'Note, 21 Oct', task: true, project: 'Dad' },
        { who: 'ruairi-kelly', what: 'Confirm for the match on Saturday', due: '2026-10-29', from: 'WhatsApp, 25 Oct', task: true },
        { who: null, what: 'Renew the house insurance', due: '2026-10-31', from: 'Email, 12 Oct', task: true, project: 'House' },
      ],
      owed: [
        { who: 'sinead-moran', what: 'Her soda bread recipe', asked: '2026-10-14', from: 'WhatsApp, 14 Oct' },
        { who: 'declan-hayes', what: 'A quote for the boiler service', asked: '2026-10-21', from: 'Email, 21 Oct' },
      ],
      agenda: {
        title: 'Coming up',
        items: [
          { time: 'Wed', what: "Dad's GP appointment, 10:20", with: ['dad'], note: 'Bring the prescription list' },
          { time: 'Sat', what: "Ruairí's birthday", with: ['ruairi-kelly'], note: 'From Google Contacts' },
          { time: 'Sat', what: 'Match with Ruairí, 15:00', with: ['ruairi-kelly'], note: 'You still need to confirm' },
        ],
      },
      drift: [
        { who: 'eoin-gallagher', every: 6, last: 11 },
        { who: 'margaret', every: 4, last: 6 },
        { who: 'conor-brennan', every: 8, last: 9 },
        { who: 'sinead-moran', every: 3, last: 4 },
      ],
      captured: [
        { kind: 'note', title: "Dad: knee much better, walking to the shop again", who: 'dad', when: '07:55', state: 'ok', detail: 'Your note, Dad project' },
        { kind: 'email', title: 'Your prescription is ready to collect', who: null, when: 'Yesterday 12:10', state: 'ok', detail: 'Hickey’s Pharmacy. Linked to the Dad project' },
        { kind: 'message', title: 'Gemma: "did you get any of the tram?"', who: 'gemma-quinn', when: 'Saturday', state: 'ok', detail: 'Matched by phone number' },
        { kind: 'contact', title: 'Birthday added for Ruairí Kelly', who: 'ruairi-kelly', when: 'Saturday', state: 'ok', detail: 'From Google Contacts' },
      ],
    },
  };

  const person = {
    id: 'alec-byrne',
    projects: ['M365 Project'],
    identifiers: [
      { kind: 'Email', value: 'alec.byrne@northwall.ie', via: 'Gmail', count: 41 },
      { kind: 'Phone', value: '+353 87 412 6603', via: 'Google Contacts', count: 0 },
    ],
    aliases: ['Alec', 'AB'],
    distinctFrom: [
      { who: 'alan-burke', confirmed: '14 Oct', reason: 'Different organisation and email' },
      { label: 'Alex Byrne', note: 'waiting in Who is this?' },
    ],
    cadence: { every: 2, unit: 'weeks', lastContact: 'Today, 08:12' },
    summary: {
      updated: '08:20',
      sources: 6,
      text: [
        ['Alec is running wave 3 of the Northwall mailbox migration, ', 1],
        ['which covers 412 users. ', 4],
        ['This morning he flagged two blockers: 38 shared mailboxes over 50 GB, and no date yet from the service desk for the cutover weekend. ', 1],
        ['He still owes you the wave 3 user list, which you asked for on 20 Oct. ', 3],
        ['He is on leave from 9 to 13 November, ', 2],
        ['so the cutover needs booking before then.', null],
      ],
    },
    facts: [
      { text: 'On leave 9–13 Nov', src: 2 },
      { text: 'Wave 3 covers 412 users', src: 4 },
      { text: 'Prefers a Teams call before 10:00', src: 6 },
    ],
    // Most recent first. counts: the totals across all of Alec's sources.
    timeline: [
      { n: 1, kind: 'email', dir: 'in', date: 'Today', time: '08:12', title: 'Wave 3: two blockers', text: '"38 of the shared mailboxes are over 50 GB, and the service desk still hasn’t come back on the weekend of 7 Nov."' },
      { n: 5, kind: 'meeting', dir: null, date: 'Fri 23 Oct', time: '09:30', title: 'Intune phase 2 check-in', text: 'With Aileen Kavanagh. 30 min. You said you’d book the cutover weekend.' },
      { n: 2, kind: 'email', dir: 'in', date: 'Wed 21 Oct', time: '16:48', title: 'Leave dates', text: '"Heads up, I’m off 9–13 Nov."' },
      { n: 3, kind: 'email', dir: 'out', date: 'Tue 20 Oct', time: '10:02', title: 'Wave 3 user list?', text: 'You: "Can you send the final wave 3 list when you have it?"' },
      { n: 4, kind: 'email', dir: 'in', date: 'Mon 19 Oct', time: '14:30', title: 'Wave 3 scope', text: '"Final number is 412 users across 6 sites."' },
      { n: 6, kind: 'note', dir: null, date: 'Fri 2 Oct', time: '18:15', title: 'Note', text: '"Alec prefers a Teams call before 10, he’s in back-to-backs after."' },
    ],
    counts: { email: 41, meeting: 5, note: 1 },
    totalSources: 47,
  };

  const review = {
    selected: 'alex-byrne',
    items: [
      { id: 'alex-byrne', kind: 'new', title: 'Alex Byrne', sub: 'alexbyrne.photo@gmail.com', when: 'Sat 19:02', space: 'personal', reason: 'New sender' },
      { id: 'alan-mention', kind: 'mention', title: '"Alan" in a report', sub: 'Ardmore M365 security review v2.pdf, page 4', when: 'Yesterday', space: 'work', reason: 'Which Alan?' },
      { id: 'james-kearney', kind: 'new', title: 'James Kearney', sub: 'j.kearney@northwall.ie', when: 'Yesterday', space: 'work', reason: 'New sender' },
      { id: 'ardmore-it', kind: 'new', title: 'Ardmore IT Notifications', sub: 'noreply@ardmorehealth.ie', when: 'Thu', space: 'work', reason: 'Looks automated' },
    ],
    detail: {
      seenAs: 'Alex Byrne <alexbyrne.photo@gmail.com>',
      firstSeen: 'Saturday 24 October, 19:02',
      emails: 2,
      suggestedSpace: 'personal',
      why: 'A personal Gmail address, not on your work-domains list, and no thread shared with anyone in Work.',
      evidence: [
        { title: 'Lisbon prints, ready to collect', date: 'Sat 24 Oct', text: '"Hi Douglas, the six A3 prints from Lisbon are ready. I’m in the studio Tuesday and Thursday."' },
        { title: 'Invoice 2026-118', date: 'Sat 24 Oct', text: '"Attached is the invoice for the prints. Thanks again."' },
      ],
      candidate: 'alec-byrne',
      compare: [
        { field: 'Name', a: 'Alex Byrne', b: 'Alec Byrne', differs: true, note: 'One letter apart' },
        { field: 'Email', a: 'alexbyrne.photo@gmail.com', b: 'alec.byrne@northwall.ie', differs: true },
        { field: 'Phone', a: null, b: '+353 87 412 6603', differs: false },
        { field: 'Organisation', a: null, b: 'Northwall Group', differs: false },
        { field: 'Space', a: 'Personal (suggested)', b: 'Work', differs: true },
        { field: 'Threads together', a: '0', b: '0', differs: false },
      ],
      verdict: 'No shared email address, phone number or thread. The Hub will not merge these unless you say so.',
    },
  };

  // Days between two ISO dates, positive when b is after a.
  const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

  for (const [key, s] of Object.entries(spaces)) {
    for (const r of [...s.owe, ...s.owed, ...s.drift]) {
      if (r.who) console.assert(people[r.who]?.space === key, `${r.who} is listed in ${key} but belongs to ${people[r.who]?.space}`);
    }
    s.counts = {
      dueToday: s.owe.filter((r) => r.due === TODAY).length,
      overdue: s.owe.filter((r) => days(r.due, TODAY) > 0).length,
      waiting: s.owed.length,
      drifting: s.drift.filter((d) => d.last > d.every).length,
    };
  }
  const t = person.counts;
  console.assert(t.email + t.meeting + t.note === person.totalSources, 'person source counts do not add up');
  console.assert(person.identifiers[0].count === t.email, 'email identifier count differs from the email total');
  console.assert(person.timeline.length === person.summary.sources, 'summary source count differs from the timeline');
  console.assert(review.detail.evidence.length === review.detail.emails, 'evidence count differs from emails seen');

  return { TODAY, people, spaces, person, review, days };
})();
