// McLellan Hub — CRM Bot
// Paste into Google Apps Script Chat app project.
//
// Required Script Properties:
// - DCHAT_WEBHOOK=https://dchat.mclellan.scot/api/crm/webhook
// - DCHAT_SECRET=<HERMES_WEBHOOK_SECRET>
// - DCHAT_USER=douglas
//
// Optional Script Properties:
// - DCHAT_BASE=https://dchat.mclellan.scot

var CRM_BOT_WEBHOOK = 'https://chat.googleapis.com/v1/spaces/AAQAjlR2tlk/messages?key=REDACTED_GOOGLE_API_KEY&token=REDACTED_GCHAT_WEBHOOK_TOKEN';

function prop(name, fallback) {
  var value = PropertiesService.getScriptProperties().getProperty(name);
  return value || fallback || '';
}

function dchatBase() {
  return prop('DCHAT_BASE', 'https://dchat.mclellan.scot').replace(/\/+$/, '');
}

function dchatWebhook() {
  return prop('DCHAT_WEBHOOK', dchatBase() + '/api/crm/webhook');
}

function dchatSecret() {
  return prop('DCHAT_SECRET');
}

function dchatUser() {
  return prop('DCHAT_USER', 'douglas');
}

// ── Received a message ────────────────────────────────────────────────────────
function onMessage(event) {
  try {
    var msg = (event && event.message)
           || (event && event.chat && event.chat.messagePayload && event.chat.messagePayload.message)
           || {};

    if (!msg.sender || msg.sender.type !== 'HUMAN') return {};

    var raw = msg.text || msg.argumentText || '';
    console.log('raw: [' + raw + ']');

    var text = raw.replace(/@[^\s]+/g, '').trim().replace(/^\/(crm|hermes)\s*/i, '').trim();
    var response = routeCommand(text, msg.name);

    if (response) postReply(response);
  } catch (err) {
    console.log('ERROR: ' + err.message);
    postReply('❌ ' + err.message);
  }
  return {};
}

function onAddedToSpace(event) {
  postReply('👋 *McLellan CRM Bot* connected.\n\n• ' + helpText());
  return {};
}

function onRemovedFromSpace(event) {
  console.log('removed from space');
}

// ── Routing ───────────────────────────────────────────────────────────────────
function extractYouTubeUrl(text) {
  var m = text.match(/https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?[^\s]*v=[a-zA-Z0-9_-]+|youtu\.be\/[a-zA-Z0-9_-]+)[^\s]*/);
  return m ? m[0] : null;
}

function routeCommand(text, msgName) {
  if (!text) return '💬 Send a note, or try "search Dad sore back", "today", "briefing", or "remember ...".';

  var lower = text.toLowerCase();
  if (lower === 'help') return helpText();
  if (lower === 'briefing' || lower === 'brief') return getBriefingText();
  if (lower === 'today' || lower === 'daily') return getDailyNote();
  if (lower.indexOf('search ') === 0) return searchVault(text.slice(7).trim());
  if (lower.indexOf('find ') === 0) return searchVault(text.slice(5).trim());
  if (lower.indexOf('read ') === 0) return readVaultNote(text.slice(5).trim());
  if (lower.indexOf('remember ') === 0) return appendToToday(text.slice(9).trim(), 'Remembered');
  if (lower.indexOf('follow up ') === 0) return appendToToday(text.slice(10).trim(), 'Follow-ups');

  var ytPrefix = lower.indexOf('youtube ') === 0 ? 8 : lower.indexOf('yt ') === 0 ? 3 : 0;
  var ytUrl = ytPrefix ? extractYouTubeUrl(text.slice(ytPrefix)) : extractYouTubeUrl(text);
  if (ytUrl) return ingestYouTube(ytUrl);

  return forwardToCrm(text, msgName);
}

// ── Reply ─────────────────────────────────────────────────────────────────────
function postReply(text) {
  console.log('replying: [' + String(text).slice(0, 100) + ']');
  try {
    UrlFetchApp.fetch(CRM_BOT_WEBHOOK, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ text: String(text).slice(0, 3500) }),
      muteHttpExceptions: true,
    });
  } catch (err) {
    console.log('postReply error: ' + err.message);
  }
}

// ── CRM ───────────────────────────────────────────────────────────────────────
function forwardToCrm(text, msgName) {
  console.log('forwarding CRM note: [' + text + ']');
  try {
    var response = fetchDchat(dchatWebhook(), {
      text: text,
      user: dchatUser(),
      source: 'google-chat',
      dedup_key: msgName || null,
    });
    if (response.code !== 200) return '❌ dchat error (' + response.code + ')';
    var result = JSON.parse(response.body);
    if (result.message === 'Duplicate ignored') return null;
    return result.ok ? '✅ ' + stripMarkdown(result.message) : '⚠️ ' + result.message;
  } catch (err) {
    console.log('forwardToCrm error: ' + err.message);
    return '❌ ' + err.message;
  }
}

function getBriefingText() {
  try {
    var response = fetchDchat(dchatWebhook().replace('/webhook', '/briefing-push'), {
      user: dchatUser(),
    });
    return response.code === 200 ? '📋 Briefing incoming.' : '⚠️ Could not push briefing (' + response.code + ')';
  } catch (err) {
    return '❌ ' + err.message;
  }
}

// ── Vault commands ────────────────────────────────────────────────────────────
function searchVault(query) {
  if (!query) return 'Search for what? Example: search Dad sore back';
  var url = dchatBase() + '/api/obsidian/search?q=' + encodeURIComponent(query) + '&limit=5';
  var response = getDchat(url);
  if (response.code !== 200) return '❌ Vault search error (' + response.code + ')';
  var data = JSON.parse(response.body);
  var results = data.results || [];
  if (!results.length) return 'No vault matches for: ' + query;
  return results.map(function (r, i) {
    return (i + 1) + '. ' + r.path + '\n' + (r.excerpt || '').slice(0, 280);
  }).join('\n\n');
}

function readVaultNote(notePath) {
  if (!notePath) return 'Read which note? Example: read Daily/2026-05-13.md';
  var url = dchatBase() + '/api/obsidian/note?path=' + encodeURIComponent(notePath);
  var response = getDchat(url);
  if (response.code === 404) return 'No such vault note: ' + notePath;
  if (response.code !== 200) return '❌ Vault read error (' + response.code + ')';
  var data = JSON.parse(response.body);
  return data.path + '\n\n' + String(data.content || '').slice(0, 3000);
}

function getDailyNote() {
  return readVaultNote('Daily/' + todayIso() + '.md');
}

function ingestYouTube(url) {
  if (!url) return 'Ingest which YouTube URL? Example: youtube https://youtu.be/abc123';
  var response = fetchDchat(dchatBase() + '/api/synthadoc/ingest-url', {
    url: url,
    user: dchatUser(),
  });
  if (response.code === 202 || response.code === 200) return '📥 YouTube queued for ingest: ' + url;
  return '❌ Ingest failed (' + response.code + ')';
}

function appendToToday(text, section) {
  if (!text) return 'Append what?';
  var content = '\n## ' + section + '\n- ' + text + '\n';
  var response = fetchDchat(dchatBase() + '/api/obsidian/note', {
    path: 'Daily/' + todayIso() + '.md',
    mode: 'append',
    content: content,
  });
  try {
    var crmText = section === 'Follow-ups' ? 'follow up: ' + text : text;
    fetchDchat(dchatWebhook(), {
      text: crmText,
      user: dchatUser(),
      source: 'hermes-remember',
    });
  } catch (e) {
    console.log('CRM forward skipped: ' + e.message);
  }
  if (response.code !== 200) return '❌ Could not append to today (' + response.code + ')';
  return '✅ Added to Daily/' + todayIso() + '.md';
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function getDchat(url) {
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + dchatSecret() },
    muteHttpExceptions: true,
  });
  return { code: response.getResponseCode(), body: response.getContentText() };
}

function fetchDchat(url, payload) {
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + dchatSecret() },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  return { code: response.getResponseCode(), body: response.getContentText() };
}

function todayIso() {
  return Utilities.formatDate(new Date(), 'Europe/Dublin', 'yyyy-MM-dd');
}

function helpText() {
  return [
    '"Had a call with Karol — she\'s pushing for June" — saves a CRM note',
    '"briefing" — push today\'s open CRM items',
    '"today" — read today\'s Obsidian daily note',
    '"search Dad physio" — search the vault',
    '"remember ..." — append a note to today\'s daily note',
    '"follow up ..." — append a follow-up to today\'s daily note',
    '"youtube <url>" — queue a YouTube video for the wiki',
  ].join('\n• ');
}

function stripMarkdown(text) {
  return (text || '').replace(/\*\*(.*?)\*\*/g, '$1').replace(/~~(.*?)~~/g, '$1');
}
