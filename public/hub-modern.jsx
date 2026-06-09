// Modernized McLellan Hub chat — real data, real SSE streaming
// All mock data replaced with window.HUB_DATA injected from chat.ejs

const HUB = window.HUB_DATA || {};

// ── Data from server ───────────────────────────────────────────────────────
// Map availableModels (grouped) to the internal format { group, options[] }
// Strip image-tier models — they don't work in chat
const MODELS = (HUB.availableModels || [])
  .map(g => ({
    group: g.label,
    options: (g.models || [])
      .filter(m => m.tier !== 'image')
      .map(m => ({
        key: m.key,
        label: m.label,
        endpoint: m.endpoint || null,
        tier: m.tier,
        search: m.search || 'none',
        category: m.category || null,
        costInput: m.costInput || null,
        costOutput: m.costOutput || null,
        contextLength: m.contextLength || null,
      })),
  }))
  .filter(g => g.options.length > 0);

// Flat list of all models for the card grid (deduplicated by key)
const ALL_MODELS_FLAT = [];
const _seen = new Set();
MODELS.forEach(g => g.options.forEach(m => { if (!_seen.has(m.key)) { _seen.add(m.key); ALL_MODELS_FLAT.push(m); } }));

// Flat model key → label lookup (built once from MODELS)
const MODEL_LABELS = {};
MODELS.forEach(g => g.options.forEach(m => { MODEL_LABELS[m.key] = m.label; }));
function modelLabel(key) { return MODEL_LABELS[key] || key || null; }

// Normalise DB messages to UI shape
const INITIAL_MESSAGES = (HUB.messages || []).map(m => ({
  id: m.id,
  role: m.role,
  content: m.content,
  model: m.model,
  cost: m.cost_usd != null ? Number(m.cost_usd).toFixed(4) : null,
  searchUsed: !!m.search_used,
}));

// ── Markdown helpers ───────────────────────────────────────────────────────
function safeHref(href) {
  try {
    const url = new URL(href, window.location.origin);
    if (['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return url.href;
  } catch (_) {}
  return null;
}

function markdownToHtml(src) {
  const text = String(src || '');
  if (typeof marked === 'undefined') {
    return { __html: '<p>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>' };
  }
  const html = marked.parse(text);
  const t = document.createElement('template');
  t.innerHTML = html;
  t.content.querySelectorAll('script,iframe,object,embed,link,meta,style').forEach(el => el.remove());
  t.content.querySelectorAll('*').forEach(el => {
    [...el.attributes].forEach(a => { if (/^on/i.test(a.name)) el.removeAttribute(a.name); });
  });
  t.content.querySelectorAll('a').forEach(a => {
    const href = safeHref(a.getAttribute('href') || '');
    if (href) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else {
      a.removeAttribute('href');
    }
  });
  return { __html: t.innerHTML };
}

// ── Icons ──────────────────────────────────────────────────────────────────
const ICON_PATHS = {
  plus: 'M12 5v14M5 12h14',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  settings: 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
  paperclip: 'M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  chevron: 'M6 9l6 6 6-6',
  menu: 'M3 6h18M3 12h18M3 18h18',
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  shield: 'M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6z',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  copy: 'M9 9h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01L12 2z',
  sparkle: 'M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1',
  panelLeft: 'M3 3h18v18H3zM9 3v18',
  stop: 'M18 6H6v12h12V6z',
  mic: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8',
  people: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm14 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  x: 'M18 6L6 18M6 6l12 12',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
};

const Icon = ({ name, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={ICON_PATHS[name] || ''} />
  </svg>
);

// ── New Project Modal ──────────────────────────────────────────────────────
function NewProjectModal({ onClose }) {
  const [name, setName] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    if (!name.trim()) { setStatus('Enter a project name.'); return; }
    setBusy(true);
    setStatus('Creating…');
    try {
      const r = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const d = await r.json();
      if (!r.ok) { setStatus('✖ ' + (d.error || 'Failed')); setBusy(false); return; }
      window.location.href = '/p/' + d.project.slug;
    } catch (err) { setStatus('✖ ' + err.message); setBusy(false); }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 16, padding: 24, width: 360, maxWidth: '90vw' }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 600 }}>New project</h3>
        <p style={{ color: 'var(--text-3)', fontSize: 13, margin: '0 0 16px' }}>Give it a name — slug is generated automatically.</p>
        <input
          autoFocus
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="e.g. Client Research"
          style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14, boxSizing: 'border-box', outline: 'none' }}
        />
        {status && <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 8 }}>{status}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '7px 16px', borderRadius: 8, border: '1px solid var(--line)', background: 'none', color: 'var(--text)', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
          <button onClick={submit} disabled={busy} style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 14, opacity: busy ? 0.7 : 1 }}>Create</button>
        </div>
      </div>
    </div>
  );
}

// ── Recent conversations (grouped) ────────────────────────────────────────
function groupConvs(convs) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const start7Days   = startOfToday - 6 * 86400000;

  const groups = { Today: [], 'Previous 7 days': [], Older: [] };
  let total = 0;
  for (const c of convs) {
    if (total >= 10) break;
    const t = new Date(c.created_at).getTime();
    if (t >= startOfToday)  groups['Today'].push(c);
    else if (t >= start7Days) groups['Previous 7 days'].push(c);
    else                      groups['Older'].push(c);
    total++;
  }
  return groups;
}

function RecentConvs({ convs, activeConvId }) {
  const groups = groupConvs(convs);
  const hasAny = Object.values(groups).some(g => g.length > 0);
  if (!hasAny) return null;

  return (
    <div className="sb-recent">
      {Object.entries(groups).map(([label, items]) => items.length === 0 ? null : (
        <div key={label} className="sb-recent-group">
          <div className="sb-recent-head">{label}</div>
          {items.map(c => (
            <button
              key={c.id}
              className={'sb-recent-row ' + (activeConvId === c.id ? 'is-active' : '')}
              onClick={() => window.location.href = '/c/' + c.id}
            >
              <span className="sb-recent-title">{c.title || 'Untitled'}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Project Docs Panel ─────────────────────────────────────────────────────
function ProjectDocs({ slug }) {
  const [docs, setDocs] = React.useState(HUB.projectDocs || []);
  const [uploading, setUploading] = React.useState(false);
  const [msg, setMsg] = React.useState('');
  const [wikiStatus, setWikiStatus] = React.useState({}); // docId → { loading, slug, error }
  const [dragOver, setDragOver] = React.useState(false);
  const [toWiki, setToWiki] = React.useState(false);
  const fileRef = React.useRef(null);

  async function doUpload(file, sendToWiki) {
    if (!file) return;
    setUploading(true);
    setMsg(`Uploading ${file.name}…`);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('projectSlug', slug);
    if (sendToWiki) fd.append('toWiki', '1');
    try {
      const r = await fetch('/api/upload', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' }, body: fd });
      const d = await r.json();
      if (d.ok) {
        const newDoc = { id: d.document.id, filename: d.document.filename, size_bytes: d.document.size };
        setDocs(prev => [newDoc, ...prev]);
        if (d.wiki?.slug) {
          setWikiStatus(prev => ({ ...prev, [d.document.id]: { slug: d.wiki.slug, title: d.wiki.title } }));
          setMsg(`Saved + wiki page created: ${d.wiki.title}`);
        } else if (d.wiki?.error) {
          setMsg(`Saved. Wiki failed: ${d.wiki.error}`);
        } else {
          setMsg('');
        }
      } else {
        setMsg(d.error || 'Upload failed');
      }
    } catch { setMsg('Upload failed'); }
    setUploading(false);
  }

  function onFileChange(e) {
    const file = e.target.files[0];
    doUpload(file, toWiki);
    e.target.value = '';
  }

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) doUpload(file, toWiki);
  }

  async function del(id) {
    if (!confirm('Remove this document?')) return;
    const r = await fetch('/api/documents/' + id + '/delete', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    const d = await r.json();
    if (d.ok) { setDocs(prev => prev.filter(x => x.id !== id)); setWikiStatus(prev => { const n = {...prev}; delete n[id]; return n; }); }
  }

  async function sendToWikiNow(doc) {
    setWikiStatus(prev => ({ ...prev, [doc.id]: { loading: true } }));
    try {
      const r = await fetch('/api/documents/' + doc.id + '/to-wiki', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      const d = await r.json();
      if (d.ok) setWikiStatus(prev => ({ ...prev, [doc.id]: { slug: d.slug, title: d.title } }));
      else setWikiStatus(prev => ({ ...prev, [doc.id]: { error: d.error } }));
    } catch { setWikiStatus(prev => ({ ...prev, [doc.id]: { error: 'Failed' } })); }
  }

  const ACCEPT = '.pdf,.txt,.md,.docx,.csv,.json,.pptx,.xlsx,.png,.jpg,.jpeg,.gif,.webp';

  return (
    <div className="sb-docs">
      <div className="sb-section-head">
        <span>Project docs</span>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button
            title={toWiki ? 'Also adding to wiki — click to toggle off' : 'Click to also add to wiki on upload'}
            onClick={() => setToWiki(v => !v)}
            style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: toWiki ? 'var(--accent, #4648d4)' : 'transparent', color: toWiki ? '#fff' : 'var(--text-3)', border: '1px solid currentColor', lineHeight: 1.4, cursor: 'pointer' }}
          >wiki</button>
          <button title="Upload document or image" onClick={() => fileRef.current?.click()} disabled={uploading}>
            <Icon name="plus" size={14} />
          </button>
        </div>
      </div>
      <input ref={fileRef} type="file" accept={ACCEPT} style={{ display: 'none' }} onChange={onFileChange} />
      {msg && <div style={{ fontSize: 11, color: 'var(--text-3)', padding: '2px 8px 6px', lineHeight: 1.4 }}>{msg}</div>}

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        style={{ margin: '0 8px 6px', borderRadius: 6, border: `1px dashed ${dragOver ? 'var(--accent, #4648d4)' : 'var(--border, #e0e0e0)'}`, background: dragOver ? 'var(--accent-faint, #f0f0ff)' : 'transparent', padding: '6px 8px', fontSize: 11, color: 'var(--text-3)', textAlign: 'center', cursor: 'pointer', transition: 'all .15s' }}
        onClick={() => fileRef.current?.click()}
      >
        {uploading ? 'Uploading…' : 'Drop file or click'}
        {toWiki && <span style={{ marginLeft: 4, color: 'var(--accent, #4648d4)' }}>+ wiki</span>}
      </div>

      {docs.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '2px 8px 8px' }}>No docs yet</div>
      ) : (
        <div className="sb-list">
          {docs.map(doc => {
            const ws = wikiStatus[doc.id];
            return (
              <div key={doc.id} className="sb-doc-row" style={{ flexWrap: 'wrap', gap: '2px 0' }}>
                <Icon name="file" size={13} />
                <span className="sb-doc-name" title={doc.filename}>{doc.filename}</span>
                <div style={{ display: 'flex', gap: 3, marginLeft: 'auto' }}>
                  {ws?.slug ? (
                    <a href={`https://wiki.mclellan.scot/page/${ws.slug}`} target="_blank" rel="noreferrer"
                      title={`Wiki: ${ws.title}`} style={{ fontSize: 10, color: 'var(--accent, #4648d4)', textDecoration: 'none' }}>wiki↗</a>
                  ) : (
                    <button title="Save to wiki" onClick={() => sendToWikiNow(doc)} disabled={ws?.loading}
                      style={{ fontSize: 10, padding: '1px 4px', borderRadius: 3, background: 'transparent', color: 'var(--text-3)', border: '1px solid var(--border)', cursor: 'pointer', lineHeight: 1.4 }}>
                      {ws?.loading ? '…' : ws?.error ? '⚠' : '→wiki'}
                    </button>
                  )}
                  <button className="sb-doc-del" title="Remove" onClick={() => del(doc.id)}>×</button>
                </div>
                {ws?.error && <div style={{ width: '100%', fontSize: 10, color: 'var(--error, #c00)', paddingLeft: 20 }}>{ws.error}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Sidebar ────────────────────────────────────────────────────────────────
function Sidebar({ collapsed, setCollapsed, mobileOpen, setMobileOpen }) {
  const [hovered, setHovered] = React.useState(false);
  const [showNewProj, setShowNewProj] = React.useState(false);
  const [projectsOpen, setProjectsOpen] = React.useState(true);
  const [recentsOpen, setRecentsOpen] = React.useState(true);
  const expanded = !collapsed || hovered || mobileOpen;
  const W = expanded ? 264 : 64;

  const projects = HUB.projects || [];
  const convs = HUB.recentConvs || [];
  const activeSlug = window.PROJECT_SLUG;
  const activeConvId = window.CONV_ID;
  const userInitial = (HUB.user || 'D').charAt(0).toUpperCase();

  return (
    <>
      <aside
        className="hub-sidebar"
        data-expanded={expanded}
        data-mobile-open={mobileOpen}
        onMouseEnter={() => collapsed && setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ width: W }}
      >
        <div className="sb-top">
          <button className="sb-logo" title="McLellan Hub" onClick={() => window.location.href = '/'}>
            <span className="sb-logo-mark">M</span>
            {expanded && <span className="sb-logo-text">McLellan Hub</span>}
          </button>
          <button className="sb-collapse" onClick={() => { setCollapsed(c => !c); setMobileOpen(false); }} title={collapsed ? 'Expand' : 'Collapse'}>
            <Icon name="panelLeft" size={16} />
          </button>
        </div>

        <button className="sb-new" onClick={() => window.location.href = '/c'}>
          <Icon name="edit" size={16} />
          {expanded && <span>New chat</span>}
        </button>

        {expanded && (
          <div className="sb-search">
            <Icon name="search" size={14} />
            <input placeholder="Search…" onKeyDown={e => { if (e.key === 'Enter' && e.target.value.trim()) window.location.href = '/c?q=' + encodeURIComponent(e.target.value.trim()); }} />
          </div>
        )}

        <nav className="sb-nav">
          <SbItem icon="chat" label="Chats" expanded={expanded} active={!activeSlug} onClick={() => window.location.href = '/c'} />
          <SbItem icon="people" label="People" expanded={expanded} onClick={() => window.location.href = '/crm'} />
          <SbItem icon="sparkle" label="Content" expanded={expanded} onClick={() => window.location.href = '/lin'} />
          <SbItem icon="edit" label="Tasks" expanded={expanded} onClick={() => window.location.href = '/crm/tasks'} />
          <SbItem icon="mic" label="Debrief" expanded={expanded} onClick={() => window.location.href = '/debrief'} />
          <SbItem icon="file" label="Intelligence" expanded={expanded} onClick={() => window.location.href = '/newsletter'} />
          <SbItem icon="settings" label="Admin" expanded={expanded} onClick={() => window.location.href = '/admin'} />
        </nav>

        {expanded && projects.length > 0 && (
          <>
            <div className="sb-section-head sb-section-toggle" onClick={() => setProjectsOpen(o => !o)} style={{ cursor: 'pointer' }}>
              <span>Projects</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button title="New project" onClick={e => { e.stopPropagation(); setShowNewProj(true); }}><Icon name="plus" size={14} /></button>
                <span style={{ display: 'inline-flex', transition: 'transform 0.15s', transform: projectsOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}><Icon name="chevron" size={14} /></span>
              </div>
            </div>
            {projectsOpen && (
              <div className="sb-list">
                {projects.map(p => (
                  <button
                    key={p.slug}
                    className={'sb-row sb-project ' + (activeSlug === p.slug ? 'is-active' : '')}
                    onClick={() => window.location.href = '/p/' + p.slug}
                  >
                    <span className="sb-row-label">/{p.slug}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {expanded && activeSlug && projectsOpen && <ProjectDocs slug={activeSlug} />}

        {expanded && convs.length > 0 && (
          <div className="sb-section-head sb-section-toggle" onClick={() => setRecentsOpen(o => !o)} style={{ cursor: 'pointer' }}>
            <span>Recent chats</span>
            <span style={{ display: 'inline-flex', transition: 'transform 0.15s', transform: recentsOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}><Icon name="chevron" size={14} /></span>
          </div>
        )}
        {expanded && recentsOpen && <RecentConvs convs={convs} activeConvId={activeConvId} />}

        <div className="sb-foot">
          <div className="sb-foot-row" style={{ cursor: 'default' }}>
            <span className="sb-avatar">{userInitial}</span>
            {expanded && (
              <>
                <span className="sb-foot-name">{HUB.user} <span className="sb-foot-sub">dchat.mclellan.scot</span></span>
                <button
                  title="Tweaks / appearance"
                  onClick={() => window.postMessage({ type: '__activate_edit_mode' }, '*')}
                  style={{ background: 'none', border: 'none', padding: 4, cursor: 'pointer', color: 'var(--text-3)', borderRadius: 6, display: 'flex', alignItems: 'center' }}
                >
                  <Icon name="settings" size={15} />
                </button>
                <button
                  title="Sign out"
                  onClick={async () => { await fetch('/logout', { method: 'POST' }); window.location.href = '/'; }}
                  style={{ background: 'none', border: 'none', padding: '4px 6px', cursor: 'pointer', color: 'var(--text-3)', borderRadius: 6, fontSize: 11, whiteSpace: 'nowrap' }}
                >
                  Sign out
                </button>
              </>
            )}
          </div>
        </div>
      </aside>

      {mobileOpen && <div className="sb-scrim" onClick={() => setMobileOpen(false)} />}
      {showNewProj && <NewProjectModal onClose={() => setShowNewProj(false)} />}
    </>
  );
}

const SbItem = ({ icon, label, expanded, active, onClick }) => (
  <button className={'sb-row sb-nav-row ' + (active ? 'is-active' : '')} onClick={onClick}>
    <Icon name={icon} size={16} />
    {expanded && <span>{label}</span>}
  </button>
);

// ── Model card picker ──────────────────────────────────────────────────────
const SEARCH_BADGE = {
  native:     { label: 'native search', cls: 'hb-mc-native' },
  'web-plugin': { label: 'Brave Search',  cls: 'hb-mc-plugin' },
  orchestrated: { label: 'multi-search', cls: 'hb-mc-orchestrated' },
  none:       { label: null,            cls: null },
};

function fmtCost(v) {
  if (v == null) return null;
  const n = parseFloat(v);
  if (n === 0) return 'free';
  return '$' + n.toFixed(n < 0.1 ? 4 : 2) + '/M';
}

function ModelCard({ m, active, onClick }) {
  const srch = SEARCH_BADGE[m.search] || SEARCH_BADGE.none;
  const costIn  = fmtCost(m.costInput);
  const costOut = fmtCost(m.costOutput);
  const ctx     = m.contextLength ? Math.round(m.contextLength / 1000) + 'k' : null;
  return (
    <button
      className={'hb-mc' + (active ? ' is-active' : '')}
      onClick={onClick}
    >
      <div className="hb-mc-top">
        <span className="hb-mc-name">{m.label}</span>
        <div className="hb-mc-badges">
          {m.category && <span className="hb-mc-badge hb-mc-cat">{m.category}</span>}
          {srch.label && <span className={'hb-mc-badge ' + srch.cls}>{srch.label}</span>}
        </div>
      </div>
      {(costIn || costOut || ctx) && (
        <div className="hb-mc-meta">
          {costIn  && <span>in {costIn}</span>}
          {costOut && <span>out {costOut}</span>}
          {ctx     && <span>{ctx} ctx</span>}
        </div>
      )}
    </button>
  );
}

function ModelPicker({ model, onSelect, onClose }) {
  const [filter, setFilter] = React.useState('');
  const ref = React.useRef(null);

  // Group by category, fallback to tier label
  const groups = React.useMemo(() => {
    const q = filter.toLowerCase().trim();
    const filtered = q
      ? ALL_MODELS_FLAT.filter(m => m.label.toLowerCase().includes(q) || (m.category || '').toLowerCase().includes(q))
      : ALL_MODELS_FLAT;
    const map = {};
    filtered.forEach(m => {
      const grp = m.category || MODELS.find(g => g.options.some(o => o.key === m.key))?.group || 'Other';
      (map[grp] ||= []).push(m);
    });
    return map;
  }, [filter]);

  // Close on outside click
  React.useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const picker = (
    <>
      <button className="hb-model-scrim" onClick={onClose} aria-label="Close model picker" />
      <div className="hb-model-pop hb-model-cards-pop" ref={ref} role="dialog" aria-label="Choose model">
        <div className="hb-model-sheet-head">
          <strong>Choose model</strong>
          <button type="button" onClick={onClose} aria-label="Close model picker">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="hb-mc-search-row">
          <input
            className="hb-mc-search"
            type="search"
            placeholder="Filter models…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
        </div>
        <div className="hb-mc-scroll">
          {Object.entries(groups).map(([grp, models]) => (
            <div key={grp} className="hb-mc-group">
              <div className="hb-mc-group-label">{grp}</div>
              <div className="hb-mc-grid">
                {models.map(m => (
                  <ModelCard
                    key={m.key}
                    m={m}
                    active={model?.key === m.key}
                    onClick={() => { onSelect(m); onClose(); }}
                  />
                ))}
              </div>
            </div>
          ))}
          {Object.keys(groups).length === 0 && (
            <div style={{ padding: '20px', color: 'var(--text-3)', fontSize: 13, textAlign: 'center' }}>No models match</div>
          )}
        </div>
        <a className="hb-model-foot" href="/admin/models">
          <Icon name="settings" size={13} /> Manage models
        </a>
      </div>
    </>
  );

  // Keep the fixed mobile sheet outside the sticky, backdrop-filtered header.
  // iOS Safari otherwise treats that header as the sheet's containing block.
  return ReactDOM.createPortal(
    picker,
    document.querySelector('.hub-shell') || document.body
  );
}

// ── Header ─────────────────────────────────────────────────────────────────
function ChatHeader({ model, setModel, onMenu }) {
  const [open, setOpen] = React.useState(false);
  const conv = HUB.conv;
  const project = HUB.activeProject;
  const title = project ? '/' + project.slug : (conv?.title || 'New chat');
  const subtitle = project ? project.name : null;

  return (
    <header className="hub-header">
      <button className="hb-menu" onClick={onMenu} aria-label="Menu">
        <Icon name="menu" size={20} />
      </button>
      <div className="hb-title">
        <h1>{title}</h1>
        {subtitle && <span className="hb-sub">{subtitle}</span>}
      </div>

      <div className="hb-model">
        <button className="hb-model-btn" onClick={() => setOpen(o => !o)}>
          <span className="hb-model-dot" />
          <span className="hb-model-name">{model?.label || '—'}</span>
          <Icon name="chevron" size={14} />
        </button>
        {open && (
          <ModelPicker
            model={model}
            onSelect={setModel}
            onClose={() => setOpen(false)}
          />
        )}
      </div>
    </header>
  );
}

// ── Messages ──────────────────────────────────────────────────────────────
function MessageUser({ content }) {
  return (
    <div className="msg msg-user">
      <div className="msg-bubble">{content}</div>
    </div>
  );
}

// ── Save to wiki ─────────────────────────────────────────────────────────────
function SaveToWiki({ msgId }) {
  if (!msgId) return null;
  const [state, setState] = React.useState('idle'); // idle | saving | done | error
  const [slug,  setSlug]  = React.useState(null);

  if (state === 'done') return (
    <a className="save-proj-done" href={`https://wiki.mclellan.scot/page/${encodeURIComponent(slug)}`} target="_blank" rel="noopener noreferrer">
      ✓ wiki/{slug} ↗
    </a>
  );
  if (state === 'error') return <span className="save-proj-done" style={{ color: 'var(--error)' }}>wiki save failed</span>;

  async function save() {
    setState('saving');
    try {
      const r = await fetch('/api/wiki/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ msgId }),
      });
      const d = await r.json();
      if (d.ok) { setSlug(d.slug); setState('done'); }
      else setState('error');
    } catch { setState('error'); }
  }

  return (
    <button onClick={save} disabled={state === 'saving'} title="Save to wiki">
      <Icon name="sparkle" size={14} />{state === 'saving' ? '…' : '→ Wiki'}
    </button>
  );
}

// ── Save-to-project dropdown ──────────────────────────────────────────────
function SaveToProject({ msgId }) {
  const projects = HUB.projects || [];
  if (!projects.length || !msgId) return null;

  const [open, setOpen]     = React.useState(false);
  const [saved, setSaved]   = React.useState(null); // slug saved to
  const [saving, setSaving] = React.useState(false);
  const ref = React.useRef(null);

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (saved) return (
    <span className="save-proj-done">✓ saved to /{saved}</span>
  );

  async function save(slug) {
    setOpen(false);
    setSaving(true);
    try {
      const r = await fetch(`/api/messages/${msgId}/save-to-project`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ projectSlug: slug }),
      });
      const d = await r.json();
      if (d.ok) setSaved(slug);
    } catch {}
    setSaving(false);
  }

  return (
    <div className="save-proj-wrap" ref={ref}>
      <button className="save-proj-btn" onClick={() => setOpen(o => !o)} disabled={saving}>
        {saving ? '…' : '+ project'}
      </button>
      {open && (
        <div className="save-proj-pop">
          {projects.map(p => (
            <button key={p.slug} onClick={() => save(p.slug)}>/{p.slug}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageAssistant({ content, model, cost, searchUsed, id: msgId, isStreaming, error }) {
  const [copied, setCopied] = React.useState(false);
  const proseRef = React.useRef(null);

  const copy = () => {
    navigator.clipboard?.writeText(content || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const exportMsg = async (format) => {
    if (!msgId) return;
    const slug = window.PROJECT_SLUG || 'chat';
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${slug}-${date}`;
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgId, format, filename }),
      });
      if (format === 'gdoc') {
        const { url } = await res.json();
        window.open(url, '_blank');
      } else {
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${filename}.${format}`;
        a.click();
      }
    } catch (err) {
      console.error('[export]', err);
    }
  };

  // Run hljs on code blocks after content changes
  React.useEffect(() => {
    if (!proseRef.current || typeof hljs === 'undefined') return;
    proseRef.current.querySelectorAll('pre code:not([data-highlighted])').forEach(b => {
      hljs.highlightElement(b);
    });
  }, [content]);

  return (
    <div className="msg msg-asst">
      <div className="msg-avatar"><Icon name="sparkle" size={14} /></div>
      <div className="msg-body">
        {error ? (
          <div className="msg-prose" style={{ color: 'var(--text-3)', fontStyle: 'italic', fontSize: 14 }}>
            ⚠ {error}
          </div>
        ) : (
          <div className="msg-prose" dangerouslySetInnerHTML={markdownToHtml(content)} ref={proseRef} />
        )}
        {!isStreaming && !error && (
          <div className="msg-meta">
            {model && <span className="meta-chip">{modelLabel(model)}</span>}
            {searchUsed && <span className="meta-chip meta-chip-ok">web search</span>}
            {cost && <span className="meta-chip meta-mono">${cost}</span>}
            <div className="msg-actions">
              <button title="Copy" onClick={copy}>
                <Icon name={copied ? 'star' : 'copy'} size={14} />{copied ? 'Copied' : 'Copy'}
              </button>
              {msgId && (
                <>
                  <div className="msg-actions-sep" />
                  <button className="msg-act-secondary" title="Download Word" onClick={() => exportMsg('docx')}>
                    <Icon name="download" size={13} />Word
                  </button>
                  <button className="msg-act-secondary" title="Export PDF" onClick={() => exportMsg('pdf')}>
                    <Icon name="download" size={13} />PDF
                  </button>
                  <button className="msg-act-secondary" title="Open in Google Doc" onClick={() => exportMsg('gdoc')}>
                    <Icon name="sparkle" size={13} />GDoc
                  </button>
                  <div className="msg-actions-sep" />
                  <SaveToProject msgId={msgId} />
                  <SaveToWiki msgId={msgId} />
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingRow() {
  return (
    <div className="msg msg-asst">
      <div className="msg-avatar"><Icon name="sparkle" size={14} /></div>
      <div className="msg-body">
        <div className="thinking-dots"><span /><span /><span /></div>
      </div>
    </div>
  );
}

// ── Model shortcuts for empty state ───────────────────────────────────────
function findModel(predicate) {
  for (const g of MODELS) {
    for (const m of g.options) {
      if (predicate(m, g)) return m;
    }
  }
  return null;
}

function buildShortcuts() {
  const multiSearchModel =
    findModel(m => m.endpoint === 'multi-search') ||
    findModel(m => m.key === 'multi-search');

  // Use admin-configured shortcuts if available
  const configured = (HUB.shortcuts || [])
    .map(s => {
      const model = ALL_MODELS_FLAT.find(m => m.key === s.model_key);
      if (!model) return null;
      return {
        kicker: s.kicker,
        icon: s.icon || '◎',
        label: s.label,
        desc: s.desc || model.label,
        model,
        searchOverride: s.search || null,
      };
    })
    .filter(Boolean);

  if (configured.length > 0) {
    if (multiSearchModel && !configured.some(s => s.model?.key === multiSearchModel.key)) {
      configured.unshift({
        kicker: 'Deep research',
        icon: '⌖',
        label: 'Multi-search',
        desc: 'Plans several searches, gathers sources, then synthesises a cited report',
        model: multiSearchModel,
        searchOverride: null,
      });
    }
    return configured;
  }

  // Fallback: auto-derive from available models
  const freeModel =
    findModel(m => m.key === 'grok-fast') ||
    findModel(m => m.key === 'mistral-small') ||
    findModel(m => m.key === 'mimo-flash') ||
    findModel((m, g) => g.group.toLowerCase().includes('everyday')) ||
    MODELS[0]?.options[0];

  const researchModel =
    multiSearchModel ||
    findModel(m => m.key === 'gemini-25-pro') ||
    findModel(m => m.key === 'claude-sonnet') ||
    findModel(m => m.key === 'deepseek-v3') ||
    findModel(m => m.search && !m.key.toLowerCase().includes('sonar'));

  const sonarModel =
    findModel(m => m.key === 'sonar') ||
    findModel(m => m.key.toLowerCase().includes('sonar'));

  return [
    { kicker: 'Free',     label: 'Free model',    desc: freeModel     ? freeModel.label : 'Fast, no cost',          icon: '◎', model: freeModel,     searchOverride: null },
    { kicker: 'Research', label: multiSearchModel ? 'Multi-search' : 'Live research', desc: multiSearchModel ? 'Plans several searches, gathers sources, then synthesises a cited report' : (researchModel ? researchModel.label + ' + web' : 'Web search enabled'), icon: '⌖', model: researchModel, searchOverride: null },
    { kicker: 'Sonar',    label: 'Sonar search',  desc: sonarModel    ? sonarModel.label : 'Perplexity deep search', icon: '◉', model: sonarModel,    searchOverride: null },
  ].filter(s => s.model);
}

// ── Empty state ───────────────────────────────────────────────────────────
function EmptyState({ onSelectModel, onSelectShortcut }) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const rawName = HUB.user || 'Douglas';
  const name = rawName.charAt(0).toUpperCase() + rawName.slice(1);

  const shortcuts = React.useMemo(() => buildShortcuts(), []);

  return (
    <div className="empty">
      <div className="empty-mark">
        <span className="empty-glyph">M</span>
      </div>
      <h2>{greeting}, {name}.</h2>
      <p>Choose a mode to start, or just type below.</p>
      <div className="empty-grid">
        {shortcuts.map((s, i) => (
          <button key={i} className="empty-card" onClick={() => onSelectShortcut(s.model, s.searchOverride)}>
            <span className="empty-kicker">{s.icon} {s.kicker}</span>
            <span className="empty-text" style={{ fontWeight: 600, fontSize: 14 }}>{s.label}</span>
            <span className="empty-text" style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>{s.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Composer ──────────────────────────────────────────────────────────────
const PHASE_LABELS = { thinking: 'Thinking…', searching: 'Searching…', drafting: 'Drafting…', writing: 'Writing…' };

function Composer({ onSend, onStop, model, streaming, streamPhase, textareaRef: externalRef, searchOverride, clearSearchOverride }) {
  const [val, setVal] = React.useState('');
  const [more, setMore] = React.useState(false);
  const [uploadStatus, setUploadStatus] = React.useState('');
  const [opts, setOpts] = React.useState({
    sensitive: false,
    research: false,
    search: 'openrouter',
    depth: 'medium',
  });

  // Apply shortcut search override when set from welcome screen
  React.useEffect(() => {
    if (!searchOverride) return;
    setOpts(o => ({ ...o, search: searchOverride }));
    clearSearchOverride?.();
  }, [searchOverride]);

  const isPerplexityModel = key => /sonar|perplexity/i.test(key || '');

  // Auto-adjust search provider when model changes
  const prevModelKey = React.useRef(model?.key);
  React.useEffect(() => {
    if (model?.key === prevModelKey.current) return;
    prevModelKey.current = model?.key;
    setOpts(o => {
      if (o.sensitive) return o;
      if (isPerplexityModel(model?.key)) return { ...o, search: 'off' };
      if (model?.search === 'native') return { ...o, search: 'exa' };
      if (o.search === 'exa') return { ...o, search: 'openrouter' };
      return o;
    });
  }, [model?.key]);

  const internalRef = React.useRef(null);
  const textRef = externalRef || internalRef;
  const fileRef = React.useRef(null);

  // ── Journal recorder ────────────────────────────────────────────────────────
  const [recState, setRecState] = React.useState('idle'); // idle | recording | uploading | done | error
  const [recSecs, setRecSecs] = React.useState(0);
  const mediaRecRef = React.useRef(null);
  const chunksRef = React.useRef([]);
  const timerRef = React.useRef(null);
  const wakeLockRef = React.useRef(null);

  const recLabel = recState === 'recording'
    ? `${String(Math.floor(recSecs / 60)).padStart(2, '0')}:${String(recSecs % 60).padStart(2, '0')}`
    : recState === 'uploading' ? 'Saving…'
    : recState === 'done' ? '✓ Saved'
    : recState === 'error' ? '✖ Error'
    : null;

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Request wake lock so screen stays on
      if ('wakeLock' in navigator) {
        try { wakeLockRef.current = await navigator.wakeLock.request('screen'); } catch (_) {}
      }
      chunksRef.current = [];
      const preferredType = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
        '',
      ].find(t => t === '' || MediaRecorder.isTypeSupported(t));
      const mrOpts = preferredType ? { mimeType: preferredType } : {};
      const mr = new MediaRecorder(stream, mrOpts);
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => { stream.getTracks().forEach(t => t.stop()); uploadJournal(chunksRef.current, mr.mimeType); };
      mr.start(1000);
      mediaRecRef.current = mr;
      setRecSecs(0);
      setRecState('recording');
      timerRef.current = setInterval(() => setRecSecs(s => s + 1), 1000);
    } catch (err) {
      console.error('[journal] mic error:', err.name, err.message);
      setRecState('error');
      setTimeout(() => setRecState('idle'), 5000);
    }
  }

  function stopRecording() {
    clearInterval(timerRef.current);
    if (wakeLockRef.current) { wakeLockRef.current.release().catch(() => {}); wakeLockRef.current = null; }
    if (mediaRecRef.current && mediaRecRef.current.state !== 'inactive') mediaRecRef.current.stop();
  }

  async function uploadJournal(chunks, mimeType) {
    setRecState('uploading');
    try {
      const blob = new Blob(chunks, { type: mimeType });
      const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
      const fd = new FormData();
      fd.append('audio', blob, `journal.${ext}`);
      const res = await fetch('/api/journal/audio/session', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRecState('done');
      setTimeout(() => setRecState('idle'), 4000);
    } catch (err) {
      console.error('[journal] upload failed:', err);
      setRecState('error');
      setTimeout(() => setRecState('idle'), 4000);
    }
  }

  function toggleRecording() {
    if (recState === 'recording') stopRecording();
    else if (recState === 'idle') startRecording();
  }

  // ── URL ingest ──────────────────────────────────────────────────────────────
  const [urlBarOpen, setUrlBarOpen] = React.useState(false);
  const [urlVal, setUrlVal] = React.useState('');
  const [urlStatus, setUrlStatus] = React.useState('');
  const urlInputRef = React.useRef(null);

  async function queueUrl() {
    const url = urlVal.trim();
    if (!url) return;
    setUrlStatus('Queuing…');
    try {
      const res = await fetch('/api/synthadoc/ingest-url/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setUrlStatus('✓ Queued');
      setUrlVal('');
      setTimeout(() => { setUrlStatus(''); setUrlBarOpen(false); }, 2500);
    } catch (err) {
      setUrlStatus('✖ ' + err.message);
    }
  }

  React.useEffect(() => {
    if (urlBarOpen && urlInputRef.current) urlInputRef.current.focus();
  }, [urlBarOpen]);

  // Auto-grow textarea
  React.useEffect(() => {
    if (!textRef.current) return;
    textRef.current.style.height = 'auto';
    textRef.current.style.height = Math.min(textRef.current.scrollHeight, 220) + 'px';
  }, [val]);

  const send = () => {
    if (!val.trim() || streaming) return;
    onSend(val.trim(), opts);
    setVal('');
    if (textRef.current) textRef.current.style.height = 'auto';
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const handleFile = async (file) => {
    if (!file) return;
    setUploadStatus(`Uploading ${file.name}…`);
    const fd = new FormData();
    fd.append('file', file);
    if (window.PROJECT_SLUG) fd.append('projectSlug', window.PROJECT_SLUG);
    if (window.CONV_ID) fd.append('convId', window.CONV_ID);
    fd.append('model', model?.key || '');
    fd.append('autoAnalyse', '0');
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) { setUploadStatus('✖ ' + (data.error || 'Upload failed')); return; }
      if (data.convId && !window.CONV_ID) {
        window.CONV_ID = data.convId;
        history.replaceState(null, '', `/c/${data.convId}`);
      }
      setUploadStatus(`✓ ${file.name} attached`);
      setTimeout(() => setUploadStatus(''), 3000);
    } catch (err) {
      setUploadStatus('✖ ' + err.message);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const placeholder = window.PROJECT_SLUG
    ? `/${window.PROJECT_SLUG} — message… (⇧+Enter for newline)`
    : 'Message the Hub… (⇧+Enter for newline)';

  return (
    <div className="composer-wrap">
      {opts.sensitive && (
        <div className="comp-flag">
          <Icon name="shield" size={14} /> Sensitive mode — web search off; prompt stays on-server.
        </div>
      )}
      {urlBarOpen && (
        <div className="comp-url-bar">
          <input
            ref={urlInputRef}
            type="url"
            placeholder="Paste YouTube or article URL to queue for knowledge ingest…"
            value={urlVal}
            onChange={e => setUrlVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') queueUrl(); if (e.key === 'Escape') { setUrlBarOpen(false); setUrlVal(''); setUrlStatus(''); } }}
          />
          <button onClick={queueUrl} disabled={!urlVal.trim()}>Queue</button>
          {urlStatus && <span className="url-status">{urlStatus}</span>}
        </div>
      )}
      <div className={'composer ' + (val ? 'has-text' : '')}>
        <textarea
          ref={textRef}
          rows={1}
          placeholder={placeholder}
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={onKey}
          disabled={streaming}
        />
        <div className="comp-bar">
          <button className="comp-btn" title="Attach file" onClick={() => fileRef.current?.click()}>
            <Icon name="paperclip" size={16} />
          </button>

          <button
            className={'comp-btn comp-journal-rec' + (recState === 'recording' ? ' is-recording' : recState === 'done' ? ' is-done' : recState === 'error' ? ' is-error' : '')}
            title={recState === 'recording' ? 'Stop journal recording' : 'Record journal entry'}
            onClick={toggleRecording}
            disabled={recState === 'uploading'}
          >
            {recState === 'recording' ? <><span className="rec-dot" /><Icon name="stop" size={14} /></> : <Icon name="mic" size={16} />}
            {recLabel && <span className="rec-label">{recLabel}</span>}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".docx,.pdf,.txt,.md,.csv"
            style={{ display: 'none' }}
            onChange={e => handleFile(e.target.files?.[0])}
          />

          <button
            className={'comp-btn' + (urlBarOpen ? ' is-on' : '')}
            title="Queue URL for knowledge ingest"
            onClick={() => { setUrlBarOpen(o => !o); setUrlVal(''); setUrlStatus(''); }}
          >
            <Icon name="link" size={16} />
          </button>

          <button
            className={'comp-btn comp-toggle ' + (opts.search !== 'off' ? 'is-on' : '')}
            disabled={isPerplexityModel(model?.key)}
            onClick={() => setOpts(o => {
              const isNative = model?.search === 'native';
              // Native models handle their own search — skip web-plugin entirely
              const next = isNative
                ? (o.search === 'off' ? 'exa' : 'off')
                : (o.search === 'off' ? 'openrouter' : o.search === 'openrouter' ? 'exa' : 'off');
              return { ...o, search: next };
            })}
            title={isPerplexityModel(model?.key) ? 'Sonar/Perplexity searches internally — no external search needed' : opts.search === 'exa' ? 'Search: Semantic Search' : opts.search === 'openrouter' ? 'Search: Brave Search' : 'Search: Off'}
          >
            <Icon name="search" size={15} />
            <span>{opts.search === 'exa' ? 'Semantic' : opts.search === 'openrouter' ? 'Brave' : 'Search'}</span>
          </button>

          <button
            className={'comp-btn comp-toggle ' + (opts.sensitive ? 'is-warn' : '')}
            onClick={() => setOpts(o => ({ ...o, sensitive: !o.sensitive, search: !o.sensitive ? 'off' : o.search }))}
            title="Sensitive mode — disables web search"
          >
            <Icon name="shield" size={15} /> <span>Sensitive</span>
          </button>

          <button className="comp-btn comp-more" onClick={() => setMore(m => !m)} title="More options">
            <Icon name="sliders" size={15} /> <span>More</span>
          </button>

          <span className="comp-spacer" />

          {uploadStatus && (
            <span style={{ fontSize: 12, color: 'var(--text-3)', marginRight: 8, whiteSpace: 'nowrap' }}>
              {uploadStatus}
            </span>
          )}

          {streaming ? (
            <>
              <span className="comp-phase-label">
                <span className="comp-phase-dot" />
                {PHASE_LABELS[streamPhase] || 'Working…'}
              </span>
              <button className="comp-stop-inline" onClick={onStop} title="Stop generating">
                <Icon name="stop" size={14} /> Stop
              </button>
            </>
          ) : (
            <button className="comp-send" onClick={send} disabled={!val.trim()}>
              <Icon name="send" size={15} />
              <span>Send</span>
            </button>
          )}
        </div>

        {more && (
          <div className="comp-more-panel" onMouseLeave={() => setMore(false)}>
            <div className="cmp-row">
              <label>Search depth</label>
              <div className="cmp-seg">
                {['low', 'medium', 'high'].map(d => (
                  <button
                    key={d}
                    className={opts.depth === d ? 'is-on' : ''}
                    onClick={() => setOpts(o => ({ ...o, depth: d }))}
                  >
                    {d === 'low' ? 'Quick' : d === 'medium' ? 'Standard' : 'Deep'}
                  </button>
                ))}
              </div>
            </div>
            <div className="cmp-row">
              <label>Research report</label>
              <button
                className={'cmp-switch ' + (opts.research ? 'is-on' : '')}
                onClick={() => setOpts(o => ({ ...o, research: !o.research }))}
              >
                <span />
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="comp-footnote">
        Hub responses can be wrong. Verify what matters.
      </div>
    </div>
  );
}

// ── Accent helpers ─────────────────────────────────────────────────────────
const ACCENTS = [
  { id: 'violet', light: '#7c6af5', dark: '#a594ff' },
  { id: 'indigo', light: '#4648d4', dark: '#8a8dff' },
  { id: 'sky',    light: '#0a84ff', dark: '#5eb1ff' },
  { id: 'mint',   light: '#16a085', dark: '#4fd1b3' },
  { id: 'amber',  light: '#d97757', dark: '#ffb088' },
  { id: 'rose',   light: '#e0457b', dark: '#ff7aa8' },
];

const accentFor = (id, theme) => {
  const a = ACCENTS.find(x => x.id === id) || ACCENTS[0];
  return theme === 'dark' ? a.dark : a.light;
};

// ── App ───────────────────────────────────────────────────────────────────
function ChatApp() {
  const [tweaks, setTweak] = window.useTweaks(window.TWEAK_DEFAULTS);

  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);

  // Pick default model — prefer Everyday first model
  const defaultModel = MODELS[0]?.options[0] || null;
  const [model, setModel] = React.useState(defaultModel);

  const [messages, setMessages] = React.useState(INITIAL_MESSAGES);
  // streamingMsg: null | { content, thinking, error }
  const [streamingMsg, setStreamingMsg] = React.useState(null);
  const [streaming, setStreaming] = React.useState(false);

  const scrollRef = React.useRef(null);
  const activeReaderRef = React.useRef(null);
  const composerRef = React.useRef(null);

  // ── Wake lock: keep screen on while streaming, release 30s after done ──────
  const wakeLockRef = React.useRef(null);
  const wakeLockTimerRef = React.useRef(null);

  const acquireWakeLock = async () => {
    if (!('wakeLock' in navigator)) return;
    try { wakeLockRef.current = await navigator.wakeLock.request('screen'); } catch (_) {}
  };

  const releaseWakeLock = () => {
    if (wakeLockRef.current) { wakeLockRef.current.release().catch(() => {}); wakeLockRef.current = null; }
  };

  React.useEffect(() => {
    if (streaming) {
      clearTimeout(wakeLockTimerRef.current);
      acquireWakeLock();
    } else if (wakeLockRef.current) {
      // Release 30s after completion unless user touches the screen
      wakeLockTimerRef.current = setTimeout(releaseWakeLock, 30000);
    }
  }, [streaming]);

  React.useEffect(() => {
    const onTouch = () => {
      if (!streaming && wakeLockTimerRef.current) {
        clearTimeout(wakeLockTimerRef.current);
        wakeLockTimerRef.current = null;
        releaseWakeLock();
      }
    };
    document.addEventListener('touchstart', onTouch, { passive: true });
    return () => document.removeEventListener('touchstart', onTouch);
  }, [streaming]);

  // Re-acquire if OS released it (e.g. tab became visible again mid-stream)
  React.useEffect(() => {
    const onVisible = () => { if (streaming && document.visibilityState === 'visible' && !wakeLockRef.current) acquireWakeLock(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [streaming]);

  // ── Stream phase: derive from streaming state + content length ─────────────
  const streamPhase = React.useMemo(() => {
    if (!streaming) return null;
    if (streamingMsg?.thinking !== false) return 'thinking';
    const len = (streamingMsg?.content || '').length;
    if (len < 40)  return 'searching';
    if (len < 300) return 'drafting';
    return 'writing';
  }, [streaming, streamingMsg]);

  // Auto-scroll to bottom
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages.length, streamingMsg?.content?.length]);

  const stop = () => {
    if (activeReaderRef.current) {
      activeReaderRef.current.cancel().catch(() => {});
    }
  };

  const [pendingSearchOverride, setPendingSearchOverride] = React.useState(null);

  const focusComposerOnWideScreen = () => {
    if (!window.matchMedia('(max-width: 820px)').matches) {
      setTimeout(() => composerRef.current?.focus(), 50);
    }
  };

  const selectModel = (m) => {
    if (m) setModel(m);
    focusComposerOnWideScreen();
  };

  const selectShortcut = (m, searchOverride) => {
    if (m) setModel(m);
    if (searchOverride) setPendingSearchOverride(searchOverride);
    focusComposerOnWideScreen();
  };

  const send = async (text, opts = {}) => {
    const requestStartSec = Math.floor(Date.now() / 1000);

    // Optimistically add user message
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setStreamingMsg({ content: '', thinking: true });
    setStreaming(true);

    let fullContent = '';
    let sawDone = false;
    let stopped = false;

    const finishWithMessage = (msg) => {
      setStreamingMsg(null);
      setMessages(prev => [...prev, {
        id: msg.id,
        role: 'assistant',
        content: msg.content,
        model: msg.model,
        cost: msg.cost_usd != null ? Number(msg.cost_usd).toFixed(4) : null,
        searchUsed: !!msg.search_used,
      }]);
      setStreaming(false);
    };

    const pollForSavedAnswer = () => {
      const convId = window.CONV_ID;
      if (!convId) {
        setStreamingMsg({ content: fullContent, thinking: false });
        setStreaming(false);
        return;
      }

      const pollSince = requestStartSec - 10;
      const deadline = Date.now() + 5 * 60 * 1000;
      setStreamingMsg({ content: fullContent, thinking: false });

      let timer = null;

      const attempt = async () => {
        if (Date.now() > deadline) {
          clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisible);
          setStreaming(false);
          return;
        }
        try {
          const r = await fetch(`/api/conversations/${convId}/latest-asst?since=${pollSince}`);
          const d = await r.json();
          if (d.message?.content) {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
            finishWithMessage(d.message);
          }
        } catch (_) {}
      };

      const onVisible = () => { if (document.visibilityState === 'visible') attempt(); };
      document.addEventListener('visibilitychange', onVisible);
      attempt();
      timer = setInterval(attempt, 1500);
    };

    try {
      const res = await fetch('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: text,
          model: model?.key,
          convId: window.CONV_ID || undefined,
          projectSlug: window.PROJECT_SLUG || undefined,
          noSearch: opts.sensitive || false,
          searchProvider: opts.sensitive ? 'off' : (opts.search === 'off' ? 'off' : opts.search === 'exa' ? 'exa' : 'openrouter'),
          searchDepth: opts.depth || 'medium',
          researchMode: opts.research || false,
        }),
      });

      const reader = res.body.getReader();
      activeReaderRef.current = reader;
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const data = JSON.parse(line.slice(6));

              // Adopt new conv ID
              if (data.convId && !window.CONV_ID) {
                window.CONV_ID = data.convId;
                history.replaceState(null, '', `/c/${data.convId}`);
              }

              if (data.chunk) {
                if (data.chunk.startsWith('\x00')) {
                  fullContent = data.chunk.slice(1);
                } else {
                  fullContent += data.chunk;
                }
                setStreamingMsg({ content: fullContent, thinking: false });
              }

              if (data.done) {
                sawDone = true;
                setStreamingMsg(null);
                setMessages(prev => [...prev, {
                  id: data.msgId,
                  role: 'assistant',
                  content: fullContent || '(no response)',
                  model: data.model,
                  cost: data.costUsd != null ? Number(data.costUsd).toFixed(4) : null,
                  searchUsed: false,
                }]);
                setStreaming(false);
              }

              if (data.error) {
                setStreamingMsg({ content: '', thinking: false, error: data.error });
              }
            } catch (_) {}
          }
        }
      } catch (streamErr) {
        // Stream cancelled (Stop button) or connection dropped (mobile screen off)
        stopped = true;
        pollForSavedAnswer();
      }

      if (!sawDone && !stopped) {
        pollForSavedAnswer();
      }
    } catch (err) {
      setStreamingMsg({ content: '', thinking: false, error: err.message });
      setStreaming(false);
    }
  };

  const accentHex = accentFor(tweaks.accent, tweaks.theme);

  const rootStyle = {
    '--accent': accentHex,
    '--accent-hover': accentHex,
    '--font-ui': tweaks.font === 'inter'
      ? "'Inter', system-ui, sans-serif"
      : tweaks.font === 'plex'
      ? "'IBM Plex Sans', system-ui, sans-serif"
      : "'Manrope', system-ui, sans-serif",
    '--font-display': tweaks.displayFont === 'serif'
      ? "'Noto Serif', Georgia, serif"
      : 'var(--font-ui)',
  };

  return (
    <div
      className="hub-shell"
      data-theme={tweaks.theme}
      data-density={tweaks.density}
      data-bubbles={tweaks.bubbles}
      style={rootStyle}
    >
      <Sidebar
        collapsed={collapsed} setCollapsed={setCollapsed}
        mobileOpen={mobileOpen} setMobileOpen={setMobileOpen}
      />

      <main className="hub-main">
        <ChatHeader
          model={model} setModel={setModel}
          onMenu={() => setMobileOpen(true)}
        />

        {HUB.activeProject && !HUB.projectHistoryLoaded && HUB.projectHistoryCount > 0 && (
          <div className="proj-history-banner">
            <span>
              <strong>{HUB.projectHistoryCount}</strong> saved messages not loaded
              — new chats start fresh to save tokens.
            </span>
            <a
              href={`/p/${HUB.activeProject.slug}?history=1`}
              className="proj-history-load"
            >
              Load history (higher cost)
            </a>
          </div>
        )}

        <div className="msg-scroll" ref={scrollRef}>
          <div className="msg-stack">
            {messages.length === 0 && !streamingMsg ? (
              <EmptyState onSelectModel={selectModel} onSelectShortcut={selectShortcut} />
            ) : (
              <>
                {messages.map((m, i) =>
                  m.role === 'user'
                    ? <MessageUser key={i} content={m.content} />
                    : <MessageAssistant key={i} {...m} isLast={i === messages.length - 1} />
                )}
                {streamingMsg && (
                  streamingMsg.thinking
                    ? <ThinkingRow />
                    : <MessageAssistant
                        content={streamingMsg.content}
                        error={streamingMsg.error}
                        isStreaming={true}
                      />
                )}
              </>
            )}
          </div>
        </div>

        <div className="hub-composer-mount">
          <Composer onSend={send} onStop={stop} model={model} streaming={streaming} streamPhase={streamPhase} textareaRef={composerRef} searchOverride={pendingSearchOverride} clearSearchOverride={() => setPendingSearchOverride(null)} />
        </div>
      </main>

      <window.TweaksPanel title="Tweaks">
        <window.TweakSection title="Theme">
          <window.TweakRadio
            value={tweaks.theme}
            onChange={v => setTweak('theme', v)}
            options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
          />
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>Accent (auto-brightens in dark)</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            {ACCENTS.map(a => {
              const swatch = accentFor(a.id, tweaks.theme);
              const active = tweaks.accent === a.id;
              return (
                <button
                  key={a.id}
                  onClick={() => setTweak('accent', a.id)}
                  title={a.id}
                  style={{
                    width: 30, height: 30, borderRadius: 8,
                    background: swatch,
                    border: active ? '2px solid var(--text)' : '1px solid var(--line)',
                    cursor: 'pointer', padding: 0,
                  }}
                />
              );
            })}
          </div>
        </window.TweakSection>

        <window.TweakSection title="Density">
          <window.TweakRadio
            value={tweaks.density}
            onChange={v => setTweak('density', v)}
            options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]}
          />
        </window.TweakSection>

        <window.TweakSection title="Messages">
          <window.TweakRadio
            value={tweaks.bubbles}
            onChange={v => setTweak('bubbles', v)}
            options={[{ value: 'mixed', label: 'User bubble' }, { value: 'both', label: 'Both bubbles' }]}
          />
        </window.TweakSection>

        <window.TweakSection title="Type">
          <window.TweakSelect
            value={tweaks.font}
            onChange={v => setTweak('font', v)}
            options={[
              { value: 'manrope', label: 'Manrope (default)' },
              { value: 'inter', label: 'Inter' },
              { value: 'plex', label: 'IBM Plex Sans' },
            ]}
          />
          <window.TweakRadio
            value={tweaks.displayFont}
            onChange={v => setTweak('displayFont', v)}
            options={[{ value: 'sans', label: 'Sans display' }, { value: 'serif', label: 'Serif display' }]}
          />
        </window.TweakSection>
      </window.TweaksPanel>
    </div>
  );
}

// ── CRM View ───────────────────────────────────────────────────────────────
function ContactCard({ contact, onDeleteContact, onDeleteFact }) {
  const [histOpen, setHistOpen] = React.useState(false);
  const facts        = Array.isArray(contact.facts) ? contact.facts : [];
  const activeFacts  = facts.filter(f => f.status === 'active');
  const followUps    = facts.filter(f => f.status === 'follow_up');
  const doneFacts    = facts.filter(f => f.status === 'done' || f.status === 'closed');
  const openCount    = activeFacts.length + followUps.length;

  return (
    <div className="crm-card">
      <div className="crm-card-name">
        {contact.name}
        {openCount > 0 && <span className="crm-open-count">{openCount} open</span>}
        <button className="crm-contact-del" onClick={() => onDeleteContact(contact.id, contact.name)}>Delete</button>
      </div>
      {!openCount && !doneFacts.length && (
        <p style={{ fontSize: 13, color: 'var(--text-3)', margin: 0 }}>No notes yet.</p>
      )}
      {(activeFacts.length > 0 || followUps.length > 0) && (
        <ul className="crm-fact-list">
          {[...followUps, ...activeFacts].map(f => (
            <li key={f.id} className="crm-fact-item">
              <span className={'crm-fact-tag ' + (f.status === 'follow_up' ? 'tag-followup' : 'tag-active')}>
                {f.status === 'follow_up' ? 'follow-up' : 'action'}
              </span>
              <span className="crm-fact-text">{f.fact}</span>
              <span className="crm-fact-source">{f.source}</span>
              <button className="crm-fact-del" onClick={() => onDeleteFact(contact.id, f.id)}>×</button>
            </li>
          ))}
        </ul>
      )}
      {doneFacts.length > 0 && (
        <>
          <button className="crm-show-hist" onClick={() => setHistOpen(o => !o)}>
            {histOpen ? 'Hide history' : `Show ${doneFacts.length} done`}
          </button>
          {histOpen && (
            <div className="crm-history">
              <ul className="crm-fact-list">
                {doneFacts.map(f => (
                  <li key={f.id} className="crm-fact-item">
                    <span className={'crm-fact-tag ' + (f.status === 'closed' ? 'tag-closed' : 'tag-done')}>{f.status}</span>
                    <span className="crm-fact-text crm-fact-done">{f.fact}</span>
                    <span className="crm-fact-source">{f.source}</span>
                    <button className="crm-fact-del" onClick={() => onDeleteFact(contact.id, f.id)}>×</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CrmMain() {
  const [contacts, setContacts] = React.useState((window.CRM_DATA?.contacts || []));
  const context = window.CRM_DATA?.context || [];
  const [input, setInput]       = React.useState('');
  const [fb, setFb]             = React.useState({ text: '', error: false });
  const [saving, setSaving]     = React.useState(false);

  async function submitNote() {
    const text = input.trim();
    if (!text) return;
    setSaving(true);
    setFb({ text: 'Saving…', error: false });
    try {
      const r = await fetch('/api/crm/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ text }),
      });
      const d = await r.json();
      if (d.ok) {
        setFb({ text: d.message.replace(/\*\*/g, '').replace(/~~/g, ''), error: false });
        setInput('');
        setTimeout(() => location.reload(), 1200);
      } else {
        setFb({ text: d.message || 'Error', error: true });
      }
    } catch { setFb({ text: 'Network error', error: true }); }
    setSaving(false);
  }

  async function deleteContact(id, name) {
    if (!confirm('Delete ' + name + ' and all their notes?')) return;
    const r = await fetch('/api/crm/contacts/' + id + '/delete', {
      method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    const d = await r.json();
    if (d.ok) setContacts(prev => prev.filter(c => c.id !== id));
  }

  async function deleteFact(contactId, factId) {
    if (!confirm('Delete this fact?')) return;
    const r = await fetch('/api/crm/facts/' + factId + '/delete', {
      method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    const d = await r.json();
    if (d.ok) setContacts(prev => prev.map(c =>
      c.id === contactId ? { ...c, facts: c.facts.filter(f => f.id !== factId) } : c
    ));
  }

  return (
    <div className="crm-scroll-area">
      <div className="crm-wrap">
        <div className="crm-page-header">
          <h1>People</h1>
        </div>

        {context.filter(c => !c.key.startsWith('_') && !/token|secret|key|password/i.test(c.key)).length > 0 && (
          <div className="crm-context-bar">
            <h3 className="crm-context-title">Known context</h3>
            <div className="crm-context-pills">
              {context.filter(c => !c.key.startsWith('_') && !/token|secret|key|password/i.test(c.key)).map(c => (
                <span key={c.key} className="crm-context-pill">
                  <strong>{c.key}</strong> = {c.value}
                </span>
              ))}
            </div>
          </div>
        )}

        {fb.text && <div className={'crm-feedback' + (fb.error ? ' error' : '')}>{fb.text}</div>}

        <div className="crm-add-bar">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submitNote()}
            placeholder='e.g. "Tom needs to know about Copilot" or "told Tom about it"'
            autoComplete="off"
          />
          <button onClick={submitNote} disabled={saving}>Save</button>
        </div>

        {contacts.length === 0 ? (
          <div className="crm-empty">
            <p>No contacts yet.</p>
            <p>Type a note above or use <code>/crm [note]</code> in any chat.</p>
          </div>
        ) : (
          <div className="crm-contact-grid">
            {contacts.map(contact => (
              <ContactCard
                key={contact.id}
                contact={contact}
                onDeleteContact={deleteContact}
                onDeleteFact={deleteFact}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CrmApp() {
  const [tweaks, setTweak] = window.useTweaks(window.TWEAK_DEFAULTS || {});
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);

  const accentHex = accentFor(tweaks.accent, tweaks.theme);
  const rootStyle = {
    '--accent': accentHex,
    '--accent-hover': accentHex,
    '--font-ui': tweaks.font === 'inter'
      ? "'Inter', system-ui, sans-serif"
      : tweaks.font === 'plex'
      ? "'IBM Plex Sans', system-ui, sans-serif"
      : "'Manrope', system-ui, sans-serif",
    '--font-display': tweaks.displayFont === 'serif'
      ? "'Noto Serif', Georgia, serif"
      : 'var(--font-ui)',
  };

  return (
    <div
      className="hub-shell"
      data-theme={tweaks.theme}
      data-density={tweaks.density}
      data-bubbles={tweaks.bubbles}
      style={rootStyle}
    >
      <Sidebar collapsed={collapsed} setCollapsed={setCollapsed} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} />

      <main className="hub-main">
        <header className="hub-header">
          <button className="hb-menu" onClick={() => setMobileOpen(true)} aria-label="Menu">
            <Icon name="menu" size={20} />
          </button>
          <div className="hb-title"><h1>People</h1></div>
        </header>
        <CrmMain />
      </main>

      <window.TweaksPanel title="Tweaks">
        <window.TweakSection title="Theme">
          <window.TweakRadio
            value={tweaks.theme}
            onChange={v => setTweak('theme', v)}
            options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
          />
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>Accent</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            {ACCENTS.map(a => {
              const swatch = accentFor(a.id, tweaks.theme);
              const active = tweaks.accent === a.id;
              return (
                <button key={a.id} onClick={() => setTweak('accent', a.id)} title={a.id}
                  style={{ width: 30, height: 30, borderRadius: 8, background: swatch,
                    border: active ? '2px solid var(--text)' : '1px solid var(--line)',
                    cursor: 'pointer', padding: 0 }} />
              );
            })}
          </div>
        </window.TweakSection>
        <window.TweakSection title="Type">
          <window.TweakSelect value={tweaks.font} onChange={v => setTweak('font', v)}
            options={[
              { value: 'manrope', label: 'Manrope (default)' },
              { value: 'inter', label: 'Inter' },
              { value: 'plex', label: 'IBM Plex Sans' },
            ]} />
        </window.TweakSection>
      </window.TweaksPanel>
    </div>
  );
}

const RootApp = window.HUB_VIEW === 'crm' ? CrmApp : ChatApp;
ReactDOM.createRoot(document.getElementById('root')).render(<RootApp />);
