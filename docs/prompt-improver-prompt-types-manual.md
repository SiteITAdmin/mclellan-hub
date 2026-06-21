# Prompt Improver Prompt Types Manual

This manual explains the prompt types currently recognised by the prompt improver and how to write for each one. It is based on the imported production prompt library snapshot from `data/prod-snapshots/20260620T143029Z/hub.db`, which contained 1,022 prompts.

The key thing to remember: the sense check is not asking "what subject am I thinking about?" It is asking "what job is this prompt asking an AI system to do, with what inputs, tools, risk, and proof?"

That is why a prompt can feel like "research" to you but be classified as a review gate, evaluator, coding harness, or document synthesis task by the tool.

## How The Tool Reads A Prompt

The improver classifies a prompt across several dimensions:

- `purpose`: the main library bucket, such as deep research or coding harness.
- `function_type`: the behaviour requested, such as draft, evaluate, review, diagnose, decide, generate, or interview.
- `artifact_type`: what the model is producing, such as a memo, report, rubric, work order, coding prompt, or general prompt.
- `interaction_type`: whether it is one-shot, an interview, or a staged workflow.
- `input_types`: whether it needs free text, documents, web sources, data, repository/code, or a mix.
- `tool_needs`: whether it needs no tools, document reading, web search, spreadsheet/data tools, repository tools, or thread controls.
- `risk_level`: whether the task needs ordinary self-checking, source tracing, or human review.

If the sense check disagrees with you, look first at verbs and inputs:

- "Write a report from these PDFs" usually becomes document synthesis or report generation.
- "Compare vendors using sources" usually becomes deep research or rubric evaluation.
- "Review this output before I send it" usually becomes review gate.
- "Score this candidate/product/process" usually becomes rubric evaluation.
- "Ask me questions one at a time" usually becomes workflow builder.
- "Inspect the repo, edit files, run tests" usually becomes coding harness.

## Current Library Shape

The imported examples are distributed like this:

| Purpose | Count |
| --- | ---: |
| General prompt improvement | 196 |
| Document synthesis | 191 |
| Coding harness instructions | 169 |
| Deep research | 145 |
| Review or verification gate | 115 |
| Workflow or interview prompt | 89 |
| Report generation | 69 |
| Rubric or evaluator | 44 |
| Agent orchestration | 4 |

`Agent orchestration` appears in the imported examples as a specialist bucket. If it is not available in the purpose dropdown, use `Workflow or interview prompt` for thread/process coordination, or `Coding harness instructions` when the agent must touch a repository.

The largest behavioural group is `evaluate`, followed by `generate`, `review`, `other`, `draft`, `diagnose`, `decide`, and `interview`. Over half the prompts are interview-style, which means many examples are not simple "do this once" prompts; they are designed to ask questions before producing the final artifact.

## Universal Good Prompt Shape

A strong prompt normally names:

1. Role: who the AI should behave as.
2. Job: the exact task, in one sentence.
3. Inputs: what material it may use.
4. Process: what steps it must follow.
5. Output: the required artifact and format.
6. Evidence: what must be cited, traced, verified, or flagged.
7. Stop rules: when to ask, refuse, or pause.
8. Review standard: what "good enough" means.

Bad prompts usually skip the middle five items. They say what you want, but not what the model must inspect, distinguish, prove, avoid, or return.

## 1. General Prompt Improvement

Use this when the real job is to make a rough instruction clearer. The output is usually a better prompt, not the underlying work product.

Bad prompt:

```text
Improve this prompt for me:

Write a LinkedIn post about AI in work.
```

Why it fails:

- It does not say who the prompt is for.
- It does not define the audience, tone, constraints, or output shape.
- It does not say whether the improved prompt should ask questions first or produce a ready-to-run version.

Improved prompt:

```text
You are improving a rough prompt, not writing the LinkedIn post yet.

Rough prompt:
"Write a LinkedIn post about AI in work."

Create a stronger reusable prompt for generating LinkedIn posts for a senior internal-audit and technology audience.

The improved prompt must include:
- role and audience
- the specific angle to request from the user
- evidence/source expectations
- tone constraints: practical, unsensational, no hype
- output format: hook, body, closing line, and optional comments
- a short self-check before final output

If the rough prompt lacks essential context, include up to 5 clarifying questions before the final improved prompt.
```

## 2. Document Synthesis

Use this when the model must read supplied documents and produce a grounded synthesis. This is not "general writing"; the source set is the boss.

Bad prompt:

```text
Summarise these documents and tell me what matters.
```

Why it fails:

- It does not define the decision or audience.
- It does not separate facts, claims, conflicts, and gaps.
- It invites a fluent summary without source discipline.

Improved prompt:

```text
You are a source-grounded document synthesis assistant.

Task:
Read the attached documents and produce a decision brief for me.

Before writing the brief:
1. Create a source inventory with file name, date if available, source type, apparent authority, and relevance.
2. Identify conflicts, duplicates, superseded material, and missing context.
3. State which sources you will treat as authoritative and why.

Final output:
- Executive summary: 5 bullets maximum
- What the documents support
- What is uncertain or contradicted
- Decisions or actions implied
- Evidence table mapping each important claim to a source

Rules:
- Do not invent facts not present in the documents.
- If a claim is plausible but unsupported, label it "unsupported".
- If documents disagree, preserve the disagreement rather than smoothing it over.
```

## 3. Deep Research

Use this when the prompt needs external or current sources, comparison, market facts, regulation, pricing, standards, or citations.

Bad prompt:

```text
Research the best AI tools for compliance teams and recommend one.
```

Why it fails:

- "Best" has no criteria.
- It does not require current sources.
- It does not separate evidence from opinion.
- It does not define the buyer, constraints, or decision standard.

Improved prompt:

```text
You are a source-grounded research analyst.

Research question:
Which AI tools should a mid-sized financial-services compliance team shortlist for policy, evidence, and control-testing workflows in 2026?

Scope:
- Include only tools with credible public evidence from official product pages, documentation, pricing pages, regulatory/security pages, or reputable third-party analysis.
- Prioritise tools relevant to regulated financial-services teams.
- Exclude generic productivity claims unless tied to a concrete workflow.

Evaluation criteria:
- data access and permissions
- audit trail and evidence traceability
- integration with document repositories or systems of record
- human review controls
- pricing or licensing clarity
- deployment and security posture

Output:
1. Shortlist table with source links.
2. Recommendation by use case, not one universal winner.
3. Key risks and unknowns.
4. Sources used and source dates.

Verification:
Flag any claim that depends on current pricing, product features, or regulation and cite the source used.
```

## 4. Report Generation

Use this when the final deliverable is a memo, briefing, report, board paper, or executive artifact. The model may use documents or research, but the main job is controlled writing.

Bad prompt:

```text
Write me a report on the project status for senior management.
```

Why it fails:

- It gives no audience standard.
- It does not define the source of truth.
- It does not specify structure, length, risk framing, or review criteria.

Improved prompt:

```text
You are writing a concise senior-management status report.

Audience:
Executives who need risks, decisions, and next actions, not activity detail.

Inputs I will provide:
- current project notes
- milestone tracker
- risk log
- recent meeting notes

Process:
1. Identify the current objective, status, blockers, and decisions needed.
2. Separate confirmed facts from interpretation.
3. Pull out risks that require management attention.
4. Avoid listing routine activity unless it changes the decision.

Output:
- Title and reporting date
- Overall status: Green / Amber / Red, with one-sentence rationale
- Progress since last update
- Key risks and mitigations
- Decisions needed
- Next 2 weeks
- Unsupported or missing information

Style:
Plain English, no filler, no "journey" language, no invented certainty.
```

## 5. Coding Harness Instructions

Use this when the AI must work in a codebase, inspect files, use repo tools, edit code, run tests, or review a diff.

Bad prompt:

```text
Fix the bug in the app and make it better.
```

Why it fails:

- It does not define the bug, success criteria, or allowed scope.
- It does not tell the agent how to inspect, edit, or verify.
- "Make it better" invites unrelated refactoring.

Improved prompt:

```text
You are a coding agent working in this repository.

Task:
Fix the bug where saved prompt examples are not shown after import.

Scope:
- Start by reading the route, library, view, and tests related to the prompt improver.
- Make the smallest change that fixes the bug.
- Do not refactor unrelated screens or styling.

Expected behaviour:
- Imported prompt examples appear in the prompt library list.
- They are selectable for adaptation.
- Existing manual prompts still work.

Verification:
- Add or update a focused test if the codebase has a nearby test pattern.
- Run the relevant test command.
- If a test cannot be run, explain why and give the manual check.

Final response:
- files changed
- what changed
- verification performed
- any residual risk
```

## 6. Review Or Verification Gate

Use this when the AI should check whether something is ready, safe, supported, or acceptable. It should not rewrite the whole thing unless asked.

Bad prompt:

```text
Review this and tell me if it is okay.
```

Why it fails:

- "Okay" has no standard.
- It does not say what risks matter.
- It does not force evidence, severity, or a verdict.

Improved prompt:

```text
You are a verification gate.

Review the attached draft before I send it to senior stakeholders.

Assess only these areas:
- factual support
- clarity of recommendation
- missing caveats
- tone and professionalism
- risks of overclaiming
- actions, owners, and dates

Output:
1. Verdict: ready / ready with minor edits / not ready.
2. Blocking issues, ordered by severity.
3. Non-blocking improvements.
4. Claims that need evidence.
5. Exact edits only where necessary.

Rules:
- Do not rewrite the full draft.
- Quote only the short phrase needed to locate an issue.
- If something is fine, say so briefly and move on.
```

## 7. Rubric Or Evaluator

Use this when the model should score, rank, assess, or compare against criteria. The point is the scoring logic, not prose polish.

Bad prompt:

```text
Evaluate this vendor and tell me if they are good.
```

Why it fails:

- It has no scale.
- It has no criteria or evidence requirements.
- It lets the model substitute confidence for judgement.

Improved prompt:

```text
You are a vendor evaluation assessor.

Evaluate the vendor against this 100-point rubric:
- Workflow fit: 20
- Security and permissions: 20
- Audit trail and evidence traceability: 20
- Integration with current systems: 15
- Implementation effort: 10
- Commercial clarity: 10
- Support and operating model: 5

Inputs:
- vendor materials
- notes from demos
- security questionnaire if provided
- any public documentation supplied

Output:
- Scorecard table with score, rationale, and evidence for each criterion
- Red flags
- Questions to ask before purchase
- Recommendation: proceed, proceed with conditions, hold, or reject

Rules:
- If evidence is missing, score conservatively.
- Do not give full marks for roadmap promises.
- Separate "vendor claims" from verified facts.
```

## 8. Workflow Or Interview Prompt

Use this when the AI should guide the user through a process, asking one question at a time or collecting structured context before producing an output.

Bad prompt:

```text
Help me make a plan for using AI in my team.
```

Why it fails:

- It asks for a plan before gathering context.
- It does not control the interview.
- It does not define when the model should stop asking and start producing.

Improved prompt:

```text
You are an AI workflow planning interviewer.

Goal:
Help me choose one practical AI workflow for my team and turn it into a pilot plan.

Interview protocol:
- Ask one question at a time.
- Wait for my answer before asking the next question.
- Ask no more than 8 questions.
- If my answer is vague, ask one clarifying question before moving on.

Questions should cover:
- team and role
- current painful workflow
- inputs and outputs
- systems/tools involved
- review or approval steps
- risk if the AI is wrong
- success measure
- who will own the pilot

After the interview, produce:
- recommended workflow
- why this is the right first pilot
- required data/tools
- human review points
- 2-week pilot plan
- risks and stop conditions
```

## 9. Agent Orchestration

Use this when the prompt is about coordinating agentic work: parent/child threads, handoffs, maintenance loops, goals, agent audits, or thread-level controls.

Bad prompt:

```text
Use agents to work on this project and keep me updated.
```

Why it fails:

- It does not define the parent thread's role.
- It does not define child-thread boundaries.
- It does not say how progress, evidence, or handoff should be reported.

Improved prompt:

```text
You are coordinating agentic work across threads.

Goal:
Complete a small project with 2-3 separable steps while keeping this parent thread responsible for planning, coordination, and final review.

Protocol:
1. Restate the goal in one sentence with success criteria.
2. Split the work into 2-3 child-thread tasks.
3. For each child task, define:
   - exact objective
   - files or systems it may touch
   - evidence it must return
   - what it must not change
4. Start one child task at a time unless parallel work is clearly safe.
5. Summarise child results in the parent thread.
6. Keep a running status: done, in flight, blocked, next.

Final output:
- goal status
- child-thread outcomes
- files or artifacts changed
- verification evidence
- next actions or handoff notes
```

## 10. Drafting Prompt

This is a behavioural type rather than a library purpose. Use it when the model's main job is to write a first version of something from instructions or source material.

Bad prompt:

```text
Draft an email to the client about the delay.
```

Why it fails:

- It lacks relationship context, facts, tone, and desired outcome.
- It does not define what can and cannot be promised.

Improved prompt:

```text
You are drafting a client email.

Context:
- The project milestone will be delayed by one week.
- The cause is late receipt of required access, not client fault.
- We want to preserve trust and avoid sounding defensive.
- Do not promise a new date beyond "by Friday 28 June" unless the facts support it.

Audience:
Client sponsor and project manager.

Output:
- Subject line
- Email body under 220 words
- Tone: calm, accountable, specific
- Include: what changed, impact, revised date, what we are doing next, what we need from them if anything
- Exclude: internal blame, excessive apology, vague reassurance

After the draft, list any assumptions you made.
```

## 11. Diagnostic Prompt

Use this when the task is to find what is wrong, map root causes, or identify gaps before recommending action.

Bad prompt:

```text
Diagnose why our AI process is not working.
```

Why it fails:

- It does not name the process.
- It invites generic advice.
- It does not separate symptoms from causes.

Improved prompt:

```text
You are diagnosing an AI-assisted workflow.

Workflow:
[Describe the workflow in one sentence.]

Inputs I will provide:
- prompt or workflow instructions
- sample outputs
- human corrections
- any tool logs or source documents

Diagnostic process:
1. Restate the intended job of the workflow.
2. Identify visible failure modes in the samples.
3. Separate failures into:
   - unclear job
   - bad or missing inputs
   - wrong tool/model
   - weak evaluation
   - missing human review
   - unrealistic expectation
4. Name the likely root cause and confidence level.
5. Recommend the smallest fix to test first.

Output:
- diagnosis summary
- evidence table
- top 3 fixes in order
- what to measure on the next run
```

## 12. Decision Prompt

Use this when the AI should recommend a choice between options. The key is criteria and trade-offs.

Bad prompt:

```text
Should I use ChatGPT, Claude, or Gemini for this?
```

Why it fails:

- "This" is undefined.
- It does not state constraints, risk, tools, or budget.
- It invites brand preference rather than fit-for-job reasoning.

Improved prompt:

```text
You are helping me choose the right AI tool for one workflow.

Workflow:
[Describe the task I need to do repeatedly.]

Compare these options:
- ChatGPT
- Claude
- Gemini
- Codex or coding-agent tools, if repository work is involved

Criteria:
- input type: free text, documents, data, web, or code
- need for current sources
- need for file or repository tools
- risk if wrong
- output artifact
- privacy or data sensitivity
- cost and speed

Output:
- recommended tool/model surface
- why it fits this workflow
- where the recommendation would change
- minimum verification step before trusting the output

Rules:
- Do not rank tools generally.
- Recommend by workflow, not by brand preference.
```

## 13. One-Shot, Interview, Or Staged Workflow

The same purpose can appear in three interaction styles.

Use one-shot when the input is complete and risk is low.

Bad one-shot:

```text
Make me a strategy.
```

Improved one-shot:

```text
Using only the context below, produce a one-page strategy note with objective, constraints, options, recommendation, risks, and next actions. If a required fact is missing, mark it as an assumption rather than asking follow-up questions.
```

Use interview when the model needs context from you before it can safely answer.

Bad interview:

```text
Ask me stuff and then help.
```

Improved interview:

```text
Ask up to 6 questions, one at a time, to gather the context needed to recommend a first AI workflow pilot. After the sixth answer, stop asking and produce the recommendation.
```

Use staged workflow when there are multiple distinct phases and review points.

Bad staged workflow:

```text
Research, analyse, and write the final report.
```

Improved staged workflow:

```text
Work in three phases:
1. Source plan: propose sources and wait for approval.
2. Evidence review: collect findings, conflicts, and gaps, then wait for approval.
3. Final report: write the report only after phases 1 and 2 are accepted.

Do not proceed to the next phase until I say "approved".
```

## Choosing The Right Purpose In The UI

Use `General prompt improvement` when:

- You want a clearer prompt as the output.
- The underlying task is small or mixed.
- You are not yet sure which specialised bucket applies.

Use `Document synthesis` when:

- Attached files are the source of truth.
- The prompt needs source inventory, conflict handling, or claim tracing.
- The main danger is unsupported synthesis.

Use `Deep research` when:

- The answer depends on current or external facts.
- You need web sources, citations, comparisons, or market/regulatory detail.
- The main danger is stale or unsourced information.

Use `Report generation` when:

- The final artifact is a report, memo, board paper, briefing, or executive note.
- The writing standard and audience matter as much as the analysis.

Use `Coding harness instructions` when:

- The AI must inspect or edit a repository.
- It needs tests, diffs, file paths, PR review, or tool use.
- The final output must include verification of code behaviour.

Use `Review or verification gate` when:

- The model should decide whether something is ready, safe, supported, or acceptable.
- You want findings, severity, and a verdict more than a rewrite.

Use `Rubric or evaluator` when:

- You need scoring, ranking, qualification, or assessment.
- Criteria, weights, and conservative scoring matter.

Use `Workflow or interview prompt` when:

- The model must gather context from you.
- The prompt should ask one question at a time.
- The task is a guided process rather than one response.

Treat imported `Agent orchestration` examples as specialist workflow examples when:

- The job involves parent/child thread coordination, handoffs, agent maintenance, or thread-level operations.
- If the dropdown does not offer this purpose, choose `Workflow or interview prompt`.
- If the task requires repository inspection or code changes, choose `Coding harness instructions`.

## Why Sense Check May Say "Needs Attention"

It usually means one of these:

- The selected purpose does not match the verbs in the rough prompt.
- The selected mode is too light for the risk or tool needs.
- The task needs current facts but the prompt does not require web/source verification.
- The selected examples come from a different purpose and may lend the wrong structure.
- The prompt asks for a serious artifact but lacks evidence rules, stop rules, or an output contract.

Treat this as useful friction. The tool is not saying your intention is wrong; it is saying the runnable instruction does not yet express that intention.

## Fast Repair Checklist

Before clicking "Build adapted prompt", check:

- Did I say what the AI is improving or producing?
- Did I name the audience or user of the output?
- Did I name the allowed inputs?
- Did I say whether external sources are needed?
- Did I say what output format I want?
- Did I include evidence and verification rules?
- Did I include stop/ask rules for missing context?
- Did I choose examples from the same purpose?
- Did I pick a mode heavy enough for the risk?

If a prompt fails sense check, do not just change the dropdown. Rewrite the rough prompt so the job, inputs, tools, and proof match what you actually mean.
