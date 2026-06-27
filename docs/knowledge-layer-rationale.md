# Why the Hub felt like a database — and what we changed

*18 June 2026*

## The dissatisfaction

The Hub started with a real ambition: a second brain. I gave it the right
references — Karpathy's wiki, Hermes' continuous self-improvement, Synthadoc,
Obsidian, the phrase "second brain" itself. The intent was a system where
something I put in one place becomes useful everywhere else, on its own.

What I got instead was a very good 1990s Access database. Every feature, no
matter how it started, ended up as rows in a table joined by foreign keys.
Care-plan ingestion and presentation ingestion went in fine — but the moment I
asked for anything *constructive* back out, it became a CRM: contacts, facts,
tasks, each a record, each linked only to whatever was obvious at the second it
was created.

The test that exposed it: **nowhere was my father, Alister, linked to his
address.** His address sat in three care plans, a photographed bill, and a
council email. The system held all of those. It had a contact record for
Alister. And it had connected none of it. When I emailed Fife Council *about*
him, nothing recognised the email concerned a person the system already knew.

## Why it actually happened (the root cause, not an excuse)

The audit was unambiguous:

1. **Connections were only ever made at the moment of capture**, using whatever
   thin context the classifier happened to be handed. The email classifier was
   given contacts as *name + email only* — no facts, no aliases, no addresses.
   It was structurally incapable of knowing Alister's address was sitting in a
   care plan.
2. **There was no single place where everything I know lived together.** Care
   plans were in one table, facts in another, emails in a third. They never met.
   There was no semantic search anywhere — matching was crude keyword overlap.
3. **Nothing ever re-read what it already had.** "Mycelium" sounded like
   emergence but was hard-coded keyword links with no intelligence. "Synthadoc"
   was an unimplemented note. No job ever went back over the corpus and asked
   "what connects to what now?"

So it wasn't a CRM problem. It was that **the CRM rows *were* the knowledge**,
instead of being one view onto a knowledge layer compiled from the source
material. That is the ceiling I kept hitting.

## What we built to address it

A knowledge layer that sits *beside* the existing tables — nothing was ripped
out — and is compiled continuously from the raw material I already feed in:

- **Semantic retrieval.** Everything (documents, emails, facts, meetings) is now
  embedded, so the system can find "where does Dad live" from a care plan that
  never uses the word "Dad."
- **A knowledge substrate ("atoms").** Derived claims — *subject, predicate,
  value* — each carrying its **provenance** (which sources justify it) and a
  confidence score. These are derived, not typed by hand, and can be re-derived
  when sources change.
- **A nightly synthesis job — the self-improving part.** It re-reads new source
  material *after* ingestion, extracts atoms, and links them to the right person
  or project from the whole corpus — not from the thin context available when the
  email first arrived. Confident links apply automatically; uncertain ones are
  held for review.
- **Task routing.** A free-text task like "get Dad's medicine" now attaches to
  Alister on its own, even though his name isn't in it.
- **Reconciliation.** A weekly pass decays stale claims and surfaces
  contradictions and likely duplicate contacts for me to confirm, at
  `/admin/knowledge`.
- **The views read from this layer.** A contact or project page now shows what
  the system has *worked out*, each claim traceable back to its source.

Every model call runs through OpenRouter, and every model — including the
embedding and extraction models — is mine to change in the admin tool. No
hidden provider choices.

## 27 June 2026 update — CRM prompt operating system

The next failure mode was email and meeting intake still behaving like old
table-writing code: classify a source, immediately create a CRM fact or task,
and hope duplicate handling was good enough. That is what produced repeated
"Follow up" tasks and project pages polluted by unrelated email statistics.

The CRM path is now deliberately staged:

```text
raw source -> crm_source_triage -> crm_duplicate_review -> synthesis/provenance merge -> crm_action_projection -> compiled atoms/events/tasks
```

What changed:

- Gmail and AgentMail still classify, label, detect Ryanair bookings, and store
  summaries/source records, but they no longer create CRM facts or Google Tasks
  directly by default.
- Meeting intake stores the meeting evidence and document context, but its CRM
  facts/actions now flow through the same knowledge engine.
- The model first decides whether a source is actually CRM knowledge at all.
  A daily website statistics email should be recognised as non-project CRM
  knowledge instead of being dragged into the nearest project.
- Duplicate and supersession review happens before projection, so a forwarded
  chain or repeated source can confirm or update existing knowledge rather than
  creating another identical action.
- Action projection is its own model step. Only high-confidence required actions
  become Google Tasks.
- `knowledge_receipts` records each prompt decision so the admin view can show
  what the model saw and why it acted.

This still uses tables, but for the right things: raw source evidence,
compiled/cacheable model outputs, operational tasks, and audit receipts. The
relationship thinking is now in prompts and synthesis, not in deterministic
"copy this row over there" glue.

## The proof

Running live on real data, Alister now has 41 derived facts, including:

> **lives_at — 12 Drumnagoil Gardens, Kelty, KY4 0DF**  (confidence 0.99)

…alongside his full medical picture, care schedule, work history, and emergency
contact — none of it entered by hand, all of it traceable to the documents it
came from. **The system knows where my father lives because it read the care
plans, not because anyone told it.**

## What I'm choosing not to pretend is done

- The wiki does not yet regenerate itself from this layer — that means rewriting
  a working part of the system, so it's a deliberate next step, not a silent gap.
- The public portfolio chat is *not* wired to this knowledge, on purpose: the
  portfolio is public and this knowledge is private.
- Early data has some near-duplicates (a birthday stored in two formats, a
  diagnosis worded twice). That's expected at this stage and is exactly what the
  weekly reconciliation queue is for.

## What changes for me day to day

I stop being the integration layer. I no longer have to remember that the thing
in the care plan is the same person as the contact as the task as the email.
The system makes those connections itself, shows its working, and asks me only
when it isn't sure.
