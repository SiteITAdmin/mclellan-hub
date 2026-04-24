let sessionId = null;

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

function renderMarkdownSafe(raw) {
  const html = marked.parse(escapeHtml(raw));
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

const closeBtn = document.getElementById('close-chat');
const drawer = document.getElementById('chat-drawer');
const overlay = document.getElementById('drawer-overlay');
const messagesEl = document.getElementById('drawer-messages');
const inputEl = document.getElementById('drawer-input');
const sendBtn = document.getElementById('drawer-send');
const analyseBtn = document.getElementById('analyse-btn');
const jdInput = document.getElementById('jd-input');
const jdResult = document.getElementById('jd-result');

document.querySelectorAll('#open-chat, #open-chat-2').forEach(b => b.addEventListener('click', openDrawer));
closeBtn.addEventListener('click', closeDrawer);
overlay.addEventListener('click', closeDrawer);

function openDrawer() {
  if (window.innerWidth <= 768) {
    window.location.href = '/chat';
    return;
  }
  drawer.classList.add('open');
  overlay.classList.add('active');
  drawer.removeAttribute('aria-hidden');
  inputEl.focus();
}

function closeDrawer() {
  drawer.classList.remove('open');
  overlay.classList.remove('active');
  drawer.setAttribute('aria-hidden', 'true');
}

sendBtn.addEventListener('click', sendMessage);
inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });

async function sendMessage() {
  const msg = inputEl.value.trim();
  if (!msg) return;
  inputEl.value = '';
  appendDrawerMsg('user', msg);
  const asstEl = appendDrawerMsg('assistant', '');
  const model = document.getElementById('drawer-model')?.value;
  await streamChat('/api/chat', { message: msg, sessionId, model }, asstEl, (data) => {
    if (data.sessionId) sessionId = data.sessionId;
  });
}

analyseBtn.addEventListener('click', async () => {
  const jd = jdInput.value.trim();
  if (!jd) return;
  jdResult.style.display = 'block';
  jdResult.innerHTML = '<em>Analysing…</em>';
  let full = '';
  await streamChat('/api/analyse-jd', { jd }, null, null, (chunk) => {
    full += chunk;
    jdResult.innerHTML = renderMarkdownSafe(full);
  });
});

async function streamChat(url, body, targetEl, onDone, onChunk) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

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
        if (data.chunk) {
          full += data.chunk;
          if (targetEl) {
            targetEl.querySelector('.msg-content').innerHTML = renderMarkdownSafe(full);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
          if (onChunk) onChunk(data.chunk);
        }
        if (data.done && onDone) onDone(data);
      } catch (_) {}
    }
  }
}

function appendDrawerMsg(role, content) {
  const div = document.createElement('div');
  div.className = `drawer-msg drawer-msg-${role}`;
  div.innerHTML = `<div class="msg-content">${content ? renderMarkdownSafe(content) : ''}</div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}
