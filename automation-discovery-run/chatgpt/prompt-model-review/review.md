# Prompt and model governance review

As of: 2026-07-18
OpenRouter catalogue: 439 models
Hub slots: 77 · model catalogue rows: 13 · issues: 25

## Admin locations

- Catalogue: `/admin/models`
- System slots: `/admin/models/system`
- Prompts: `/admin/models/prompts`
- Tiers: `/admin/models/tiers`

## Issues

| Severity | Feature | Finding | Best candidate | Score | Admin |
|---|---|---|---|---:|---|
| error | `wiki_image_vision` | Effective model google/gemini-2.0-flash-001 is unavailable | `google/gemini-2.5-flash` | 0.66 | `/admin/models/system#sys-wiki_image_vision` |
| error | `newsletter_extractor_full` | prompt usage has no SYSTEM_MODEL_GROUPS admin slot | `` |  | `/admin/models/system#sys-newsletter_extractor_full` |
| error | `newsletter_extractor_minimal` | prompt usage has no SYSTEM_MODEL_GROUPS admin slot | `` |  | `/admin/models/system#sys-newsletter_extractor_minimal` |
| error | `suggestion_rule_learner` | prompt usage has no SYSTEM_MODEL_GROUPS admin slot | `` |  | `/admin/models/system#sys-suggestion_rule_learner` |
| warn | `agentmail_extractor` | Effective model google/gemini-3.1-pro-preview is not installed in /admin/models | `google/gemini-3.1-pro-preview` | 1.0 | `/admin/models/system#sys-agentmail_extractor` |
| warn | `ai_humanizer` | Effective model anthropic/claude-sonnet-4-5 is not installed in /admin/models | `anthropic/claude-sonnet-4.5` | 1.0 | `/admin/models/system#sys-ai_humanizer` |
| warn | `consigliere_brief` | Effective model anthropic/claude-sonnet-4-6 is not installed in /admin/models | `anthropic/claude-sonnet-4.6` | 1.0 | `/admin/models/system#sys-consigliere_brief` |
| warn | `content_research_driver` | Effective model x-ai/grok-4.5 is not installed in /admin/models | `x-ai/grok-4.5` | 1.0 | `/admin/models/system#sys-content_research_driver` |
| warn | `debrief_extractor` | Effective model deepseek/deepseek-v3.2 is not installed in /admin/models | `deepseek/deepseek-v3.2` | 1.0 | `/admin/models/system#sys-debrief_extractor` |
| warn | `linkedin_carousel` | Effective model deepseek/deepseek-v4-flash is not installed in /admin/models | `deepseek/deepseek-v4-flash` | 1.0 | `/admin/models/system#sys-linkedin_carousel` |
| warn | `linkedin_carousel_reviewer` | Effective model mistralai/mistral-medium-3 is not installed in /admin/models | `mistralai/mistral-medium-3` | 1.0 | `/admin/models/system#sys-linkedin_carousel_reviewer` |
| warn | `linkedin_drafter` | Effective model deepseek/deepseek-v4-flash is not installed in /admin/models | `deepseek/deepseek-v4-flash` | 1.0 | `/admin/models/system#sys-linkedin_drafter` |
| warn | `linkedin_image` | Effective model deepseek/deepseek-chat is not installed in /admin/models | `deepseek/deepseek-chat` | 1.0 | `/admin/models/system#sys-linkedin_image` |
| warn | `linkedin_planner` | Effective model deepseek/deepseek-v3.2 is not installed in /admin/models | `deepseek/deepseek-v3.2` | 1.0 | `/admin/models/system#sys-linkedin_planner` |
| warn | `linkedin_refiner` | Effective model mistralai/mistral-medium-3 is not installed in /admin/models | `mistralai/mistral-medium-3` | 1.0 | `/admin/models/system#sys-linkedin_refiner` |
| warn | `linkedin_scorer` | Effective model anthropic/claude-sonnet-4-6 is not installed in /admin/models | `anthropic/claude-sonnet-4.6` | 1.0 | `/admin/models/system#sys-linkedin_scorer` |
| warn | `linkedin_synthesiser` | Effective model anthropic/claude-sonnet-4-6 is not installed in /admin/models | `anthropic/claude-sonnet-4.6` | 1.0 | `/admin/models/system#sys-linkedin_synthesiser` |
| warn | `multisearch_planner` | Effective model deepseek/deepseek-v3.2 is not installed in /admin/models | `deepseek/deepseek-v3.2` | 1.0 | `/admin/models/system#sys-multisearch_planner` |
| warn | `nakai_daily_briefing` | Effective model anthropic/claude-sonnet-4-6 is not installed in /admin/models | `anthropic/claude-sonnet-4.6` | 1.0 | `/admin/models/system#sys-nakai_daily_briefing` |
| warn | `newsletter_briefing` | Effective model anthropic/claude-sonnet-4-6 is not installed in /admin/models | `anthropic/claude-sonnet-4.6` | 1.0 | `/admin/models/system#sys-newsletter_briefing` |
| warn | `prompt_shaper` | Effective model anthropic/claude-sonnet-4-6 is not installed in /admin/models | `anthropic/claude-sonnet-4.6` | 1.0 | `/admin/models/system#sys-prompt_shaper` |
| warn | `recall_tagger` | Effective model meta-llama/llama-3.1-8b-instruct:free is not installed in /admin/models | `meta-llama/llama-3.1-8b-instruct` | 1.0 | `/admin/models/system#sys-recall_tagger` |
| warn | `repair_agent` | Effective model z-ai/glm-5.2 is not installed in /admin/models | `z-ai/glm-5.2` | 1.0 | `/admin/models/system#sys-repair_agent` |
| warn | `style_distiller` | Effective model anthropic/claude-sonnet-4-6 is not installed in /admin/models | `anthropic/claude-sonnet-4.6` | 1.0 | `/admin/models/system#sys-style_distiller` |
| warn | `wiki_image_vision` | Effective model google/gemini-2.0-flash-001 is not installed in /admin/models | `google/gemini-2.5-flash` | 0.66 | `/admin/models/system#sys-wiki_image_vision` |

## Slot inventory

| Group | Feature | Effective model | Health | Model admin | Prompt admin |
|---|---|---|---|---|---|
| Background processing | `admin_synthesiser` | `google/gemini-2.5-flash-lite` | healthy | `/admin/models/system#sys-admin_synthesiser` | `/admin/models/prompts#prompt-admin_synthesiser` |
| Background processing | `agentmail_extractor` | `google/gemini-3.1-pro-preview` | healthy | `/admin/models/system#sys-agentmail_extractor` | `/admin/models/prompts#prompt-agentmail_extractor` |
| Background processing | `consigliere_brief` | `anthropic/claude-sonnet-4-6` | healthy | `/admin/models/system#sys-consigliere_brief` | `/admin/models/prompts#prompt-consigliere_brief` |
| Background processing | `crm_parser` | `google/gemini-2.5-pro-preview` | healthy | `/admin/models/system#sys-crm_parser` | `/admin/models/prompts#prompt-crm_parser` |
| Background processing | `email_classifier` | `google/gemini-2.5-pro-preview` | healthy | `/admin/models/system#sys-email_classifier` | `/admin/models/prompts#prompt-email_classifier` |
| Background processing | `hub_dev_constraint` | `google/gemini-2.5-flash-lite` | healthy | `/admin/models/system#sys-hub_dev_constraint` | `/admin/models/prompts#prompt-hub_dev_constraint` |
| Background processing | `meeting_intake` | `google/gemini-2.5-pro-preview` | healthy | `/admin/models/system#sys-meeting_intake` | `/admin/models/prompts#prompt-meeting_intake` |
| Background processing | `opportunity_extractor` | `google/gemini-2.5-flash` | healthy | `/admin/models/system#sys-opportunity_extractor` | `/admin/models/prompts#prompt-opportunity_extractor` |
| Background processing | `prompt_adapter` | `google/gemini-2.5-pro-preview` | healthy | `/admin/models/system#sys-prompt_adapter` | `/admin/models/prompts#prompt-prompt_adapter` |
| Background processing | `prompt_improver` | `google/gemini-2.5-flash-lite` | healthy | `/admin/models/system#sys-prompt_improver` | `/admin/models/prompts#prompt-prompt_improver` |
| Background processing | `prompt_optimizer` | `google/gemini-2.5-pro-preview` | healthy | `/admin/models/system#sys-prompt_optimizer` | `/admin/models/prompts#prompt-prompt_optimizer` |
| Background processing | `prompt_shaper` | `anthropic/claude-sonnet-4-6` | healthy | `/admin/models/system#sys-prompt_shaper` | `/admin/models/prompts#prompt-prompt_shaper` |
| Background processing | `reg_synopsis` | `google/gemini-2.5-pro-preview` | healthy | `/admin/models/system#sys-reg_synopsis` | `/admin/models/prompts#prompt-reg_synopsis` |
| Background processing | `remediation_advisor` | `google/gemini-2.5-flash` | healthy | `/admin/models/system#sys-remediation_advisor` | `/admin/models/prompts#prompt-remediation_advisor` |
| Background processing | `repair_agent` | `z-ai/glm-5.2` | healthy | `/admin/models/system#sys-repair_agent` | `/admin/models/prompts#prompt-repair_agent` |
| Background processing | `repair_triage` | `google/gemini-2.5-flash` | healthy | `/admin/models/system#sys-repair_triage` | `/admin/models/prompts#prompt-repair_triage` |
| Background processing | `style_distiller` | `anthropic/claude-sonnet-4-6` | healthy | `/admin/models/system#sys-style_distiller` | `/admin/models/prompts#prompt-style_distiller` |
| Background processing | `task_extractor` | `google/gemini-2.5-pro-preview` | healthy | `/admin/models/system#sys-task_extractor` | `/admin/models/prompts#prompt-task_extractor` |
| Background processing | `task_rule_learner` | `` | not-applicable | `/admin/models/system#sys-task_rule_learner` | `/admin/models/prompts#prompt-task_rule_learner` |
| Chat infrastructure | `multisearch_planner` | `deepseek/deepseek-v3.2` | healthy | `/admin/models/system#sys-multisearch_planner` | `/admin/models/prompts#prompt-multisearch_planner` |
| Chat infrastructure | `multisearch_synthesiser` | `google/gemini-2.5-pro-preview` | healthy | `/admin/models/system#sys-multisearch_synthesiser` | `/admin/models/prompts#prompt-multisearch_synthesiser` |
| Chat infrastructure | `recall_tagger` | `meta-llama/llama-3.1-8b-instruct:free` | healthy | `/admin/models/system#sys-recall_tagger` | `/admin/models/prompts#prompt-recall_tagger` |
| CRM knowledge engine | `crm_action_projection` | `anthropic/claude-haiku-4-5` | healthy | `/admin/models/system#sys-crm_action_projection` | `/admin/models/prompts#prompt-crm_action_projection` |
| CRM knowledge engine | `crm_duplicate_review` | `anthropic/claude-haiku-4-5` | healthy | `/admin/models/system#sys-crm_duplicate_review` | `/admin/models/prompts#prompt-crm_duplicate_review` |
| CRM knowledge engine | `crm_source_triage` | `anthropic/claude-haiku-4-5` | healthy | `/admin/models/system#sys-crm_source_triage` | `/admin/models/prompts#prompt-crm_source_triage` |
| CRM reports | `knowledge_query` | `anthropic/claude-haiku-4-5` | healthy | `/admin/models/system#sys-knowledge_query` | `/admin/models/prompts#prompt-knowledge_query` |
| CRM reports | `project_report` | `anthropic/claude-haiku-4-5` | healthy | `/admin/models/system#sys-project_report` | `/admin/models/prompts#prompt-project_report` |
| Daily & weekly reports | `weekly_digest` | `google/gemini-2.5-pro-preview` | healthy | `/admin/models/system#sys-weekly_digest` | `/admin/models/prompts#prompt-weekly_digest` |
| Daily & weekly reports | `work_brief_project_salience` | `` | not-applicable | `/admin/models/system#sys-work_brief_project_salience` | `/admin/models/prompts#prompt-work_brief_project_salience` |
| Daily & weekly reports | `work_brief_recap` | `` | not-applicable | `/admin/models/system#sys-work_brief_recap` | `/admin/models/prompts#prompt-work_brief_recap` |
| Daily & weekly reports | `work_brief_today` | `` | not-applicable | `/admin/models/system#sys-work_brief_today` | `/admin/models/prompts#prompt-work_brief_today` |
| Daily & weekly reports | `work_daily_brief` | `anthropic/claude-haiku-4-5` | healthy | `/admin/models/system#sys-work_daily_brief` | `/admin/models/prompts#prompt-work_daily_brief` |
| Debrief | `debrief_extractor` | `deepseek/deepseek-v3.2` | healthy | `/admin/models/system#sys-debrief_extractor` | `/admin/models/prompts#prompt-debrief_extractor` |
| Debrief | `debrief_interviewer` | `anthropic/claude-haiku-4-5` | healthy | `/admin/models/system#sys-debrief_interviewer` | `/admin/models/prompts#prompt-debrief_interviewer` |
| Debrief | `debrief_transcriber` | `openai/whisper-large-v3` | healthy | `/admin/models/system#sys-debrief_transcriber` | `/admin/models/prompts#prompt-debrief_transcriber` |
| Debrief | `debrief_tts` | `hexgrad/kokoro-82m` | healthy | `/admin/models/system#sys-debrief_tts` | `/admin/models/prompts#prompt-debrief_tts` |
| Debrief | `debrief_tts_voice` | `` | not-applicable | `/admin/models/system#sys-debrief_tts_voice` | `/admin/models/prompts#prompt-debrief_tts_voice` |
| Knowledge layer | `atom_extractor` | `anthropic/claude-haiku-4-5` | healthy | `/admin/models/system#sys-atom_extractor` | `/admin/models/prompts#prompt-atom_extractor` |
| Knowledge layer | `completed_task_atom_extractor` | `anthropic/claude-haiku-4-5` | healthy | `/admin/models/system#sys-completed_task_atom_extractor` | `/admin/models/prompts#prompt-completed_task_atom_extractor` |
| Knowledge layer | `cross_entity_synthesis` | `anthropic/claude-haiku-4-5` | healthy | `/admin/models/system#sys-cross_entity_synthesis` | `/admin/models/prompts#prompt-cross_entity_synthesis` |
| Knowledge layer | `embeddings` | `openai/text-embedding-3-small` | healthy | `/admin/models/system#sys-embeddings` | `/admin/models/prompts#prompt-embeddings` |
| Knowledge layer | `entity_linker` | `anthropic/claude-haiku-4-5` | healthy | `/admin/models/system#sys-entity_linker` | `/admin/models/prompts#prompt-entity_linker` |
| Knowledge layer | `interest_synthesis` | `anthropic/claude-haiku-4-5` | healthy | `/admin/models/system#sys-interest_synthesis` | `/admin/models/prompts#prompt-interest_synthesis` |
| Knowledge layer | `live_thread_synthesis` | `anthropic/claude-haiku-4-5` | healthy | `/admin/models/system#sys-live_thread_synthesis` | `/admin/models/prompts#prompt-live_thread_synthesis` |
| LinkedIn pipeline | `content_research_driver` | `x-ai/grok-4.5` | healthy | `/admin/models/system#sys-content_research_driver` | `/admin/models/prompts#prompt-content_research_driver` |
| LinkedIn pipeline | `linkedin_carousel` | `deepseek/deepseek-v4-flash` | healthy | `/admin/models/system#sys-linkedin_carousel` | `/admin/models/prompts#prompt-linkedin_carousel` |
| LinkedIn pipeline | `linkedin_carousel_reviewer` | `mistralai/mistral-medium-3` | healthy | `/admin/models/system#sys-linkedin_carousel_reviewer` | `/admin/models/prompts#prompt-linkedin_carousel_reviewer` |
| LinkedIn pipeline | `linkedin_drafter` | `deepseek/deepseek-v4-flash` | healthy | `/admin/models/system#sys-linkedin_drafter` | `/admin/models/prompts#prompt-linkedin_drafter` |
| LinkedIn pipeline | `linkedin_image` | `deepseek/deepseek-chat` | healthy | `/admin/models/system#sys-linkedin_image` | `/admin/models/prompts#prompt-linkedin_image` |
| LinkedIn pipeline | `linkedin_planner` | `deepseek/deepseek-v3.2` | healthy | `/admin/models/system#sys-linkedin_planner` | `/admin/models/prompts#prompt-linkedin_planner` |
| LinkedIn pipeline | `linkedin_refiner` | `mistralai/mistral-medium-3` | healthy | `/admin/models/system#sys-linkedin_refiner` | `/admin/models/prompts#prompt-linkedin_refiner` |
| LinkedIn pipeline | `linkedin_scorer` | `anthropic/claude-sonnet-4-6` | healthy | `/admin/models/system#sys-linkedin_scorer` | `/admin/models/prompts#prompt-linkedin_scorer` |
| LinkedIn pipeline | `linkedin_synthesiser` | `anthropic/claude-sonnet-4-6` | healthy | `/admin/models/system#sys-linkedin_synthesiser` | `/admin/models/prompts#prompt-linkedin_synthesiser` |
| LinkedIn pipeline | `linkedin_title` | `anthropic/claude-haiku-4-5` | healthy | `/admin/models/system#sys-linkedin_title` | `/admin/models/prompts#prompt-linkedin_title` |
| LinkedIn tone modifiers | `spiciness_challenging_carousel` | `` | not-applicable | `/admin/models/system#sys-spiciness_challenging_carousel` | `/admin/models/prompts#prompt-spiciness_challenging_carousel` |
| LinkedIn tone modifiers | `spiciness_challenging_drafter` | `` | not-applicable | `/admin/models/system#sys-spiciness_challenging_drafter` | `/admin/models/prompts#prompt-spiciness_challenging_drafter` |
| LinkedIn tone modifiers | `spiciness_challenging_refiner` | `` | not-applicable | `/admin/models/system#sys-spiciness_challenging_refiner` | `/admin/models/prompts#prompt-spiciness_challenging_refiner` |
| LinkedIn tone modifiers | `spiciness_provocative_carousel` | `` | not-applicable | `/admin/models/system#sys-spiciness_provocative_carousel` | `/admin/models/prompts#prompt-spiciness_provocative_carousel` |
| LinkedIn tone modifiers | `spiciness_provocative_drafter` | `` | not-applicable | `/admin/models/system#sys-spiciness_provocative_drafter` | `/admin/models/prompts#prompt-spiciness_provocative_drafter` |
| LinkedIn tone modifiers | `spiciness_provocative_refiner` | `` | not-applicable | `/admin/models/system#sys-spiciness_provocative_refiner` | `/admin/models/prompts#prompt-spiciness_provocative_refiner` |
| Nakai intelligence | `nakai_daily_briefing` | `anthropic/claude-sonnet-4-6` | healthy | `/admin/models/system#sys-nakai_daily_briefing` | `/admin/models/prompts#prompt-nakai_daily_briefing` |
| Nakai intelligence | `nakai_ref_extraction` | `anthropic/claude-haiku-4-5-20251001` | healthy | `/admin/models/system#sys-nakai_ref_extraction` | `/admin/models/prompts#prompt-nakai_ref_extraction` |
| Nakai intelligence | `nakai_ref_synthesis` | `anthropic/claude-haiku-4-5-20251001` | healthy | `/admin/models/system#sys-nakai_ref_synthesis` | `/admin/models/prompts#prompt-nakai_ref_synthesis` |
| Newsletter intelligence | `newsletter_briefing` | `anthropic/claude-sonnet-4-6` | healthy | `/admin/models/system#sys-newsletter_briefing` | `/admin/models/prompts#prompt-newsletter_briefing` |
| Newsletter intelligence | `newsletter_extractor` | `google/gemini-2.5-flash-lite` | healthy | `/admin/models/system#sys-newsletter_extractor` | `/admin/models/prompts#prompt-newsletter_extractor` |
| Public portfolio | `jd_analyser` | `openrouter/free` | healthy | `/admin/models/system#sys-jd_analyser` | `/admin/models/prompts#prompt-jd_analyser` |
| Public portfolio | `portfolio_chat` | `openrouter/free` | healthy | `/admin/models/system#sys-portfolio_chat` | `/admin/models/prompts#prompt-portfolio_chat` |
| Suggestion engine | `salience_search_plan` | `` | not-applicable | `/admin/models/system#sys-salience_search_plan` | `/admin/models/prompts#prompt-salience_search_plan` |
| Suggestion engine | `suggestion_content` | `` | not-applicable | `/admin/models/system#sys-suggestion_content` | `/admin/models/prompts#prompt-suggestion_content` |
| Suggestion engine | `suggestion_opportunity` | `` | not-applicable | `/admin/models/system#sys-suggestion_opportunity` | `/admin/models/prompts#prompt-suggestion_opportunity` |
| Suggestion engine | `suggestion_travel` | `` | not-applicable | `/admin/models/system#sys-suggestion_travel` | `/admin/models/prompts#prompt-suggestion_travel` |
| Suggestion engine | `suggestions` | `google/gemini-2.5-flash` | healthy | `/admin/models/system#sys-suggestions` | `/admin/models/prompts#prompt-suggestions` |
| Suggestion engine | `travel_price_extract` | `` | not-applicable | `/admin/models/system#sys-travel_price_extract` | `/admin/models/prompts#prompt-travel_price_extract` |
| Wiki | `wiki_image_vision` | `google/gemini-2.0-flash-001` | unavailable | `/admin/models/system#sys-wiki_image_vision` | `/admin/models/prompts#prompt-wiki_image_vision` |
| Wiki | `wiki_page_writer` | `google/gemini-2.5-pro-preview` | healthy | `/admin/models/system#sys-wiki_page_writer` | `/admin/models/prompts#prompt-wiki_page_writer` |
| Workday | `workday_narrative` | `openrouter/free` | healthy | `/admin/models/system#sys-workday_narrative` | `/admin/models/prompts#prompt-workday_narrative` |
| Writing tools | `ai_humanizer` | `anthropic/claude-sonnet-4-5` | healthy | `/admin/models/system#sys-ai_humanizer` | `/admin/models/prompts#prompt-ai_humanizer` |

## Safety

This review is read-only. Safe auto-install writes only a disabled catalogue row and never changes a slot assignment or prompt.
