'use strict';

// Local OpenAI-shaped transport used by legacy call sites that formerly hit
// OpenRouter. No network. Routes through the subscription CLI plane.

const { chatJson, chatText } = require('./chat-completions');
const { taskCodeForFeature, normalizeTaskCode } = require('./openrouter-attribution');

function headerValue(headers, name) {
  if (!headers) return '';
  const needle = name.toLowerCase();
  if (headers instanceof Headers) return headers.get(name) || '';
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) if (String(k).toLowerCase() === needle) return String(v || '');
    return '';
  }
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === needle) return String(v || '');
  }
  return '';
}

// Map historical task codes to feature-runner keys.
const TASK_TO_FEATURE = Object.freeze({
  'AT-EmailClassification': 'email_classifier',
  'AT-AgentMail': 'agentmail_extractor',
  'AT-NewsletterIngest': 'newsletter_extractor',
  'AT-Suggestions': 'suggestions',
  'AT-SuggestionContent': 'suggestions',
  'AT-SuggestionTravel': 'suggestion_travel',
  'AT-TravelPriceExtract': 'travel_price_extract',
  'AT-TaskLearning': 'task_rule_learner',
  'AT-WeeklyDigest': 'weekly_digest',
  'AT-DailyDigest': 'daily_digest',
  'AT-RegulatoryMonitor': 'reg_synopsis',
  'AT-NakaiDailyBriefing': 'nakai_daily_briefing',
  'AT-M365DailyBriefing': 'm365_daily_briefing',
  'AT-USBlockSpecialBriefing': 'us_block_special_briefing',
  'AT-Mycelium': 'task_extractor',
  'AT-WorkdayIngest': 'workday_transcription',
  'AT-WikiIngest': 'wiki_page_writer',
  'AT-WikiLinking': 'wiki_page_writer',
  'AT-WikiQaSave': 'wiki_page_writer',
  'AT-WikiDocPage': 'wiki_page_writer',
  'AT-WikiImageVision': 'wiki_image_vision',
  'AT-RecallTagging': 'recall_tagger',
  'AT-Embeddings': 'embeddings',
  'AT-Synthesis': 'synthesis',
  'AT-KnowledgeSynthesis': 'cross_entity_synthesis',
  'AT-StyleDistiller': 'style_distiller',
  'AT-RepairTriage': 'repair_triage',
  'AT-RepairAgent': 'repair_agent',
  'AT-ModelEffectivenessReview': 'model_effectiveness_review',
  'UT-Chat': 'hub_chat',
  'UT-ChatResearch': 'hub_chat_research',
  'UT-Image': 'hub_chat',
  'UT-Testbench': 'testbench',
  'UT-PromptLibrary': 'prompt_adapter',
  'UT-PromptAdapter': 'prompt_adapter',
  'UT-PromptOptimizer': 'prompt_optimizer',
  'UT-PromptQuickImprover': 'prompt_improver',
  'UT-Newsletter': 'newsletter_briefing',
  'UT-NewsletterRetrieval': 'newsletter_retrieval',
  'UT-NewsletterBriefing': 'newsletter_briefing',
  'UT-Debrief': 'debrief_interviewer',
  'UT-MeetingIntake': 'meeting_intake',
  'UT-DocumentTasks': 'task_extractor',
  'UT-DocumentAnalysis': 'task_extractor',
  'UT-CRM': 'crm_parser',
  'UT-HermesCrmCapture': 'hermes_crm_capture',
  'UT-Content': 'linkedin-pipeline',
  'UT-LinkedInPlanner': 'linkedin_planner',
  'UT-LinkedInSynthesiser': 'linkedin_synthesiser',
  'UT-LinkedInDrafter': 'linkedin_drafter',
  'UT-LinkedInScorer': 'linkedin_scorer',
  'UT-LinkedInCarousel': 'linkedin_carousel',
  'UT-LinkedInCarouselReviewer': 'linkedin_carousel_reviewer',
  'UT-LinkedInRefiner': 'linkedin_refiner',
  'UT-LinkedInImagePrompt': 'linkedin_image',
  'UT-Wiki': 'wiki_search',
  'UT-Admin': 'testbench',
  'UT-KnowledgeQuery': 'knowledge_query',
  'UT-Humanizer': 'ai_humanizer',
});

function featureFrom(headers, body) {
  const explicit = headerValue(headers, 'X-Hub-Feature') || headerValue(headers, 'x-hub-feature');
  if (explicit && !/^(AT|UT)-/i.test(explicit)) return explicit;
  const task = headerValue(headers, 'X-Hub-Task-Code') || headerValue(headers, 'x-hub-task-code') || explicit;
  if (task && TASK_TO_FEATURE[task]) return TASK_TO_FEATURE[task];
  if (task) return String(task).toLowerCase().replace(/^at-|^ut-/, '').replace(/-/g, '_');
  void body;
  return 'generic';
}

function jsonResponse(data, status = 200) {
  const body = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'content-type') return 'application/json';
        return null;
      },
    },
    async json() { return data; },
    async text() { return body; },
    async arrayBuffer() { return Buffer.from(body); },
  };
}

function errorResponse(message, status = 500) {
  return jsonResponse({ error: { message } }, status);
}

async function handleChatCompletions(options = {}) {
  let body = {};
  try {
    body = typeof options.body === 'string' ? JSON.parse(options.body) : (options.body || {});
  } catch {
    return errorResponse('invalid JSON body', 400);
  }
  const feature = featureFrom(options.headers, body);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return errorResponse('messages required', 400);

  try {
    if (body.response_format?.type === 'json_object') {
      const obj = await chatJson({
        feature,
        messages,
        modelId: body.model || 'subscription',
        label: `${feature} response`,
      });
      return jsonResponse({
        id: `hub-${Date.now()}`,
        model: `subscription/${feature}`,
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(obj) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
      });
    }
    const text = await chatText({
      feature,
      messages,
      modelId: body.model || 'subscription',
    });
    return jsonResponse({
      id: `hub-${Date.now()}`,
      model: `subscription/${feature}`,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
    });
  } catch (err) {
    return errorResponse(err.message || String(err), 502);
  }
}

async function handleEmbeddings() {
  // Local embeddings may be unavailable; fail closed without OpenRouter.
  return errorResponse(
    'Local embeddings are not configured. Semantic retrieval is temporarily degraded. OpenRouter is retired and will not be used.',
    503,
  );
}

async function handleAudio() {
  return errorResponse(
    'Local speech (STT/TTS) is not configured. OpenRouter is retired and will not be used.',
    503,
  );
}

async function handleModels() {
  // Admin catalogue: subscription runners only.
  return jsonResponse({
    data: [
      { id: 'codex/gpt-5.6-luna', name: 'Codex Luna', architecture: { modality: 'text' } },
      { id: 'codex/gpt-5.6-terra', name: 'Codex Terra', architecture: { modality: 'text' } },
      { id: 'claude/sonnet', name: 'Claude Sonnet', architecture: { modality: 'text' } },
      { id: 'claude/opus', name: 'Claude Opus', architecture: { modality: 'text' } },
      { id: 'grok/grok', name: 'Grok CLI', architecture: { modality: 'text' } },
      { id: 'local/embeddings', name: 'Local embeddings (when configured)', architecture: { modality: 'text' } },
    ],
  });
}

function isHubModelUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'hub-model:';
  } catch {
    return String(url || '').startsWith('hub-model://');
  }
}

async function hubModelFetch(url, options = {}) {
  const path = String(url).replace(/^hub-model:\/\//, '').replace(/^hub-model:/, '');
  if (path.includes('chat/completions')) return handleChatCompletions(options);
  if (path.includes('embeddings')) return handleEmbeddings(options);
  if (path.includes('audio/')) return handleAudio(options);
  if (path.includes('models')) return handleModels(options);
  if (path.includes('generation')) return errorResponse('OpenRouter generation lookup is retired', 410);
  if (path.includes('analytics')) return errorResponse('OpenRouter analytics is retired', 410);
  return errorResponse(`Unknown hub-model path: ${path}`, 404);
}

module.exports = {
  isHubModelUrl,
  hubModelFetch,
  handleChatCompletions,
  featureFrom,
};
