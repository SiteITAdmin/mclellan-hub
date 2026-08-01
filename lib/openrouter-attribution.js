'use strict';

const TASK_CODES = Object.freeze({
  CHAT: 'UT-Chat',
  CHAT_RESEARCH: 'UT-ChatResearch',
  IMAGE: 'UT-Image',
  TESTBENCH: 'UT-Testbench',
  PROMPT_LIBRARY: 'UT-PromptLibrary',
  PROMPT_ADAPTER: 'UT-PromptAdapter',
  PROMPT_OPTIMIZER: 'UT-PromptOptimizer',
  PROMPT_QUICK_IMPROVER: 'UT-PromptQuickImprover',
  NEWSLETTER: 'UT-Newsletter',
  NEWSLETTER_RETRIEVAL: 'UT-NewsletterRetrieval',
  NEWSLETTER_BRIEFING: 'UT-NewsletterBriefing',
  DEBRIEF: 'UT-Debrief',
  MEETING_INTAKE: 'UT-MeetingIntake',
  DOCUMENT_TASKS: 'UT-DocumentTasks',
  DOCUMENT_ANALYSIS: 'UT-DocumentAnalysis',
  CRM: 'UT-CRM',
  HERMES_CRM_CAPTURE: 'UT-HermesCrmCapture',
  CONTENT: 'UT-Content',
  LINKEDIN_PLANNER: 'UT-LinkedInPlanner',
  LINKEDIN_SYNTHESISER: 'UT-LinkedInSynthesiser',
  LINKEDIN_DRAFTER: 'UT-LinkedInDrafter',
  LINKEDIN_SCORER: 'UT-LinkedInScorer',
  LINKEDIN_CAROUSEL: 'UT-LinkedInCarousel',
  LINKEDIN_CAROUSEL_REVIEWER: 'UT-LinkedInCarouselReviewer',
  LINKEDIN_REFINER: 'UT-LinkedInRefiner',
  LINKEDIN_IMAGE_PROMPT: 'UT-LinkedInImagePrompt',
  WIKI: 'UT-Wiki',
  ADMIN: 'UT-Admin',
  NEWSLETTER_INGEST: 'AT-NewsletterIngest',
  AGENTMAIL: 'AT-AgentMail',
  EMAIL_CLASSIFICATION: 'AT-EmailClassification',
  SUGGESTIONS: 'AT-Suggestions',
  SUGGESTION_CONTENT: 'AT-SuggestionContent',
  SUGGESTION_TRAVEL: 'AT-SuggestionTravel',
  TRAVEL_PRICE_EXTRACT: 'AT-TravelPriceExtract',
  TASK_LEARNING: 'AT-TaskLearning',
  WEEKLY_DIGEST: 'AT-WeeklyDigest',
  DAILY_DIGEST: 'AT-DailyDigest',
  REGULATORY_MONITOR: 'AT-RegulatoryMonitor',
  NAKAI_DAILY_BRIEFING: 'AT-NakaiDailyBriefing',
  M365_DAILY_BRIEFING: 'AT-M365DailyBriefing',
  US_BLOCK_SPECIAL_BRIEFING: 'AT-USBlockSpecialBriefing',
  MYCELIUM: 'AT-Mycelium',
  WORKDAY_INGEST: 'AT-WorkdayIngest',
  WIKI_INGEST: 'AT-WikiIngest',
  WIKI_LINKING: 'AT-WikiLinking',
  WIKI_QA_SAVE: 'AT-WikiQaSave',
  WIKI_DOC_PAGE: 'AT-WikiDocPage',
  WIKI_IMAGE_VISION: 'AT-WikiImageVision',
  RECALL_TAGGING: 'AT-RecallTagging',
  EMBEDDINGS: 'AT-Embeddings',
  SYNTHESIS: 'AT-Synthesis',
  KNOWLEDGE_SYNTHESIS: 'AT-KnowledgeSynthesis',
  KNOWLEDGE_QUERY: 'UT-KnowledgeQuery',
  HUMANIZER: 'UT-Humanizer',
  STYLE_DISTILLER: 'AT-StyleDistiller',
  REPAIR_TRIAGE: 'AT-RepairTriage',
  REPAIR_AGENT: 'AT-RepairAgent',
  MODEL_EFFECTIVENESS_REVIEW: 'AT-ModelEffectivenessReview',
});

const FEATURE_TASK_CODES = Object.freeze({
  'agentmail-work-extractor': TASK_CODES.AGENTMAIL,
  'agentmail_extractor': TASK_CODES.AGENTMAIL,
  'crm-intent': TASK_CODES.CRM,
  'doc-task-extractor': TASK_CODES.DOCUMENT_TASKS,
  'email-classifier': TASK_CODES.EMAIL_CLASSIFICATION,
  'email_classifier': TASK_CODES.EMAIL_CLASSIFICATION,
  'email_classifier_sent': TASK_CODES.EMAIL_CLASSIFICATION,
  'hermes-crm-capture': TASK_CODES.HERMES_CRM_CAPTURE,
  'meeting-intake': TASK_CODES.MEETING_INTAKE,
  'linkedin-pipeline': TASK_CODES.CONTENT,
  'linkedin-planner': TASK_CODES.LINKEDIN_PLANNER,
  'linkedin-synthesiser': TASK_CODES.LINKEDIN_SYNTHESISER,
  'linkedin-drafter': TASK_CODES.LINKEDIN_DRAFTER,
  'linkedin-scorer': TASK_CODES.LINKEDIN_SCORER,
  'linkedin-carousel': TASK_CODES.LINKEDIN_CAROUSEL,
  'linkedin-carousel-reviewer': TASK_CODES.LINKEDIN_CAROUSEL_REVIEWER,
  'linkedin-refiner': TASK_CODES.LINKEDIN_REFINER,
  'linkedin-image-prompt': TASK_CODES.LINKEDIN_IMAGE_PROMPT,
  'mycelium-doc-tasks': TASK_CODES.MYCELIUM,
  'newsletter-extractor': TASK_CODES.NEWSLETTER_INGEST,
  'newsletter-retrieval': TASK_CODES.NEWSLETTER_RETRIEVAL,
  'newsletter_retrieval': TASK_CODES.NEWSLETTER_RETRIEVAL,
  'wiki_search': TASK_CODES.WIKI,
  'wiki-search': TASK_CODES.WIKI,
  'daily_digest': TASK_CODES.DAILY_DIGEST,
  'daily-digest': TASK_CODES.DAILY_DIGEST,
  'clarification_answer': TASK_CODES.ADMIN,
  'workday_transcription': TASK_CODES.WORKDAY_INGEST,
  'newsletter_briefing': TASK_CODES.NEWSLETTER_BRIEFING,
  'nakai-daily-briefing': TASK_CODES.NAKAI_DAILY_BRIEFING,
  'nakai_daily_briefing': TASK_CODES.NAKAI_DAILY_BRIEFING,
  'm365-daily-briefing': TASK_CODES.M365_DAILY_BRIEFING,
  'm365_daily_briefing': TASK_CODES.M365_DAILY_BRIEFING,
  'us-block-special-briefing': TASK_CODES.US_BLOCK_SPECIAL_BRIEFING,
  'us_block_special_briefing': TASK_CODES.US_BLOCK_SPECIAL_BRIEFING,
  'prompt-adapter': TASK_CODES.PROMPT_ADAPTER,
  'prompt-optimizer': TASK_CODES.PROMPT_OPTIMIZER,
  'testbench-prompt-improver': TASK_CODES.PROMPT_QUICK_IMPROVER,
  'recall-tagging': TASK_CODES.RECALL_TAGGING,
  'embeddings': TASK_CODES.EMBEDDINGS,
  'synthesis': TASK_CODES.SYNTHESIS,
  'regulatory-monitor': TASK_CODES.REGULATORY_MONITOR,
  'suggestion-engine': TASK_CODES.SUGGESTIONS,
  'suggestion-content': TASK_CODES.SUGGESTION_CONTENT,
  'suggestion-travel': TASK_CODES.SUGGESTION_TRAVEL,
  'travel-price-extract': TASK_CODES.TRAVEL_PRICE_EXTRACT,
  'task-wrong-learning': TASK_CODES.TASK_LEARNING,
  'weekly-digest': TASK_CODES.WEEKLY_DIGEST,
  'wiki-qa-save': TASK_CODES.WIKI_QA_SAVE,
  'wiki-save': TASK_CODES.WIKI,
  'wiki-doc-save': TASK_CODES.WIKI_DOC_PAGE,
  'wiki-image-vision': TASK_CODES.WIKI_IMAGE_VISION,
  'wiki-linking': TASK_CODES.WIKI_LINKING,
  'workday-transcription': TASK_CODES.WORKDAY_INGEST,
  'ai-humanizer': TASK_CODES.HUMANIZER,
});

const TASK_TITLES = Object.freeze({
  [TASK_CODES.CHAT]: 'McLellan: Hub Chat',
  [TASK_CODES.CHAT_RESEARCH]: 'McLellan: Chat Research',
  [TASK_CODES.IMAGE]: 'McLellan: Image Generation',
  [TASK_CODES.TESTBENCH]: 'McLellan: Admin Testbench',
  [TASK_CODES.PROMPT_LIBRARY]: 'McLellan: Prompt Library',
  [TASK_CODES.PROMPT_ADAPTER]: 'McLellan: Prompt Adapter',
  [TASK_CODES.PROMPT_OPTIMIZER]: 'McLellan: Prompt Optimizer',
  [TASK_CODES.PROMPT_QUICK_IMPROVER]: 'McLellan: Testbench Quick Prompt Improver',
  [TASK_CODES.NEWSLETTER]: 'McLellan: Newsletter Briefing',
  [TASK_CODES.NEWSLETTER_RETRIEVAL]: 'McLellan: Intelligence Briefing Source Selection',
  [TASK_CODES.NEWSLETTER_BRIEFING]: 'McLellan: Intelligence Briefing Writing',
  [TASK_CODES.DEBRIEF]: 'McLellan: Debrief',
  [TASK_CODES.MEETING_INTAKE]: 'McLellan: Meeting Transcript Intake',
  [TASK_CODES.DOCUMENT_TASKS]: 'McLellan: Document Task Extraction',
  [TASK_CODES.DOCUMENT_ANALYSIS]: 'McLellan: Document Analysis',
  [TASK_CODES.CRM]: 'McLellan: CRM Note Parser',
  [TASK_CODES.HERMES_CRM_CAPTURE]: 'McLellan: Hermes CRM Capture',
  [TASK_CODES.CONTENT]: 'McLellan: Content Pipeline',
  [TASK_CODES.LINKEDIN_PLANNER]: 'McLellan: LinkedIn Research Planning',
  [TASK_CODES.LINKEDIN_SYNTHESISER]: 'McLellan: LinkedIn Research Synthesis',
  [TASK_CODES.LINKEDIN_DRAFTER]: 'McLellan: LinkedIn Draft Writing',
  [TASK_CODES.LINKEDIN_SCORER]: 'McLellan: LinkedIn Draft Scoring',
  [TASK_CODES.LINKEDIN_CAROUSEL]: 'McLellan: LinkedIn Carousel Writing',
  [TASK_CODES.LINKEDIN_CAROUSEL_REVIEWER]: 'McLellan: LinkedIn Carousel Review',
  [TASK_CODES.LINKEDIN_REFINER]: 'McLellan: LinkedIn Draft Refinement',
  [TASK_CODES.LINKEDIN_IMAGE_PROMPT]: 'McLellan: LinkedIn Image Prompt',
  [TASK_CODES.WIKI]: 'McLellan: Wiki',
  [TASK_CODES.ADMIN]: 'McLellan: Admin',
  [TASK_CODES.NEWSLETTER_INGEST]: 'McLellan: Intelligence Email Topic Extraction',
  [TASK_CODES.AGENTMAIL]: 'McLellan: AgentMail Work/CRM Extraction',
  [TASK_CODES.EMAIL_CLASSIFICATION]: 'McLellan: Email Routing and CRM Classification',
  [TASK_CODES.SUGGESTIONS]: 'McLellan: Suggestions',
  [TASK_CODES.SUGGESTION_CONTENT]: 'McLellan: Content Suggestions',
  [TASK_CODES.SUGGESTION_TRAVEL]: 'McLellan: Travel Suggestions',
  [TASK_CODES.TRAVEL_PRICE_EXTRACT]: 'McLellan: Travel Price Email Extraction',
  [TASK_CODES.TASK_LEARNING]: 'McLellan: Task Feedback Learning',
  [TASK_CODES.WEEKLY_DIGEST]: 'McLellan: Weekly Digest',
  [TASK_CODES.DAILY_DIGEST]: 'McLellan: Daily Digest',
  [TASK_CODES.REGULATORY_MONITOR]: 'McLellan: Regulatory Monitor',
  [TASK_CODES.NAKAI_DAILY_BRIEFING]: 'McLellan: Nakai Daily Briefing',
  [TASK_CODES.M365_DAILY_BRIEFING]: 'McLellan: M365 Operations & Security Briefing',
  [TASK_CODES.US_BLOCK_SPECIAL_BRIEFING]: 'McLellan: US Block Special Edition',
  [TASK_CODES.MYCELIUM]: 'McLellan: Document Task Extraction',
  [TASK_CODES.WORKDAY_INGEST]: 'McLellan: Workday Ingest',
  [TASK_CODES.WIKI_INGEST]: 'McLellan: Wiki Ingest',
  [TASK_CODES.WIKI_LINKING]: 'McLellan: Wiki Link Discovery',
  [TASK_CODES.WIKI_QA_SAVE]: 'McLellan: Wiki Q&A Page Save',
  [TASK_CODES.WIKI_DOC_PAGE]: 'McLellan: Wiki Document Page Writer',
  [TASK_CODES.WIKI_IMAGE_VISION]: 'McLellan: Wiki Image Vision',
  [TASK_CODES.RECALL_TAGGING]: 'McLellan: Recall Tagging',
  [TASK_CODES.EMBEDDINGS]: 'McLellan: Knowledge Embeddings',
  [TASK_CODES.SYNTHESIS]: 'McLellan: Knowledge Synthesis',
  [TASK_CODES.KNOWLEDGE_SYNTHESIS]: 'McLellan: Cross-Entity Knowledge Synthesis',
  [TASK_CODES.KNOWLEDGE_QUERY]: 'McLellan: Knowledge Query',
  [TASK_CODES.HUMANIZER]: 'McLellan: AI Text Humanizer',
  [TASK_CODES.REPAIR_TRIAGE]: 'McLellan: Self-Repair Triage',
  [TASK_CODES.REPAIR_AGENT]: 'McLellan: Self-Repair Coding Agent',
  [TASK_CODES.MODEL_EFFECTIVENESS_REVIEW]: 'McLellan: Monthly Prompt/Model Effectiveness Review',
});

function normalizeTaskCode(value, fallback = 'AT-Unclassified') {
  const taskCode = String(value || fallback).trim();
  if (/^(AT|UT)-[A-Za-z0-9][A-Za-z0-9-]*$/.test(taskCode)) return taskCode;
  return fallback;
}

function titleForTaskCode(taskCode) {
  const code = normalizeTaskCode(taskCode);
  const prefix = code.startsWith('AT-') ? 'McLellan Auto' : code.startsWith('UT-') ? 'McLellan User' : 'McLellan';
  const label = TASK_TITLES[code] || code.replace(/^(AT|UT)-/, '');
  return `${prefix}: ${label.replace(/^McLellan:\s*/, '')}`;
}

function refererForTaskCode(taskCode, baseUrl = 'https://openrouter.mclellan.scot') {
  const code = normalizeTaskCode(taskCode);
  const slug = code.toLowerCase();
  const parsed = new URL(baseUrl);
  parsed.hostname = `${slug}.${parsed.hostname.replace(/^www\./, '')}`;
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function taskCodeForFeature(feature, fallback = 'AT-Unclassified') {
  return FEATURE_TASK_CODES[feature] || normalizeTaskCode(feature, fallback);
}

function openRouterHeaders(taskCode, {
  apiKey = process.env.OPENROUTER_API_KEY,
  baseUrl = 'https://openrouter.mclellan.scot',
  contentType = 'application/json',
} = {}) {
  const code = normalizeTaskCode(taskCode);
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': contentType,
    'HTTP-Referer': refererForTaskCode(code, baseUrl),
    'X-OpenRouter-Title': titleForTaskCode(code),
    'X-Title': titleForTaskCode(code),
  };
}

module.exports = {
  TASK_CODES,
  TASK_TITLES,
  normalizeTaskCode,
  titleForTaskCode,
  refererForTaskCode,
  taskCodeForFeature,
  openRouterHeaders,
};
