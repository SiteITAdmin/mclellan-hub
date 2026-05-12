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
        tier: m.tier,
        search: m.search || false,
      })),
  }))
  .filter(g => g.options.length > 0);

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
  const fileRef = React.useRef(null);

  async function upload(e) {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    setMsg('Uploading…');
    const fd = new FormData();
    fd.append('file', file);
    fd.append('projectSlug', slug);
    try {
      const r = await fetch('/api/upload', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' }, body: fd });
      const d = await r.json();
      if (d.ok) {
        setDocs(prev => [{ id: d.document.id, filename: d.document.filename, size_bytes: d.document.size }, ...prev]);
        setMsg('');
      } else {
        setMsg(d.error || 'Upload failed');
      }
    } catch { setMsg('Upload failed'); }
    setUploading(false);
    e.target.value = '';
  }

  async function del(id) {
    if (!confirm('Remove this document?')) return;
    const r = await fetch('/api/documents/' + id + '/delete', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    const d = await r.json();
    if (d.ok) setDocs(prev => prev.filter(x => x.id !== id));
  }

  return (
    <div className="sb-docs">
      <div className="sb-section-head">
        <span>Project docs</span>
        <button title="Upload document" onClick={() => fileRef.current?.click()} disabled={uploading}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.docx,.csv,.json" style={{ display: 'none' }} onChange={upload} />
      {msg && <div style={{ fontSize: 11, color: 'var(--text-3)', padding: '2px 8px 4px' }}>{msg}</div>}
      {docs.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '4px 8px 8px' }}>No docs yet</div>
      ) : (
        <div className="sb-list">
          {docs.map(doc => (
            <div key={doc.id} className="sb-doc-row">
              <Icon name="file" size={13} />
              <span className="sb-doc-name" title={doc.filename}>{doc.filename}</span>
              <button className="sb-doc-del" title="Remove" onClick={() => del(doc.id)}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Sidebar ────────────────────────────────────────────────────────────────
function Sidebar({ collapsed, setCollapsed, mobileOpen, setMobileOpen }) {
  const [hovered, setHovered] = React.useState(false);
  const [showNewProj, setShowNewProj] = React.useState(false);
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
        </nav>

        {expanded && projects.length > 0 && (
          <>
            <div className="sb-section-head">
              <span>Projects</span>
              <button title="New project" onClick={() => setShowNewProj(true)}><Icon name="plus" size={14} /></button>
            </div>
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
          </>
        )}

        {expanded && activeSlug && <ProjectDocs slug={activeSlug} />}
        {expanded && <RecentConvs convs={convs} activeConvId={activeConvId} />}

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

// ── Header ─────────────────────────────────────────────────────────────────
function ChatHeader({ model, setModel, onMenu, streaming, onStop }) {
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

      {streaming && (
        <button
          onClick={onStop}
          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 8, border: '1px solid var(--line)', background: 'none', color: 'var(--text-2)', cursor: 'pointer', fontSize: 13, marginRight: 8 }}
          title="Stop generating"
        >
          <Icon name="stop" size={14} /> Stop
        </button>
      )}

      <div className="hb-model">
        <button className="hb-model-btn" onClick={() => setOpen(o => !o)}>
          <span className="hb-model-dot" />
          <span className="hb-model-name">{model?.label || '—'}</span>
          <Icon name="chevron" size={14} />
        </button>
        {open && (
          <div className="hb-model-pop" onMouseLeave={() => setOpen(false)}>
            {MODELS.map(g => (
              <div key={g.group} className="hb-model-group">
                <div className="hb-model-group-head">{g.group}</div>
                {g.options.map(m => (
                  <button
                    key={m.key}
                    className={'hb-model-opt ' + (model?.key === m.key ? 'is-active' : '')}
                    onClick={() => { setModel(m); setOpen(false); }}
                  >
                    <span>{m.label}</span>
                    {m.search && <span className="hb-model-tag">search</span>}
                  </button>
                ))}
              </div>
            ))}
            <a className="hb-model-foot" href="/settings">
              <Icon name="settings" size={13} /> Model settings
            </a>
          </div>
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
                  <button title="Download Word" onClick={() => exportMsg('docx')}>
                    <Icon name="download" size={14} />Word
                  </button>
                  <button title="Export PDF" onClick={() => exportMsg('pdf')}>
                    <Icon name="download" size={14} />PDF
                  </button>
                  <button title="Open in Google Doc" onClick={() => exportMsg('gdoc')}>
                    <Icon name="sparkle" size={14} />GDoc
                  </button>
                  <SaveToProject msgId={msgId} />
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
  // Free model: prefer a specific free model that supports web search (not the opaque
  // openrouter/free catch-all which outputs raw tool-call JSON when given search tools)
  const freeModel =
    findModel(m => m.key === 'grok-fast') ||
    findModel(m => m.key === 'mistral-small') ||
    findModel(m => m.key === 'mimo-flash') ||
    findModel((m, g) => g.group.toLowerCase().includes('everyday')) ||
    MODELS[0]?.options[0];

  // Research: best search-capable non-Sonar model
  const researchModel =
    findModel(m => m.key === 'gemini-25-pro') ||
    findModel(m => m.key === 'claude-sonnet') ||
    findModel(m => m.key === 'deepseek-v3') ||
    findModel(m => m.search && !m.key.toLowerCase().includes('sonar'));

  // Sonar: Perplexity native search
  const sonarModel =
    findModel(m => m.key === 'sonar') ||
    findModel(m => m.key.toLowerCase().includes('sonar'));

  return [
    {
      kicker: 'Free',
      label: 'Free model',
      desc: freeModel ? freeModel.label : 'Fast, no cost',
      icon: '◎',
      model: freeModel,
    },
    {
      kicker: 'Research',
      label: 'Live research',
      desc: researchModel ? researchModel.label + ' + web' : 'Web search enabled',
      icon: '⌖',
      model: researchModel,
    },
    {
      kicker: 'Sonar',
      label: 'Sonar search',
      desc: sonarModel ? sonarModel.label : 'Perplexity deep search',
      icon: '◉',
      model: sonarModel,
    },
  ].filter(s => s.model);
}

// ── Empty state ───────────────────────────────────────────────────────────
function EmptyState({ onSelectModel }) {
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
          <button key={i} className="empty-card" onClick={() => onSelectModel(s.model)}>
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
function Composer({ onSend, model, streaming, textareaRef: externalRef }) {
  const [val, setVal] = React.useState('');
  const [more, setMore] = React.useState(false);
  const [uploadStatus, setUploadStatus] = React.useState('');
  const [opts, setOpts] = React.useState({
    sensitive: false,
    research: false,
    search: 'on',
    depth: 'medium',
  });
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
            className={'comp-btn comp-toggle ' + (opts.search !== 'off' ? 'is-on' : '')}
            onClick={() => setOpts(o => ({ ...o, search: o.search === 'off' ? 'on' : 'off' }))}
            title="Toggle web search"
          >
            <Icon name="search" size={15} /> <span>Search</span>
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

          <span className="comp-model-hint">
            <span className="hb-model-dot" /> {model?.label || '—'}
          </span>

          <button className="comp-send" onClick={send} disabled={!val.trim() || streaming}>
            <Icon name="send" size={15} />
            <span>Send</span>
          </button>
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

  const selectModel = (m) => {
    if (m) setModel(m);
    setTimeout(() => composerRef.current?.focus(), 50);
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
          searchProvider: opts.search === 'off' ? 'off' : 'openrouter',
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
          streaming={streaming}
          onStop={stop}
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
              <EmptyState onSelectModel={selectModel} />
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
          <Composer onSend={send} model={model} streaming={streaming} textareaRef={composerRef} />
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
  const activeFacts  = contact.facts.filter(f => f.status === 'active');
  const followUps    = contact.facts.filter(f => f.status === 'follow_up');
  const doneFacts    = contact.facts.filter(f => f.status === 'done' || f.status === 'closed');
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
