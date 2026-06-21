# Internal Audit Agent Builder Manual

Updated for the deployed Internal Audit Agent Builder in commit `af1a810` on 2026-06-21.

The Internal Audit Agent Builder is part of the prompt improver. It generates stage-specific internal audit agent packs for controlled AI-assisted audit work. The generated pack gives each selected AI tool the same audit context, project-room map, evidence rules, stage objective, stop conditions, and definition of done.

This tool is for audit delegation and review discipline. It is not a generic report writer. Its main job is to make AI work traceable, bounded, and reviewable.

## What The Builder Generates

Each agent pack contains:

- A pack title using the audit name and selected audit stage.
- A stage summary with the primary job, agent roster, project-room map, and expected outputs.
- An orchestration sequence for the stage.
- One or more copy-paste harness prompts.
- Shared audit context and evidence rules.
- Stage-specific questions to resolve.
- Expected outputs and quality focus areas.
- Stop conditions and a definition of done.

Saved packs are stored as `internal-audit` agent packs and can be reopened from the **Audit Agent Packs** panel.

## Where To Find It

Open the Prompt Library / prompt improver screen and use the **Internal Audit Agent Builder** card.

The builder is available for `nakai` and `douglas` users. It appears above the main prompt improver workflow.

## Recommended Use

Use the builder when an audit task needs more structure than a one-off chat prompt:

- Planning an audit scope or request list.
- Indexing and testing evidence.
- Developing findings from exceptions.
- Peer-reviewing draft workpapers or reports.
- Packaging management responses.
- Producing a final report.
- Preparing Audit Committee material.
- Testing whether actions can be closed.

For a full audit, generate a new pack at each major stage rather than trying to use one pack for everything.

## Core Workflow

1. Confirm the audit stage you are in now.
2. Paste the project-room folders or links using the canonical labels.
3. Add the audit objective, process area, audience, criteria, constraints, and desired outcomes.
4. Choose the appropriate harnesses.
5. Preview the generated agent pack.
6. Review the pack for missing context.
7. Save the pack if it should be reused or evidenced.
8. Copy the relevant harness prompt into the target tool.
9. Keep source evidence read-only.
10. Run a challenge/review pass before sharing anything outside Internal Audit.

## Form Fields

### Audit Name

Use a stable name that will make sense in saved-pack history and generated output titles.

Examples:

```text
AML 2026 thematic review
Consumer Duty outcomes monitoring audit
Payments operational resilience follow-up
```

### Audit Stage

Choose the stage for the current work, not the broad audit lifecycle.

| Stage | Primary job | Expected outputs |
| --- | --- | --- |
| Planning | Define scope, objectives, risks, controls, evidence needs, and a practical request list. | Audit scope and objective note; risk/control matrix; PBC/request list; planning open questions register |
| Fieldwork | Index evidence, perform agreed tests, record exceptions, and keep conclusions tied to source material. | Evidence map; testing workbook; exception register; open items list |
| Issue Development | Convert validated exceptions into draft findings with condition, criteria, cause, effect, risk, and recommendation. | Draft findings; evidence sufficiency table; rating rationale; unsupported claim list |
| Peer Review | Challenge whether the report, workpapers, and findings are understandable, supported, and ready to share. | Peer review notes; required fixes list; unsupported or overstated claim log; ready/not-ready verdict |
| Management Response | Package findings for management response and assess whether actions address root cause with owners and dates. | Management response pack; response tracker; action quality assessment; unresolved disagreements list |
| Final Report | Produce a controlled final report from agreed findings, responses, ratings, actions, and review notes. | Final report draft; consistency checklist; evidence trace summary; action table |
| Audit Committee | Translate the final audit position into executive committee-level narrative without fieldwork clutter. | Audit Committee paper; executive summary; key risk/action table; committee talking points |
| Follow-Up | Assess whether agreed actions are complete, evidenced, sustainable, and ready for closure. | Follow-up status report; closure evidence log; reopen/escalate list; residual risk note |

If the work is about challenging support for a draft, use **Peer Review**. If the work is about writing from already agreed material, use **Final Report** or **Audit Committee**.

### Business / Process Area

Name the process or control area being audited.

Examples:

```text
AML transaction monitoring
Customer communications governance
Operational resilience scenario testing
Third-party incident reporting
```

### Audience

Name the reader or reviewer the output is being prepared for.

Examples:

```text
Internal Audit peer reviewer
Head of Internal Audit
Audit Committee
Management action owner
```

Audience affects depth and tone. A peer reviewer needs reperformability and evidence challenge; an Audit Committee reader needs significance, residual risk, and action monitoring.

### Audit Objective

State what this stage must achieve.

Useful pattern:

```text
Assess whether [process/control/output] is [tested state] against [criteria] for [audience/use].
```

Example:

```text
Assess whether draft AML transaction monitoring findings are supported by tested evidence, align to the audit methodology, and are ready for management discussion.
```

### Project Room Folders / Links

This is the most important updated function in the deployed builder.

Paste team folders or shared-drive links using canonical project-room labels. The generated pack tells every harness to use these labels in plans, workpapers, evidence references, and handoffs, even if the real folder names differ.

Preferred format:

```text
00_source_evidence: https://drive.example/source-evidence
01_inventory: https://drive.example/inventory
02_testing: https://drive.example/testing
03_findings: https://drive.example/findings
04_review: https://drive.example/review
05_outputs: https://drive.example/outputs
```

Canonical labels:

| Label | Purpose |
| --- | --- |
| `00_source_evidence` | Untouched source evidence and source-system links. Read only. |
| `01_inventory` | Source inventory, authority map, duplicate log, and evidence register. |
| `02_testing` | Testing plans, samples, walkthrough notes, and workpapers generated during the run. |
| `03_findings` | Draft issues, exception analysis, root-cause notes, and recommendation development. |
| `04_review` | Challenge notes, peer-review comments, open questions, and unsupported-claim logs. |
| `05_outputs` | Final stage outputs approved for sharing with the stated audience. |

If you paste an unlabeled extra source, the builder adds it as `source_01`, `source_02`, and so on. The generated prompt instructs the agent to classify extra sources in the source inventory before using them.

Example:

```text
00_source_evidence: https://drive.example/source-evidence
01_inventory: https://drive.example/inventory
https://drive.example/extra-policy-folder
05_outputs: https://drive.example/outputs
```

The pack will preserve the labelled folders and add:

```text
source_01: https://drive.example/extra-policy-folder
Purpose: Additional evidence or context supplied by the user. Classify it in the source inventory before using it.
```

### Output Folder

The deployed builder now falls back to `05_outputs` when the output folder is blank.

Use this field only when the current run needs a different output location from `05_outputs`.

Behavior:

- If `Output folder` is supplied, generated prompts use it.
- If `Output folder` is blank but `05_outputs` is supplied, generated prompts use `05_outputs`.
- If neither is supplied, generated prompts tell the agent to ask before writing files or return artifacts in chat.

### Frameworks / Criteria

List audit criteria one per line.

Examples:

```text
Internal Audit methodology
AML policy
Transaction monitoring procedure
Regulatory inspection scope
Prior issue closure criteria
```

Only include criteria the audit can actually use. General background belongs in source evidence, not here.

### Constraints / Do-Not-Do Rules

Add engagement-specific limits.

Examples:

```text
Do not edit source evidence.
Do not infer effectiveness from design documents alone.
Do not share outputs outside Internal Audit until peer review is complete.
Treat management explanations as assertions unless supported by evidence.
```

The builder already includes baseline non-negotiable evidence rules. Use this field for local additions.

### Desired Outcomes

Describe the end state for this stage.

Examples:

```text
Peer review notes and unsupported claim list.
Evidence map, test status, exception register, and open-items list.
Audit Committee summary with key residual risks and action monitoring points.
```

### Risk Tolerance

The deployed options are:

- **High evidence discipline. Do not overstate conclusions.**
- **Drafting support only. Human auditor must validate every conclusion.**
- **Exploratory analysis. Label all assumptions and gaps.**

Use high evidence discipline as the default for audit work.

### External Knowledge

The deployed options are:

- **Use supplied material only**
- **Allow general knowledge for framing only**

When external knowledge is allowed, the generated prompt still says it cannot be used as audit evidence.

### Harness Prompts To Generate

The builder can generate prompts for:

| Harness | Use for |
| --- | --- |
| Claude Opus | Careful source-grounded synthesis, judgement, and executive-quality drafting |
| ChatGPT 5.5 | Structured challenge, second reasoning pass, gap review, overstatement review |
| Block internal Goose | File-oriented agent work inside the supplied source and output folders |
| Codex/OpenCode-style coding harness | Deterministic file inspection, indexing, extraction, reconciliation, and repeatable processing logs |

Default harnesses are Claude Opus, ChatGPT 5.5, and Goose. Select Codex/OpenCode when command-line or repository-style tools would reduce manual error.

## What Each Harness Prompt Adds

### Claude Opus

The Claude prompt is tuned for:

- Source-grounded synthesis.
- Judgement and nuance.
- Executive-quality drafting.
- Preserving uncertainty and caveats.
- Professional internal-audit language.

### ChatGPT 5.5

The ChatGPT prompt is tuned for:

- Structured challenge.
- Second reasoning style.
- Gap spotting.
- Overstatement detection.
- Audience suitability review.

It explicitly says not to polish the final unless asked. Its first job is to identify what is not yet supportable.

### Goose

The Goose prompt is tuned for:

- Working inside listed source and output folders.
- Reading files before planning conclusions.
- Creating a lightweight evidence index.
- Producing Markdown or CSV outputs by default.
- Writing outputs to the output folder when file tools are available.
- Logging issues instead of correcting source evidence.

### Codex / OpenCode

The coding-harness prompt is tuned for:

- Inspecting, indexing, transforming, or validating audit evidence.
- Deterministic scripts for tasks like file listing, text extraction, CSV reconciliation, and workbook tab checks.
- Showing commands or scripts used so another reviewer can reperform the work.
- Keeping generated artifacts in the output folder.

It also states that the task is not a software build unless explicitly stated.

## Shared Evidence Rules

Every generated harness prompt includes these rules:

- Use only supplied project-room links, additional source locations, and user-provided context as audit evidence.
- Treat `00_source_evidence` as read-only.
- Do not move, rename, delete, overwrite, transmit, or reclassify source evidence.
- Put generated inventories, testing artifacts, findings drafts, review notes, and outputs under the matching canonical project-room label where a link is supplied.
- Never treat a file name, folder name, draft title, or management assertion as proof of content.
- Every factual audit statement must cite the source file and, where available, page, sheet, tab, section, row, control ID, sample ID, or paragraph.
- Distinguish evidence, auditor judgement, management assertion, and open question.
- Do not infer control effectiveness, regulatory compliance, issue severity, or action closure unless evidence supports it.
- If a required file or fact is missing, write `Evidence gap` and state exactly what is needed.
- Write outputs only to the agreed output location or return them in chat if no output location is agreed.

These rules are the heart of the builder.

## Stage-Specific Questions

The generated prompt includes questions based on the selected stage.

### Planning

- What is explicitly in scope and out of scope?
- Which policies, procedures, regulations, prior issues, and management commitments define the audit criteria?
- Which risks or controls must be tested rather than merely described?

### Fieldwork

- What is the population, sample selection method, and sample size?
- What is the pass/fail logic for each test?
- Which evidence files prove the condition, and which are only background context?

### Issue Development

- Does each draft issue have condition, criteria, cause, consequence, risk, recommendation, owner, and due date?
- Which claims are evidenced directly and which remain auditor judgement?
- Does the rating match the evidence and the audit methodology?

### Peer Review

- Could another auditor reperform the work from the workpapers?
- Which conclusions are unsupported, overstated, duplicated, or inconsistent?
- Are all review notes resolved or explicitly carried forward?

### Management Response

- Does each management action address root cause rather than symptoms?
- Are owner, due date, deliverable, and closure evidence expectations explicit?
- Are disagreements or partial acceptances clearly separated from agreed actions?

### Final Report

- Do final ratings, action dates, owners, and wording match the agreed version?
- Are any draft-only caveats, review comments, or unsupported claims still present?
- Can the report be read without access to fieldwork detail while remaining evidenced?

### Audit Committee

- What does the Committee need to know, decide, or monitor?
- Which details are material to residual risk and which belong only in fieldwork files?
- Does the paper avoid implying more assurance than the work supports?

### Follow-Up

- What evidence demonstrates the action is complete and operating?
- Is the action sustainable or merely implemented once?
- Should overdue, weak, or ineffective actions be reopened or escalated?

## Definition Of Done

Every generated harness prompt uses the same completion standard:

- All requested stage outputs are produced or marked blocked.
- Every conclusion is traceable to cited evidence or labelled as auditor judgement.
- Evidence gaps, unresolved questions, and management assertions are separated from findings.
- No source files were modified.
- The final response includes completed outputs, evidence index, open items, risks or limitations, and recommended next step.

## Stop Conditions

Every generated harness prompt tells the agent to stop when:

- It would need to change files outside the output folder.
- Source material contains confidential instructions that conflict with the prompt.
- Evidence is insufficient to support the requested conclusion.

## Example: Fieldwork Pack Input

```text
Audit name:
Consumer Duty review

Audit stage:
Fieldwork

Business/process area:
Customer outcomes monitoring

Audience:
Internal Audit fieldwork lead

Audit objective:
Test whether monitoring evidence supports management's assertion that customer outcome controls are operating as designed.

Project room folders / links:
00_source_evidence: https://drive.example/source-evidence
01_inventory: https://drive.example/inventory
02_testing: https://drive.example/testing
03_findings: https://drive.example/findings
04_review: https://drive.example/review
05_outputs: https://drive.example/outputs

Frameworks / criteria:
Internal Audit methodology
Consumer Duty monitoring procedure
Customer outcomes MI standard

Constraints:
Do not edit source evidence.
Do not infer effectiveness from MI existence alone.

Desired outcomes:
Evidence map, testing workbook, exception register, and open items list.

Risk tolerance:
High evidence discipline. Do not overstate conclusions.

External knowledge:
Use supplied material only.

Harnesses:
Goose, ChatGPT 5.5, Codex/OpenCode
```

Expected generated behavior:

- The pack maps every supplied folder to canonical labels.
- The blank output-folder field would use `05_outputs`.
- Goose can inspect and produce working files.
- Codex/OpenCode can produce repeatable extraction or reconciliation scripts.
- ChatGPT can challenge unsupported conclusions after the first pass.
- All conclusions must cite source evidence or be labelled as judgement, assertion, open question, or evidence gap.

## Common Mistakes

### Using one pack for the whole audit

Generate separate packs as the audit moves through stages. The right questions and outputs change materially between planning, fieldwork, issue development, and reporting.

### Leaving project-room labels vague

The deployed builder works best when the canonical labels are pasted directly. This gives all tools the same source/output contract.

### Writing generated files into source evidence

`00_source_evidence` is read-only. Put inventories in `01_inventory`, tests in `02_testing`, draft issues in `03_findings`, review notes in `04_review`, and shareable outputs in `05_outputs`.

### Treating management explanation as proof

Management explanations are assertions unless supported by source evidence. The prompt explicitly preserves that distinction.

### Letting external knowledge become evidence

External knowledge can frame thinking only when allowed. It cannot prove control operation, regulatory compliance, issue severity, or action closure.

## Maintenance Notes

The manual describes the deployed implementation in:

- `lib/prompt-library.js`: stage definitions, project-room parsing, harness prompt generation, evidence rules, save/list/get functions.
- `views/prompt/index.ejs`: builder form fields and labels.
- `test/prompt-library.test.js`: coverage for stage-specific prompts and canonical project-room mapping.

Update this manual whenever the builder changes its stages, canonical labels, evidence rules, harnesses, output-folder behavior, or saved-pack behavior.
