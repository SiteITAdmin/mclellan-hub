'use strict';

// 16px outline icons for the CRM screens, one set, 1.5px stroke.
const path = d => `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

module.exports = {
  tasks: path('<circle cx="8" cy="8" r="6"/><path d="M5 8l2 2 4-4"/>'),
  today: path('<rect x="2.5" y="3" width="11" height="10.5" rx="2"/><path d="M2.5 6.5h11M5.5 1.5v3M10.5 1.5v3"/>'),
  calendar: path('<rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3M5 9.5h2.5M5 11.5h5"/>'),
  people: path('<circle cx="6" cy="5.5" r="2.5"/><path d="M1.5 13.5c.5-2.5 2.3-4 4.5-4s4 1.5 4.5 4"/><path d="M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12 9.8c1.3.6 2.2 1.9 2.5 3.7"/>'),
  projects: path('<path d="M1.5 4.5a1 1 0 0 1 1-1h3.3l1.4 1.5h6.3a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>'),
  org: path('<path d="M2.5 14V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1V14M9.5 6.5h3a1 1 0 0 1 1 1V14M1.5 14h13M5 5.5h2M5 8h2M5 10.5h2M11.5 9.5v.01M11.5 12v.01"/>'),
  captured: path('<path d="M1.5 9.5l2-6h9l2 6v3a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/><path d="M1.5 9.5h4l1 1.5h3l1-1.5h4"/>'),
  meeting: path('<rect x="1.5" y="4" width="9" height="8" rx="1.5"/><path d="M10.5 7l4-2.5v7l-4-2.5"/>'),
  search: path('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3.5 3.5"/>'),
  review: path('<circle cx="6.5" cy="5.5" r="2.5"/><path d="M2 13.5c.5-2.4 2.2-4 4.5-4 1 0 1.9.3 2.6.8"/><path d="M11 9.3a1.6 1.6 0 1 1 1.9 1.6c-.4.1-.4.4-.4.8M12.5 13.4v.1"/>'),
  plus: path('<path d="M8 3v10M3 8h10"/>'),
  email: path('<rect x="1.5" y="3" width="13" height="10" rx="1.5"/><path d="M2 4l6 5 6-5"/>'),
  whatsapp: path('<path d="M2.5 13.5l.9-2.6A5.5 5.5 0 1 1 5.6 13z"/>'),
  note: path('<path d="M10.5 2.5l3 3-8 8H2.5v-3z"/>'),
  report: path('<path d="M4 1.5h5l3.5 3.5v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1z"/><path d="M9 1.5v3.5h3.5M5.5 9h5M5.5 11.5h3"/>'),
  menu: path('<path d="M2 4.5h12M2 8h12M2 11.5h12"/>'),
  grid: path('<rect x="2" y="2" width="4.8" height="4.8" rx="1"/><rect x="9.2" y="2" width="4.8" height="4.8" rx="1"/><rect x="2" y="9.2" width="4.8" height="4.8" rx="1"/><rect x="9.2" y="9.2" width="4.8" height="4.8" rx="1"/>'),
  filter: path('<path d="M2.5 4h11M4.5 8h7M6.5 12h3"/>'),
  close: path('<path d="M4 4l8 8M12 4l-8 8"/>'),
  inbox: path('<path d="M2 9.5l1.8-6h8.4l1.8 6v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M2 9.5h3.5l1.2 1.8h2.6l1.2-1.8H14"/>'),
  settings: path('<circle cx="8" cy="8" r="2.2"/><path d="M8 2v1.6M8 12.4V14M2 8h1.6M12.4 8H14M3.8 3.8l1.1 1.1M11.1 11.1l1.1 1.1M12.2 3.8l-1.1 1.1M4.9 11.1l-1.1 1.1"/>'),
  briefing: path('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M5 5.5h6M5 8.5h6M5 11h3.5"/>'),
  money: path('<circle cx="8" cy="8" r="6"/><path d="M10 5.8a2.8 2.8 0 1 0 0 4.4M5 7.2h3.5M5 8.8h3.2"/>'),
  house: path('<path d="M2 7.5L8 2.5l6 5"/><path d="M3.5 6.8V13.5h9V6.8M6.5 13.5V9.5h3v4"/>'),
  mark: '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M11 2a9 9 0 0 0 0 18z" fill="var(--accent)"/><path d="M11 2.75a8.25 8.25 0 0 1 0 16.5" fill="none" stroke="var(--accent)" stroke-width="1.5"/></svg>',
};
