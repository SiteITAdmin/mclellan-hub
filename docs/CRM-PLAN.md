# Personal CRM: feature plan

**Status:** draft for Douglas to review, 25 Oct 2026. WhatsApp through Hermes added 25 Oct (§8). Work email through Drive added 25 Oct (§3). This covers features only.
There is no design and no code yet. The visual approach comes after the features
are agreed, and it will be entirely new.

## Decisions so far (25 Oct 2026)

- **Lives at** douglas.mclellan.scot/crm, behind the site admin's Google
  sign-in. For Douglas only.
- **Spaces:** every person belongs to exactly one space. Review is the only
  screen that shows both.
- **Mail:** Outlook is Work and Gmail (douglas@mclellan.scot) is Personal.
  Outlook comes through Douglas's Drive flow, which he is fixing himself.
  Beacon has said it's fine.
- **First people:** from the last 3 months of sent mail, anyone emailed at
  least twice. Each person is approved one by one.
- **Tasks:** new "Work" and "Personal" lists in Google Tasks. Promises the
  model is confident about become tasks automatically; the rest are proposed.
- **Notes:** typed in the CRM for now. Boox notebooks come in through Drive
  and Claude reads them. Hermes and the Boox app come later.
- **Reminders:**
  - Hub home-screen app notifications, with Work allowed at any time
  - morning emails for each space at 07:30
  - keep-in-touch cadences suggested by the Hub and confirmed by me
- **Keep text forever.** Summaries and indexes can always be rebuilt from it.
- **Design:** the editorial-greeting mockups in `design/crm/`, as approved.

## Purpose

1. **An outside memory for ADHD forgetfulness.** It remembers who, what, and
   what I promised, and puts it in front of me without my asking.
2. **One place for everything I need to know** from emails, reports, notes,
   meetings and messages. Each piece of it is traceable to where it came from.

It covers work and personal, kept clearly apart.

## Rules for this function

These follow the standing Hub rules (`CLAUDE.md`, `docs/VERSION-OLD.md`):

- **Derive, don't duplicate.** A person's page is built from their sources:
  email, notes, reports, meetings. "Last contacted" and "where things stand" are
  worked out from those sources, never typed in by hand.
- **The text is the truth.** Each source is kept as text. Summaries, facts and
  any search index can be rebuilt from it.
- **Identity before models.** A model never decides who someone is (§4).
- **Nothing scheduled without a notion of stale.** Each job has a time window.
  Old work is skipped, never caught up.
- **One door in, one attributed path out.** Each capture records what it was,
  which space it belongs to and whether it was readable. Each external effect
  (a Google Task, an email, a notification) records which part of the CRM
  caused it.

---

## 1. Spaces: Work and Personal

- Every item belongs to exactly one space, **Work** or **Personal**. That
  covers people, organisations, projects, sources, facts, open loops, tasks and
  dates.
- The two are separate places with separate screens (for example `/work/...`
  and `/personal/...`). No list, Today screen, digest or search ever mixes them.
  "M365 Project" and "Dad" never appear side by side.
- **How a space gets assigned** at capture, in order:
  1. The account it came in on (work mailbox means Work).
  2. The project it belongs to.
  3. The sender's domain is on the work-domains list.
  4. I choose in review.
  
  Nothing gets a space by guesswork. If none of these apply, it waits in review.
- **Every person belongs to exactly one space.** No one is in both (decided
  25 Oct).
- **Projects** exist in both spaces. Examples are "M365 Project" in Work, and
  "Dad", "House" or "Health" in Personal. A personal project can be about a
  person: the "Dad" project links to Dad as a person.

## 2. What it holds

| Thing | What it is |
|---|---|
| **People** | Name, aliases, email addresses, phone numbers, organisation, space(s), projects |
| **Organisations** | Companies and bodies, used for "who do I know at X" |
| **Projects** | Work projects and personal areas, each with its members |
| **Sources** | Everything captured: emails, notes, reports, transcripts, messages. Stored as text with a link back to the original |
| **Atoms** | Single statements taken from sources (§5), e.g. "Aoife moves to Stripe in January". Each one cites its source and links to people, projects and topics. Promises, decisions and dates are kinds of atom, so the other lists in this table are views over atoms |
| **Open loops** | Promises and actions. *I owe* (I said I'd send the deck) or *they owe* (Alec is sending the figures). Each can have a due date |
| **Key dates** | Birthdays, anniversaries, renewals, deadlines |
| **Keep-in-touch** | An optional cadence per person, e.g. every 6 weeks |

## 3. Inputs: the one door

| Input | What comes in | When |
|---|---|---|
| Gmail, sent | Mail I send to known people, and new recipients proposed for review | Every 15 min. A one-off look back over 3 months proposes everyone I emailed at least twice |
| Gmail, received | Mail **from known people only**. Newsletters and unknown senders are not stored. Version Old stored 4,700 email summaries, mostly noise | Every 15 min, 7-day window |
| Forward-to inbox (AgentMail) | Anything I deliberately hand over, e.g. a report, a thread or an attachment. One address per space | Every 15 min |
| Upload | Reports and documents (PDF, Word, etc.), converted to text with a readability verdict | When I upload |
| Quick note | A one-line box that works on a phone, e.g. "Met Aoife at the Cork thing, she's moving to Stripe" | When I type |
| Google Calendar | Events and attendees, which link meetings to people. Work appointments get copied from Outlook into Google by me; they should go into a separate Google calendar called "Work", so that their space is fixed and never guessed | Every 30 min |
| Boox notebooks | PDFs synced to Drive `onyx/NoteMax/Notebooks`. Claude reads each new page through the Mac worker; unclear words and names go to review. Each notebook is labelled by its creation date, and its space and kind (meetings, to-dos, journal) are set once on first sight. Journal pages never create promises or tasks. Pages that existed before go in as history only. The Boox app gets rebuilt after the CRM | Every 15 min |
| Meeting transcripts | Pasted or uploaded transcripts and voice debriefs | When I add them |
| Google Contacts | Names, emails, phones and birthdays, used to strengthen identity | Daily |
| LinkedIn | The connections export file (CSV) | When I upload |
| WhatsApp (Hermes) | Approved chats with known people, plus notes and questions I send to myself (§8) | Live, 7-day window |
| iMessage | Messages with known people, read on the Mac | Live, 7-day window |
| Work email (Outlook 365) | Douglas's own flow saves each Outlook email into Drive (`Work` folder, douglas@mclellan.scot) as an HTML file with a FROM / TO / SUBJECT / RECEIVED header. The Hub reads that folder with the Drive access it already has (checked 25 Oct: 87 emails, 20–24 Oct). Everything from it is Work | Every 15 min, 7-day window |

Every source records where it came from, its space, whether it was readable, the
people it matched, and whether any of those matches is still waiting for review.
A source with pending matches is still stored, so capture never blocks.

**Work email: changes needed before the Hub reads it** (checked 25 Oct)

1. **It includes other people's mail.** Some files are addressed only to
   colleagues, not to me (for example, mail to Alan Garland, Serhiy Pylypaka
   and David Mulqueen). The flow is probably watching a shared mailbox or a
   group as well as my inbox. Either the flow is fixed, or the Hub admits only
   mail where I am a sender or recipient. The second is weaker, because the
   header has no CC line.
2. **It has no sent mail.** Only received mail arrives, but most "I owe"
   promises are in what I send. The flow needs a second branch on Sent Items.
3. **Four lines to add to the header:**
   - `CC:`
   - `MESSAGE-ID:`, so the same email is never counted twice and can link
     back to Outlook on the web
   - `CONVERSATION-ID:`, so replies thread together
   - `FOLDER: Inbox` or `FOLDER: Sent`
   
   The body can stay as it is. The Hub strips Outlook's quoted history so the
   same thread isn't read over and over.
4. **Mail needs its own folder.** `Work` also holds other documents, including
   an MFA codes document. The Hub should read a dedicated subfolder (e.g.
   `Work/Outlook mail`) and nothing else.
5. **Policy check.** This is hospital mail, including a subject-access-request
   thread, going into a personal Google Drive and then to a model on the Mac.
   Check that this fits Beacon's policy before turning it on.

## 4. Identity: who is who

Version Old mixed up Alec and Alan in the same project, and that is part of why
everything was redone. These rules are strict on purpose.

1. **Automatic links use exact strong identifiers only.** That means an email
   address, a phone number (normalised), or a Google Contacts ID.
2. **Names are never matched by similarity.** There is no fuzzy matching, no
   guessed nicknames and no "close enough". Alec is never Alan unless I say so.
3. **A name-only mention** in text ("Alec said…") is linked only when exactly
   one person in that space has that exact name or alias. If the source belongs
   to a project, that person must also be on the project. Name-only links carry
   a visible "linked by name" marker that can be fixed in one click. Anything
   else goes to review.
4. **Models only pick out the name.** A model can flag "Alec" in a transcript.
   The deterministic matcher decides who that is. Any person ID a model outputs
   is ignored.
5. **Meeting transcripts** check names against the meeting's attendee list
   first, because speech-to-text mishears names.
6. **Merges are logged and can be undone.** A wrong merge can be split back
   into two people, with their sources reassigned.
7. **Alias collisions are blocked.** If an alias already belongs to another
   person in the same space, it can't be added without a decision.

### The review screen ("Who is this?")

For each proposed person:

- **What was seen:** the name as written, the email or phone, the suggested
  space, and up to three pieces of evidence with links to the originals.
- **Possible matches side by side:** existing people who share a name, a domain
  or an organisation. The details that tell them apart are highlighted: full
  name, email, organisation, projects, last contact. For example:
  `Alec Smith · alec@… · M365 Project` and `Alan Smyth · alan@… · Personal`.
- **Actions:**
  - **Add as new person:** set the space, organisation and project.
  - **Same person as…:** merge them. The new identifier is added and the merge
    is logged.
  - **Not a person:** a system sender or newsletter, ignored for good.
  - **Decide later.**
- **A second queue, "Which Alec?":** name mentions that couldn't be resolved,
  each shown with its sentence and the candidates.

The number of items waiting for review shows on each Today screen. Review is
the one screen that shows items from both spaces, because its job is to give
items a space (decided 25 Oct).

## 5. Atoms: every source broken into facts from day one

Every source is atomised as it arrives, from Phase 1. That covers each email,
note, report, notebook page and transcript. The aim is for a fact from one
place to turn up wherever it becomes relevant later. For example, something
said in an M365 Rollout email in October should appear in the prep for a
"Data protection processes" meeting in January.

**What an atom is**

One statement that makes sense on its own, with its evidence:

| Part | Example |
|---|---|
| Statement, written to stand alone (no "he", "it" or "they") | "Beacon is evaluating Purview Premium for data loss prevention" |
| Kind | fact · decision · promise · risk · question · date |
| Space | Work |
| Source and the exact words it came from | Email from Laura Ellard, 23 Oct, quoted line |
| When it was said, and when it's true (if stated) | said 23 Oct; true from Q1 |
| People | Laura Ellard, Jane Whelan, resolved by the identity rules in §4. The model gives the names it saw; the matcher decides who they are |
| Projects | M365 Rollout. The model picks from the project list; a new project is proposed in review, never created silently |
| Topics | Purview, data protection, licensing |
| Confidence | high / medium / low |

**How the knowledge stays clean**

- **One atom for one fact.** If the same thing is said in five emails, it's one
  atom with five sources. A model compares meaning, not exact wording, to spot
  duplicates.
- **Old facts are kept, not overwritten.** When a newer statement contradicts
  an older one ("licences now cover 500"), the old atom is marked superseded
  and kept, so the history stays readable.
- **Topics organise themselves.** The model reuses an existing topic where one
  fits and can add new ones. A weekly tidy proposes merging near-duplicates
  ("DP" and "data protection"); merges are logged and can be undone. I never
  tag anything by hand.
- **A person on a project isn't proof a fact is about that project.** Each
  atom gets its project from what it says.
- **Spaces stay separate.** An atom never links across Work and Personal.

**Linking a past fact to a future meeting**

Links are worked out when they are needed, not entered by hand and not stored
as permanent truth, so new evidence can change them.

1. **October:** an email in the Purview Premium thread produces atoms tagged
   M365 Rollout, Purview and data protection.
2. **January:** a meeting called "Data protection processes", with Jane
   Whelan, appears in the calendar.
3. **Meeting prep that morning:** the Hub builds a search from the meeting's
   title, description and attendees. It finds atoms three ways:
   - by attendee: everything involving Jane
   - by topic: data protection
   - by text search over atoms and sources
   
   Claude then reads those candidates and keeps the ones that matter for this
   meeting.
4. **The prep shows** "From M365 Rollout: Beacon is evaluating Purview Premium
   for data loss prevention (Laura Ellard, email 23 Oct)", linked to the
   email. The chosen links are cached on the meeting.

The same approach answers "Who do I know at X?", feeds "Where things stand",
and lets a project page show facts from sources that never mentioned the
project by name but share its topics and people.

**Search index:** a SQLite full-text index over atoms and sources, from day
one. Embeddings (vector search) are a disposable extra that can be rebuilt
from the text at any time. They would need a small local embedding model on
the Mac; Ollama was removed to free disk space. That gets added only if
keyword and topic search turn out to miss things.

**Nothing stale, nothing lost.** Knowledge and actions are treated
differently:

- **Every source is always atomised.** If the worker falls behind, it does the
  newest first and the rest when it's idle.
- **Only fresh sources create actions.** A source more than 7 days old when
  it's atomised never creates a promise, a task or a notification.
- **The 3-month first look and old Boox pages** are atomised as history only:
  knowledge, no actions.

### What else the model works out (on the Mac worker)

| Output | When it runs | Notion of stale |
|---|---|---|
| **Atoms** from each new source | When a source arrives (Phase 1) | Always done, newest first; old sources create no actions |
| **Where things stand**, a short summary per person and per project, built from atoms | Only when new atoms arrive, at most once a day per person | People with nothing new are skipped |
| **Open loops:** the promise atoms that are still open (I owe / they owe) | Built from atoms | Promises from sources over 7 days old aren't surfaced as new |
| **Meeting prep:** who, where things stand, open loops, and related atoms found as above | On the morning of a meeting with known people | Only for meetings today |
| **Connections between people**, from atoms that mention both | Weekly | Uses only new atoms |
| **Search: "who do I know at X?"** Text search first, then a model answer that cites atoms | When I ask | — |

## 6. Surfacing: so I don't have to remember to look

- **A Today screen for each space** shows:
  - open loops that are due or overdue
  - people I've drifted from past their cadence
  - dates in the next 7 days
  - today's meetings, with prep
  - the number waiting for review
- **Google Tasks** (§7). Tasks with due dates set off phone notifications from
  the Tasks app.
- **A morning email for each space** at 07:30 Dublin. Work goes on weekdays
  only, Personal every day. Each email is short and links to its Today screen.
- **Push notifications** from the Hub's own home-screen app (web push on the
  iPhone): meeting prep 30 minutes before, and same-day promises. Work can
  notify at any time. In Phase 6, WhatsApp through Hermes adds a second route.
- **No changes to calendar events.** Editing the description of an event I
  organise would show the change to the other attendees, so prep goes to Today,
  the email and push instead.

## 7. Google Tasks

- **Two lists** in the Google Workspace account: **Work** and **Personal**.
- **Each task carries:**
  - a clear title
  - a line of context
  - a link to the Hub page (person, project or source)
  - a link to the original email in Gmail, where there is one
  - a due date
- **One task per open loop, made once.** The task records the CRM part and the
  source that created it. If I complete or delete it in Google Tasks, the loop
  closes in the Hub (synced every 15 min) and stays closed.
- **What becomes a task automatically:** "I owe" loops that the model is
  confident about. Less certain ones are proposed on Today with one-click
  **Create task** / **Not a task**.
- **Tasks I create myself** in Google Tasks are read in and shown on Today
  (sorted into spaces by list). They are never changed by the Hub.

## 8. WhatsApp through Hermes

Hermes comes back as the WhatsApp channel, near the end of the build
(Phase 6). It runs on the Mac as a linked
WhatsApp device and passes messages to the Hub. What went wrong with it in
Version Old shapes the rules below.

**What it does**

- **Captures approved chats.** Messages in a chat I've approved become CRM
  sources, in both directions. I approve each chat once on the review screen
  and give it a space, e.g. "Dad Information Group" → Personal, Dad project.
  New chats wait in review and are not stored until I decide.
- **Takes notes from my own chat.** Anything I send myself on WhatsApp is a
  quick note or a question. For example:
  - "Met Aoife, she's moving to Stripe"
  - "Remind me Thursday to ring the GP"
  - "What do I owe Dad?"
  
  Hermes replies in the same chat to confirm.
- **Reminds me.** Due promises, meeting prep and people I've drifted from can
  arrive as WhatsApp messages to myself. Until Phase 6, reminders come through
  the other routes in §6.
- **Reads chats the way people actually write.** It waits 5 minutes before
  reading a message, so a quick follow-up arrives with it. It reads the rest of
  the same chat for context. A later reply ("sent it") can close an earlier
  promise. Version Old did this, and it worked.
- It does not reply to other people. Hermes is here because it can read
  personal WhatsApp at all, where no official route exists.

**Rules**

- **People are identified by phone number** (the WhatsApp ID), never by
  display name. Version Old matched family-chat senders by name, which is the
  same mistake as Alec and Alan.
- **In group chats,** each sender is matched by phone number. A sender who
  isn't in the CRM goes to review.
- **Hermes messages only me.** Every message it sends goes in the effects log
  with the reason.
- **There is a stop switch.** When the CRM is paused, the Hub refuses
  messages from Hermes and Hermes keeps no backlog to replay later. In Version
  Old, Hermes posted 724 messages during the pause.
- **Old messages can't create work.** A message that arrives more than 7 days
  after it was sent is stored as history only and never creates a promise or a
  task. The same goes for chat exports I import by hand, so an old "I'll do
  it" doesn't become a current promise.
- **No silent failure.** If Hermes hasn't checked in for 30 minutes, both
  Today screens say so.

**What it needs**

- Hermes reinstalled on the Mac, with its WhatsApp bridge (Node) and a
  LaunchAgent, and WhatsApp re-linked by QR code.
- A capture address on the Hub with its own secret.
- **Still to check:** replying in my own chat needs a model, which must go
  through the Mac's subscription CLIs, because the Hub has no API-key path. If
  Hermes can only call API models, it can still capture, but it can't reply.
- The disk space Hermes and its bridge take, checked before installing.
  Ollama is not needed.

## 9. The 14 features, in build order

Each phase is built, tested with fake data, then checked against real data
before the next one starts.

| Phase | Features | Notes |
|---|---|---|
| **1. Foundations** | 1 People and identity · 2 Getting people in (sent-mail proposals, approve each) · 3 Timeline per person · 4 Quick note · **atoms from every source, plus the search index** | Spaces, organisations, projects, review screen, Gmail capture, Outlook mail through Drive. Model work starts here, on the existing Mac worker |
| **2. Remembering for me** | 5 Keep-in-touch · 6 Birthdays and key dates · Google Tasks two-way sync · Today screens · morning emails | The ADHD layer |
| **3. Knowledge** | 7 Where things stand · 8 Promises and open loops · 13 "Who do I know at X?" search | Forward-to inbox, report upload, Boox notebooks read by Claude (all atomised as in Phase 1) |
| **4. Meetings** | 9 Meeting prep | Calendar capture, transcripts, push notifications |
| **5. Wider identity** | 12 Google Contacts sync · 11 LinkedIn import · 14 Connections between people | Needs the Contacts permission |
| **6. Messages** | 10 WhatsApp through Hermes (§8) and iMessage | Needs Mac programs |

## 10. What it needs

**Database:** a separate `data/crm.db`. It keeps `hub.db` small, and the nightly
backup already copies every `data/*.db`. Tables:

- people, person identifiers, aliases
- organisations, projects, project members
- sources, source links
- atoms, atom sources, topics, key dates (open loops are a view over promise atoms)
- review items, merge log
- effects log
- summaries
- a text search index

**Jobs** (each with a stale window):

| Job | When |
|---|---|
| `crm_gmail_capture` | 15 min |
| `crm_gmail_bootstrap` | once |
| `crm_outlook_drive_capture` (reads the Drive mail folder) | 15 min |
| `crm_agentmail_capture` | 15 min |
| `crm_calendar_capture` | 30 min |
| `crm_tasks_sync` | 15 min |
| `crm_atomise` | on each new source, through the Mac worker, newest first |
| `crm_synthesis` (summaries, duplicates, supersession) | on new atoms |
| `crm_topic_tidy` | weekly |
| `crm_daily_scan` (keep-in-touch, dates) | 06:30 Dublin |
| `crm_morning_digest` | 07:30 Dublin |
| `crm_boox_capture` (new notebook pages) | 15 min |
| `crm_meeting_prep` | morning, plus 30 min before each meeting |
| `crm_contacts_sync` | daily |
| `crm_connections` | weekly |
| `crm_hermes_check` (Hermes has checked in) | 5 min |

**Mac programs:**

- The existing subscription worker handles model jobs.
- Phase 6 brings back Hermes and its WhatsApp bridge (§8), and adds an iMessage
  reader, which needs Full Disk Access.

**Permissions:**

- Google Contacts read access is new and needs a one-time re-consent.
- Gmail, Calendar and Tasks are already granted.
- AgentMail is already set up.
- Work email: no new permission. The Hub's existing Drive read access
  (douglas@mclellan.scot) already lists the folder.

## 11. Risks (one line each)

- WhatsApp has no official way to read personal chats. Hermes links through
  an unofficial bridge (Baileys), which carries a real risk of the number
  being banned.
- Hermes can see every WhatsApp chat. Approving chats and messaging only me
  are the only limits, so both must be enforced in code, not just in prompts.
- The Outlook-to-Drive flow runs inside the employer's tenant. A policy change
  could stop it without warning, so the Hub flags when no work email has arrived
  for a whole weekday (Rule 5).
- The Hub's Google token belongs to one account, so Tasks lists, Gmail capture
  and Calendar all come from that account.

## 12. Open questions

All of the earlier questions were answered on 25 Oct (see "Decisions so far").
Still open:

1. **Starting projects:** which projects exist in Work and in Personal on day
   one? *(Phase 1)*
2. **Work calendar:** do work appointments go into their own Google calendar
   called "Work"? *(Phase 4)*
3. **Outlook flow:** tell me when the five fixes are in, so the Hub reads the
   new format. *(Phase 1)*
