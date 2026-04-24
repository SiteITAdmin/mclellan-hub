function escapeHtml(raw) {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHref(href) {
  try {
    const url = new URL(href, window.location.origin);
    if (['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return url.href;
  } catch (_) {}
  return null;
}

function linkifySourceCitations(raw) {
  const text = String(raw || '');
  const sourceUrls = new Map();

  text.replace(/(?:^|\n)\s*(?:\[(\d+)\]|(\d+)\.)\s+(?:\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(.+?)\s+(https?:\/\/\S+))/g,
    (_, bracketNum, dotNum, linkedTitle, linkedUrl, plainTitle, plainUrl) => {
      const n = bracketNum || dotNum;
      const url = linkedUrl || plainUrl;
      if (n && safeHref(url)) sourceUrls.set(n, url.replace(/[).,;]+$/, ''));
      return _;
    });

  if (!sourceUrls.size) return text;

  let inSources = false;
  return text.split('\n').map(line => {
    if (/^\s*(#{1,6}\s*)?(sources|references)\s*:?(\s*\([^)]*\))?\s*$/i.test(line.replace(/\*\*/g, ''))) {
      inSources = true;
      return line;
    }

    let next = line;
    if (inSources) {
      next = next.replace(/^(\s*)(?:\[(\d+)\]|(\d+)\.)\s+(?!.*\]\(https?:\/\/)/, (m, indent, bracketNum, dotNum) => {
        const n = bracketNum || dotNum;
        const url = sourceUrls.get(n);
        return url ? `${indent}[${n}] ` : m;
      });
    } else {
      next = next.replace(/\[(\d+)\](?!\()/g, (m, n) => {
        const url = sourceUrls.get(n);
        return url ? `[[${n}]](${url})` : m;
      });
    }
    return next;
  }).join('\n');
}

function renderMarkdownSafe(raw) {
  const html = marked.parse(escapeHtml(linkifySourceCitations(raw)));
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('script, iframe, object, embed, link, meta, style').forEach(el => el.remove());
  template.content.querySelectorAll('*').forEach(el => {
    [...el.attributes].forEach(attr => {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    });
  });
  template.content.querySelectorAll('a').forEach(a => {
    const href = safeHref(a.getAttribute('href') || '');
    if (href) {
      a.setAttribute('href', href);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else {
      a.removeAttribute('href');
    }
  });
  return template.innerHTML;
}

// ── Auto-analyse toggle + prompt editor ──────────────────────────────────────
const DEFAULT_ANALYSIS_PROMPT = 'Please read and analyse the document I just attached. Summarise what it contains and flag anything notable.';

(function () {
  const check = document.getElementById('auto-analyse-check');
  const editBtn = document.getElementById('edit-prompt-btn');
  const panel = document.getElementById('analysis-prompt-panel');
  const promptText = document.getElementById('analysis-prompt-text');
  const saveBtn = document.getElementById('prompt-save-btn');
  const resetBtn = document.getElementById('prompt-reset-btn');
  if (!check) return;

  // Restore from localStorage
  if (localStorage.getItem('autoAnalyse') === 'false') check.checked = false;
  promptText.value = localStorage.getItem('analysisPrompt') || DEFAULT_ANALYSIS_PROMPT;

  check.addEventListener('change', () => {
    localStorage.setItem('autoAnalyse', check.checked);
    editBtn.style.opacity = check.checked ? '1' : '0.3';
  });
  editBtn.style.opacity = check.checked ? '1' : '0.3';

  editBtn.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  });

  saveBtn.addEventListener('click', () => {
    localStorage.setItem('analysisPrompt', promptText.value.trim() || DEFAULT_ANALYSIS_PROMPT);
    panel.style.display = 'none';
  });

  resetBtn.addEventListener('click', () => {
    promptText.value = DEFAULT_ANALYSIS_PROMPT;
    localStorage.removeItem('analysisPrompt');
    panel.style.display = 'none';
  });
})();

// Show/hide depth selector based on search provider
(function () {
  const provider = document.getElementById('search-provider');
  const depthWrap = document.getElementById('search-depth-wrap');
  if (!provider || !depthWrap) return;
  function sync() { depthWrap.style.display = provider.value === 'off' ? 'none' : ''; }
  provider.addEventListener('change', sync);
  sync();
})();

// Render all existing messages on load
document.querySelectorAll('.message-content[data-raw]').forEach(renderContent);

function renderContent(el) {
  const raw = decodeURIComponent(el.dataset.raw);
  el.innerHTML = renderMarkdownSafe(raw);
  el.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
}

// Project-tier confirmation (Opus and any admin-added premium model)
document.getElementById('model-select').addEventListener('change', function () {
  const opt = this.options[this.selectedIndex];
  const tier = opt?.dataset.tier;
  if (tier === 'project') {
    if (!confirm(`${opt.textContent} is a project-tier model (higher cost). Continue?`)) {
      // Fall back to the first non-project option
      for (const o of this.options) {
        if (o.dataset.tier !== 'project') { this.value = o.value; break; }
      }
    }
  }
});

// Sovereignty flag
document.getElementById('sovereignty-check').addEventListener('change', function () {
  document.getElementById('sovereignty-flag').style.display = this.checked ? 'block' : 'none';
});

// Submit on Enter, newline on Shift+Enter
document.getElementById('msg-input').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('chat-form').requestSubmit();
  }
});

// Active stream reader — used by the Stop button
let activeReader = null;

function adoptConversation(convId) {
  if (!convId || window.CONV_ID) return;
  window.CONV_ID = convId;
  if (!window.PROJECT_SLUG) {
    history.replaceState(null, '', `/c/${convId}`);
  }
}

function setStreaming(on) {
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const input = document.getElementById('msg-input');
  if (on) {
    sendBtn.disabled = true;
    input.disabled = true;
    if (stopBtn) stopBtn.hidden = false;
  } else {
    sendBtn.disabled = false;
    input.disabled = false;
    if (stopBtn) stopBtn.hidden = true;
    activeReader = null;
  }
}

// Stop button: cancel the stream client-side; server keeps processing and saves to DB
(function() {
  const stopBtn = document.getElementById('stop-btn');
  if (!stopBtn) return;
  stopBtn.addEventListener('click', () => {
    if (activeReader) {
      activeReader.cancel().catch(() => {});
    }
    // setStreaming(false) will be called in the catch branch below when the reader throws
  });
})();

// Chat form submission
document.getElementById('chat-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content) return;

  // /newproject <Name> — create project inline
  const newProjMatch = content.match(/^\/newproject\s+(.+)$/i);
  if (newProjMatch) {
    input.value = '';
    const name = newProjMatch[1].trim();
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) {
        appendMessage('assistant', `**Couldn't create project:** ${data.error}`);
        return;
      }
      appendMessage('assistant',
        `✓ Created project **${data.project.name}** (\`/${data.project.slug}\`). ` +
        `Type \`/${data.project.slug} your question\` or upload docs in its view.`);
      // Refresh sidebar project list
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      appendMessage('assistant', `**Error:** ${err.message}`);
    }
    return;
  }

  // /<slug>.new — open a fresh chat view in that project
  const newChatMatch = content.match(/^\/([a-z0-9-]+)\.new\s*$/i);
  if (newChatMatch) {
    location.href = `/p/${newChatMatch[1].toLowerCase()}?new=1`;
    return;
  }

  const model = document.getElementById('model-select').value;
  input.value = '';
  setStreaming(true);

  appendMessage('user', content);

  const asstEl = appendMessage('assistant', '');
  const contentEl = asstEl.querySelector('.message-content');
  contentEl.innerHTML = '<span class="thinking"><span></span><span></span><span></span></span>';
  let fullContent = '';
  let receivedChunk = false;
  let stopped = false;
  let sawDone = false;
  let pollingStarted = false;

  function showSavedAnswer(message) {
    contentEl.innerHTML = renderMarkdownSafe(message.content);
    contentEl.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
    asstEl.dataset.id = message.id;
    addExportButtons(asstEl, message.id, message.model,
      message.tokens_in, message.tokens_out, message.cost_usd, null);
    scrollToBottom();
  }

  function pollForSavedAnswer() {
    if (pollingStarted) return;
    pollingStarted = true;

    const pollConvId = window.CONV_ID;
    if (!pollConvId) {
      contentEl.innerHTML = renderMarkdownSafe('*Answer is still being saved — refresh Recent chats to reopen it.*');
      return;
    }

    contentEl.innerHTML = renderMarkdownSafe(
      (fullContent.trim() ? fullContent + '\n\n---\n' : '') +
      '*Fetching saved answer…*'
    );
    scrollToBottom();

    const pollSince = Math.floor((Date.now() - 5000) / 1000); // 5s grace window
    const pollDeadline = Date.now() + 5 * 60 * 1000; // give up after 5 min

    const pollTimer = setInterval(async () => {
      if (Date.now() > pollDeadline) {
        clearInterval(pollTimer);
        contentEl.innerHTML = renderMarkdownSafe('*Answer timed out — reload the conversation to see it.*');
        return;
      }
      try {
        const pr = await fetch(`/api/conversations/${pollConvId}/latest-asst?since=${pollSince}`);
        const pd = await pr.json();
        if (pd.message && pd.message.content) {
          clearInterval(pollTimer);
          showSavedAnswer(pd.message);
        }
      } catch (_) {}
    }, 3000);
  }

  try {
    const res = await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        model,
        convId: window.CONV_ID || undefined,
        projectSlug: window.PROJECT_SLUG || undefined,
        noSearch: document.getElementById('sovereignty-check')?.checked || false,
        searchProvider: document.getElementById('search-provider')?.value || 'openrouter',
        searchDepth: document.getElementById('search-depth')?.value || 'medium',
        researchMode: document.getElementById('research-mode-check')?.checked || false,
      }),
    });

    const reader = res.body.getReader();
    activeReader = reader;
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
            adoptConversation(data.convId);
            if (data.chunk) {
              if (!receivedChunk) {
                receivedChunk = true;
                contentEl.innerHTML = '';
              }
              if (data.chunk.startsWith('\x00')) {
                fullContent = data.chunk.slice(1);
              } else {
                fullContent += data.chunk;
              }
              contentEl.innerHTML = renderMarkdownSafe(fullContent);
              contentEl.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
              scrollToBottom();
            }
            if (data.done) {
              sawDone = true;
              if (!receivedChunk || !fullContent.trim()) {
                contentEl.innerHTML = '<em style="color:var(--text-muted);font-size:13px;">No text response — the model may not support web search output. Try a different model.</em>';
              }
              asstEl.dataset.id = data.msgId;
              addExportButtons(asstEl, data.msgId, data.model, data.tokensIn, data.tokensOut, data.costUsd, data.modelId);
            }
            if (data.error) {
              contentEl.innerHTML = `<em style="color:var(--text-muted);font-size:13px;">Error: ${data.error}</em>`;
            }
          } catch (_) {}
        }
      }
    } catch (streamErr) {
      // Reader was cancelled (Stop button) or connection dropped (screen off etc.)
      stopped = true;
      pollForSavedAnswer();
    }

    if (!sawDone) {
      stopped = true;
      pollForSavedAnswer();
    }
  } catch (err) {
    contentEl.textContent = err.message;
  }

  setStreaming(false);
  if (!stopped) document.getElementById('msg-input').focus();
  else document.getElementById('msg-input').focus();
});

function appendMessage(role, content) {
  const messages = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = `message message-${role}`;
  div.innerHTML = `<div class="message-content">${content ? renderMarkdownSafe(content) : ''}</div>`;
  messages.appendChild(div);
  scrollToBottom();
  return div;
}

function addExportButtons(msgEl, msgId, model, tokensIn, tokensOut, costUsd, modelId) {
  const existing = msgEl.querySelector('.message-meta');
  if (existing) return;

  const tokenStr = (tokensIn || tokensOut)
    ? `<span class="cost-tag">${tokensIn}↑ ${tokensOut}↓ $${(costUsd||0).toFixed(4)}</span>`
    : '';

  const modelLabel = (modelId && modelId !== model)
    ? `${model} <span class="model-id-tag">· ${modelId}</span>`
    : model;

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.innerHTML = `
    <span class="model-tag">${modelLabel}</span>
    ${tokenStr}
    <div class="export-btns">
      <button class="export-btn" data-format="docx" data-id="${msgId}">Word</button>
      <button class="export-btn" data-format="pdf" data-id="${msgId}">PDF</button>
      <button class="export-btn" data-format="gdoc" data-id="${msgId}">Google Doc</button>
    </div>`;
  msgEl.appendChild(meta);
  bindExportButtons(meta);
  addStars(msgEl, msgId, 0);
}

function addStars(msgEl, msgId, currentRating) {
  if (msgEl.querySelector('.rating-stars')) return;
  const wrap = document.createElement('div');
  wrap.className = 'rating-stars';
  wrap.dataset.rating = currentRating;
  for (let i = 1; i <= 5; i++) {
    const btn = document.createElement('button');
    btn.className = 'star-btn' + (i <= currentRating ? ' filled' : '');
    btn.dataset.value = i;
    btn.textContent = i <= currentRating ? '★' : '☆';
    btn.title = `Rate ${i} star${i > 1 ? 's' : ''}`;
    wrap.appendChild(btn);
  }
  wrap.addEventListener('mouseover', e => {
    const v = parseInt(e.target.dataset.value);
    if (!v) return;
    wrap.querySelectorAll('.star-btn').forEach((b, i) => {
      b.textContent = i < v ? '★' : '☆';
    });
  });
  wrap.addEventListener('mouseout', () => {
    const saved = parseInt(wrap.dataset.rating) || 0;
    wrap.querySelectorAll('.star-btn').forEach((b, i) => {
      b.textContent = i < saved ? '★' : '☆';
      b.classList.toggle('filled', i < saved);
    });
  });
  wrap.addEventListener('click', async e => {
    const v = parseInt(e.target.dataset.value);
    if (!v) return;
    wrap.dataset.rating = v;
    wrap.querySelectorAll('.star-btn').forEach((b, i) => {
      b.textContent = i < v ? '★' : '☆';
      b.classList.toggle('filled', i < v);
    });
    await fetch(`/api/messages/${msgId}/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: v }),
    });
  });
  msgEl.appendChild(wrap);
}

function bindExportButtons(container) {
  container.querySelectorAll('.export-btn').forEach(btn => {
    btn.addEventListener('click', async function () {
      const format = this.dataset.format;
      const id = this.dataset.id;
      const slug = window.PROJECT_SLUG || 'chat';
      const date = new Date().toISOString().slice(0, 10);
      const filename = `${slug}-${date}`;

      this.textContent = '…';

      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgId: id, format, filename }),
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
      this.textContent = format === 'gdoc' ? 'Google Doc' : format === 'pdf' ? 'PDF' : 'Word';
    });
  });
}

// Bind existing export buttons and init stars for history messages
document.querySelectorAll('.message-meta').forEach(bindExportButtons);
document.querySelectorAll('.message-assistant[data-id]').forEach(el => {
  addStars(el, el.dataset.id, parseInt(el.dataset.rating) || 0);
});

function scrollToBottom() {
  const m = document.getElementById('messages');
  m.scrollTop = m.scrollHeight;
}

scrollToBottom();

// File upload
(function() {
  const input = document.getElementById('attach-input');
  const status = document.getElementById('upload-status');
  if (!input) return;

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    const projectSlug = window.PROJECT_SLUG || '';
    const model = document.getElementById('model-select').value;

    status.textContent = `Uploading ${file.name}…`;

    const autoAnalyse = document.getElementById('auto-analyse-check')?.checked !== false;
    const analysisPrompt = localStorage.getItem('analysisPrompt') || DEFAULT_ANALYSIS_PROMPT;

    const fd = new FormData();
    fd.append('file', file);
    if (projectSlug) fd.append('projectSlug', projectSlug);
    if (window.CONV_ID) fd.append('convId', window.CONV_ID);
    fd.append('model', model);
    fd.append('autoAnalyse', autoAnalyse ? '1' : '0');
    fd.append('analysisPrompt', analysisPrompt);

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });

      // Project upload: JSON response, no streaming
      if (projectSlug) {
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Upload failed' }));
          status.textContent = `✖ ${err.error}`;
          return;
        }
        const data = await res.json();
        status.textContent = `✓ Saved ${data.document.filename} to /${data.document.project}`;
        input.value = '';
        setTimeout(() => { status.textContent = ''; }, 4000);
        return;
      }

      // Chat upload (no auto-analyse): JSON response, just show the file message
      if (!autoAnalyse) {
        const data = await res.json();
        if (data.userMessage) appendMessage('user', data.userMessage);
        if (data.convId && !window.CONV_ID) {
          window.CONV_ID = data.convId;
          history.replaceState(null, '', `/c/${data.convId}`);
        }
        status.textContent = `✓ ${file.name} added — ask your question`;
        setTimeout(() => { status.textContent = ''; }, 4000);
        return;
      }

      // Chat upload (auto-analyse): SSE stream. Render the user message first, then stream reply.
      status.textContent = `Analysing ${file.name}…`;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let asstEl = null;
      let contentEl = null;
      let fullContent = '';

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
            if (data.userMessage) {
              appendMessage('user', data.userMessage);
              asstEl = appendMessage('assistant', '');
              contentEl = asstEl.querySelector('.message-content');
            }
            if (data.chunk && contentEl) {
              fullContent += data.chunk;
              contentEl.innerHTML = renderMarkdownSafe(fullContent);
              contentEl.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
              scrollToBottom();
            }
            if (data.done) {
              if (data.convId && !window.CONV_ID) {
                window.CONV_ID = data.convId;
                history.replaceState(null, '', `/c/${data.convId}`);
              }
              if (asstEl) {
                asstEl.dataset.id = data.msgId;
                addExportButtons(asstEl, data.msgId, data.model, data.tokensIn, data.tokensOut, data.costUsd, data.modelId);
              }
              status.textContent = '';
            }
            if (data.error) {
              if (contentEl) contentEl.textContent = data.error;
              status.textContent = `✖ ${data.error}`;
            }
          } catch (_) {}
        }
      }
    } catch (err) {
      status.textContent = `✖ ${err.message}`;
    } finally {
      input.value = '';
    }
  });
})();

// ── Upload-to-project modal ────────────────────────────────────────────────
(function() {
  const openBtn = document.getElementById('open-upload-modal');
  const modal = document.getElementById('upload-modal');
  const backdrop = document.getElementById('upload-modal-backdrop');
  const cancelBtn = document.getElementById('upload-modal-cancel');
  const submitBtn = document.getElementById('upload-modal-submit');
  const fileInput = document.getElementById('upload-modal-file');
  const projectSel = document.getElementById('upload-project-select');
  const statusEl = document.getElementById('upload-modal-status');
  if (!openBtn || !modal) return;

  function open() {
    modal.classList.add('open');
    backdrop.classList.add('active');
    statusEl.textContent = '';
  }
  function close() {
    modal.classList.remove('open');
    backdrop.classList.remove('active');
    fileInput.value = '';
  }
  openBtn.addEventListener('click', open);
  backdrop.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);

  submitBtn.addEventListener('click', async () => {
    const file = fileInput.files?.[0];
    const slug = projectSel.value;
    if (!file) { statusEl.textContent = 'Pick a file first.'; return; }
    if (!slug) { statusEl.textContent = 'Pick a project.'; return; }
    submitBtn.disabled = true;
    statusEl.textContent = `Uploading ${file.name}…`;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('projectSlug', slug);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) { statusEl.textContent = `✖ ${data.error}`; submitBtn.disabled = false; return; }
      statusEl.textContent = `✓ Saved ${data.document.filename} to /${data.document.project}`;
      submitBtn.disabled = false;
      // If currently viewing that project, refresh docs list
      if (window.PROJECT_SLUG === slug) loadDocs();
      setTimeout(close, 900);
    } catch (err) {
      statusEl.textContent = `✖ ${err.message}`;
      submitBtn.disabled = false;
    }
  });
})();

// ── Project documents panel ────────────────────────────────────────────────
async function loadDocs() {
  const panel = document.getElementById('project-docs');
  if (!panel) return;
  const slug = panel.dataset.slug;
  const listEl = document.getElementById('docs-list');
  const countEl = document.getElementById('docs-count');
  try {
    const res = await fetch(`/api/projects/${slug}/documents`);
    const data = await res.json();
    const docs = data.documents || [];
    countEl.textContent = `(${docs.length})`;
    listEl.innerHTML = docs.map(d => `
      <li class="doc-item" data-id="${d.id}">
        <a class="doc-link" href="#" data-id="${d.id}" data-filename="${d.filename}">📄 ${d.filename}</a>
        <span class="doc-size">${(d.size_bytes/1024).toFixed(1)} KB</span>
        <button class="doc-delete" data-id="${d.id}" title="Delete">×</button>
      </li>
    `).join('') || '<li style="padding:8px 12px;color:var(--text-muted);font-size:13px;">No documents yet.</li>';
    listEl.querySelectorAll('.doc-link').forEach(a => a.addEventListener('click', viewDoc));
    listEl.querySelectorAll('.doc-delete').forEach(b => b.addEventListener('click', deleteDoc));
  } catch (err) {
    countEl.textContent = '(error)';
  }
}

async function viewDoc(e) {
  e.preventDefault();
  const id = this.dataset.id;
  const filename = this.dataset.filename;
  const res = await fetch(`/api/documents/${id}`);
  const data = await res.json();
  document.getElementById('doc-viewer-title').textContent = filename;
  document.getElementById('doc-viewer-body').textContent = data.markdown;
  document.getElementById('doc-viewer').classList.add('open');
  document.getElementById('doc-viewer-backdrop').classList.add('active');
}

async function deleteDoc(e) {
  const id = this.dataset.id;
  if (!confirm('Delete this document?')) return;
  const res = await fetch(`/api/documents/${id}/delete`, { method: 'POST' });
  if (res.ok) loadDocs();
}

(function initDocsPanel() {
  const panel = document.getElementById('project-docs');
  if (!panel) return;
  loadDocs();

  // Inline upload from docs head
  const btn = document.getElementById('docs-upload-here');
  const input = document.getElementById('docs-upload-input');
  const slug = panel.dataset.slug;
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('projectSlug', slug);
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    if (res.ok) loadDocs();
    input.value = '';
  });

  // Doc viewer close
  const vb = document.getElementById('doc-viewer-backdrop');
  const vc = document.getElementById('doc-viewer-close');
  function closeViewer() {
    document.getElementById('doc-viewer').classList.remove('open');
    vb.classList.remove('active');
  }
  vb.addEventListener('click', closeViewer);
  vc.addEventListener('click', closeViewer);
})();

// Mobile sidebar toggle
(function() {
  const btn = document.getElementById('mobile-menu-btn');
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (!btn || !sidebar || !overlay) return;
  function close() { sidebar.classList.remove('open'); overlay.classList.remove('active'); }
  btn.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('active');
  });
  overlay.addEventListener('click', close);
  sidebar.querySelectorAll('a').forEach(a => a.addEventListener('click', close));
})();
