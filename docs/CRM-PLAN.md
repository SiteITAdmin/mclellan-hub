# Personal CRM: feature plan

**Status:** draft for Douglas to review, 25 Oct 2026. This covers features only.
There is no design and no code yet. The visual approach comes after the features
are agreed, and it will be entirely new.

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
- **Someone in both spaces**, such as a colleague who is also a friend, is one
  identity with two separate faces. The Work face shows only work items and the
  Personal face only personal items. *(To confirm, Q3.)*
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
| **Facts** | Statements taken from sources, e.g. "Aoife moves to Stripe in January". Each fact cites its source and links to people and projects |
| **Open loops** | Promises and actions. *I owe* (I said I'd send the deck) or *they owe* (Alec is sending the figures). Each can have a due date |
| **Key dates** | Birthdays, anniversaries, renewals, deadlines |
| **Keep-in-touch** | An optional cadence per person, e.g. every 6 weeks |

## 3. Inputs: the one door

| Input | What comes in | When |
|---|---|---|
| Gmail, sent | Mail I send to known people, and new recipients proposed for review | Every 15 min. A one-off look back over 12 months proposes people |
| Gmail, received | Mail **from known people only**. Newsletters and unknown senders are not stored. Version Old stored 4,700 email summaries, mostly noise | Every 15 min, 7-day window |
| Forward-to inbox (AgentMail) | Anything I deliberately hand over, e.g. a report, a thread or an attachment. One address per space | Every 15 min |
| Upload | Reports and documents (PDF, Word, etc.), converted to text with a readability verdict | When I upload |
| Quick note | A one-line box that works on a phone, e.g. "Met Aoife at the Cork thing, she's moving to Stripe" | When I type |
| Google Calendar | Events and attendees, which link meetings to people | Every 30 min |
| Meeting transcripts | Pasted or uploaded transcripts and voice debriefs | When I add them |
| Google Contacts | Names, emails, phones and birthdays, used to strengthen identity | Daily |
| LinkedIn | The connections export file (CSV) | When I upload |
| WhatsApp, iMessage | Messages with known people, read on the Mac | Live, 7-day window |
| Work email | Depends on where work mail lives *(Q1)* | — |

Every source records where it came from, its space, whether it was readable, the
people it matched, and whether any of those matches is still waiting for review.
A source with pending matches is still stored, so capture never blocks.

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
items a space. *(To confirm, Q4.)*

## 5. What it works out (model layer, on the Mac worker)

| Output | When it runs | Notion of stale |
|---|---|---|
| **Facts** taken from each new source | When a source arrives | Sources older than 14 days are not processed if the worker is behind |
| **Where things stand**, a short summary per person and per project | Only when new sources arrive, at most once a day per person | People with nothing new are skipped |
| **Open loops** (I owe / they owe) | When a source arrives | As for facts |
| **Meeting prep:** who, where things stand, open loops, last contact | On the morning of a meeting with known people | Only for meetings today |
| **Connections between people**, e.g. "Alec and Nakai worked together at X", with the source cited | Weekly | Uses only new sources |
| **Search: "who do I know at X?"** Plain text search first, then a model answer that cites sources | When I ask | — |

## 6. Surfacing: so I don't have to remember to look

- **A Today screen for each space** shows:
  - open loops that are due or overdue
  - people I've drifted from past their cadence
  - dates in the next 7 days
  - today's meetings, with prep
  - the number waiting for review
- **Google Tasks** (§7). Tasks with due dates set off phone notifications from
  the Tasks app.
- **A morning email for each space.** Work goes on weekdays only, Personal
  every day. Each email is short and links to its Today screen. *(To confirm,
  Q6.)*
- **Push notifications** for meeting prep 30 minutes before, and for
  same-day promises. *(Method to confirm, Q7.)*
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

## 8. The 14 features, in build order

Each phase is built, tested with fake data, then checked against real data
before the next one starts.

| Phase | Features | Notes |
|---|---|---|
| **1. Foundations** | 1 People and identity · 2 Getting people in (sent-mail proposals, approve each) · 3 Timeline per person · 4 Quick note | Spaces, organisations, projects, review screen, Gmail capture |
| **2. Remembering for me** | 5 Keep-in-touch · 6 Birthdays and key dates · Google Tasks two-way sync · Today screens · morning emails | The ADHD layer |
| **3. Knowledge** | 7 Where things stand · 8 Promises and open loops · 13 "Who do I know at X?" search | Forward-to inbox, report upload, fact extraction |
| **4. Meetings** | 9 Meeting prep | Calendar capture, transcripts, push notifications |
| **5. Wider identity** | 12 Google Contacts sync · 11 LinkedIn import · 14 Connections between people | Needs the Contacts permission |
| **6. Messages** | 10 WhatsApp and iMessage | Needs Mac programs |

## 9. What it needs

**Database:** a separate `data/crm.db`. It keeps `hub.db` small, and the nightly
backup already copies every `data/*.db`. Tables:

- people, person identifiers, aliases
- organisations, projects, project members
- sources, source links
- facts, open loops, key dates
- review items, merge log
- effects log
- summaries
- a text search index

**Jobs** (each with a stale window):

| Job | When |
|---|---|
| `crm_gmail_capture` | 15 min |
| `crm_gmail_bootstrap` | once |
| `crm_agentmail_capture` | 15 min |
| `crm_calendar_capture` | 30 min |
| `crm_tasks_sync` | 15 min |
| `crm_synthesis` | on a new source, through the Mac worker |
| `crm_daily_scan` (keep-in-touch, dates) | 06:30 Dublin |
| `crm_morning_digest` | 07:00 Dublin |
| `crm_meeting_prep` | morning, plus 30 min before each meeting |
| `crm_contacts_sync` | daily |
| `crm_connections` | weekly |

**Mac programs:**

- The existing subscription worker handles model jobs.
- Phase 6 adds an iMessage reader, which needs Full Disk Access.
- Phase 6 also adds a WhatsApp bridge.

**Permissions:**

- Google Contacts read access is new and needs a one-time re-consent.
- Gmail, Calendar and Tasks are already granted.
- AgentMail is already set up.
- Work email depends on Q1.

## 10. Risks (one line each)

- WhatsApp has no official way to read personal chats. The unofficial bridge
  (Baileys, which Hermes used) carries a real risk of the number being banned.
- If work mail is in Microsoft 365, the employer's tenant may block third-party
  access.
- The Hub's Google token belongs to one account, so Tasks lists, Gmail capture
  and Calendar all come from that account.

## 11. Open questions

**Phase 1 can't be built until these are answered:**

1. **Where does work email live?** In Gmail or Google Workspace, or in Microsoft
   365 / Outlook?
2. **Which Google account is the Workspace one,** and is it the account the
   Hub's token is for? That decides where the Tasks lists and links go.
3. **Someone in both spaces:** one identity with separate Work and Personal
   faces. OK?
4. **The review screen** as the single place both spaces appear. OK?
5. **Is this for Douglas only,** or will Nakai use it too? This changes the
   database layout.

**Needed before later phases:**

6. Morning emails: one per space, Work on weekdays only? *(Phase 2)*
7. Push notifications: are Google Tasks and Calendar notifications enough, or
   should there be a dedicated push app such as ntfy? *(Phase 4)*
