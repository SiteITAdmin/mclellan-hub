// McLellan Hub — Google Chat CRM Bot
// Paste this into a new Google Apps Script project at script.google.com

var DCHAT_WEBHOOK = 'https://dchat.mclellan.scot/api/crm/webhook';
var DCHAT_SECRET  = '548a5859aadbb2b768f367b3da3654dd1222aa215b26f998839bbcbf86791db7';
var DCHAT_USER    = 'douglas';

// Incoming webhook — used to post replies back to the CRM space
// This is the same webhook already used for morning briefings
var GCHAT_REPLY_WEBHOOK = 'https://chat.googleapis.com/v1/spaces/AAQAjlR2tlk/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=6dki0RUdGAc1VtCSYGMVTlzpd-i_j5JR4ItPoaaBe_4';

// ── Received a message ────────────────────────────────────────────────────────
function onMessage(event) {
  try {
    var msg = (event && event.message)
           || (event && event.chat && event.chat.messagePayload && event.chat.messagePayload.message)
           || {};

    // Ignore bot/webhook messages — prevents reply loops
    if (!msg.sender || msg.sender.type !== 'HUMAN') return {};

    var raw = msg.text || msg.argumentText || '';
    console.log('raw: [' + raw + ']');

    var text = raw.replace(/@[^\s]+/g, '').trim().replace(/^\/crm\s*/i, '').trim();

    var response;
    if (!text)                                                                    response = '💬 Send me a note, e.g. "Tom needs to know about Copilot"';
    else if (text.toLowerCase() === 'help')                                       response = helpText();
    else if (text.toLowerCase() === 'briefing' || text.toLowerCase() === 'brief') response = getBriefingText();
    else                                                                          response = forwardToCrm(text, msg.name);

    postReply(response);

  } catch (err) {
    console.log('ERROR: ' + err.message);
    postReply('❌ ' + err.message);
  }
  return {};
}

// ── Post reply via incoming webhook (no OAuth needed) ─────────────────────────
function postReply(text) {
  console.log('replying: [' + text.slice(0, 100) + ']');
  try {
    UrlFetchApp.fetch(GCHAT_REPLY_WEBHOOK, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ text: text }),
      muteHttpExceptions: true,
    });
  } catch (err) {
    console.log('postReply error: ' + err.message);
  }
}

// ── Forward note to dchat ─────────────────────────────────────────────────────
function forwardToCrm(text, msgName) {
  console.log('forwarding: [' + text + ']');
  try {
    var response = UrlFetchApp.fetch(DCHAT_WEBHOOK, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + DCHAT_SECRET },
      payload: JSON.stringify({ text: text, user: DCHAT_USER, source: 'google-chat', dedup_key: msgName || null }),
      muteHttpExceptions: true,
    });
    var code = response.getResponseCode();
    var body = response.getContentText();
    console.log('dchat: ' + code + ' | ' + body);
    if (code !== 200) return '❌ dchat error (' + code + ')';
    var result = JSON.parse(body);
    return result.ok ? '✅ ' + stripMarkdown(result.message) : '⚠️ ' + result.message;
  } catch (err) {
    console.log('forwardToCrm error: ' + err.message);
    return '❌ ' + err.message;
  }
}

// ── Trigger briefing push ─────────────────────────────────────────────────────
function getBriefingText() {
  try {
    var response = UrlFetchApp.fetch(DCHAT_WEBHOOK.replace('/webhook', '/briefing-push'), {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + DCHAT_SECRET },
      payload: JSON.stringify({ user: DCHAT_USER }),
      muteHttpExceptions: true,
    });
    var code = response.getResponseCode();
    return code === 200 ? '📋 Briefing incoming.' : '⚠️ Could not push briefing (' + code + ')';
  } catch (err) {
    return '❌ ' + err.message;
  }
}

// ── Bot added to a space ──────────────────────────────────────────────────────
function onAddedToSpace(event) {
  postReply('👋 *McLellan CRM Bot* connected.\n\n• ' + helpText());
  return {};
}

// ── Bot removed ───────────────────────────────────────────────────────────────
function onRemovedFromSpace(event) {
  console.log('removed from space');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function helpText() {
  return [
    '"Tom needs to know about Copilot" — saves an action',
    '"told Tom about Copilot" — marks done, creates follow-up',
    '"Tom said he loved it" — closes the follow-up',
    '"Beacon is my employer" — saves world context',
    '"briefing" — push today\'s open items here',
  ].join('\n• ');
}

function stripMarkdown(text) {
  return (text || '').replace(/\*\*(.*?)\*\*/g, '$1').replace(/~~(.*?)~~/g, '$1');
}
