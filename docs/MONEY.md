# Personal money

Agreed 15 Nov 2026 (Douglas): a Personal-only tracker for his finances. Irish banks have no
open link to trackers, so the data comes in as **screenshots of banking apps**, and (added
16 Nov) **PDF statements and CSV exports** from the same banks. The tool
categorises spending, watches for subscriptions and retailer offers in Personal mail, looks the
web for discount codes for what he actually buys, and **challenges** his spending. The aim is
to reduce spending and question habits, not to report it politely.

Screens: `/crm/personal/money` (Overview + upload), `/budget`, `/transactions`, `/categories`, `/receipts`, `/prices`, `/subscriptions`,
`/offers`, `/challenge`. Work has none of these (404). Nav link shows only in Personal.

## Architecture

Nine modules in `lib/crm/money/`, each owning its tables (`SCHEMA`), routes (`mount(router, h)`),
background work (`tick()`) and Overview card (`summary()`). `index.js` runs them. One job,
`crm_money_tick` (60 s, `lib/crm/jobs.js`), calls every module's `tick()` through `runs.track`
under the name `money_<module>`, so a failure is recorded and shown (rule 5). Routes are
mounted by `routes/money.js`, which has already applied `spaceParam` + Personal-only to
`/crm/:space/money/*`. `h` carries `{ spaceParam, requireSameOrigin, writeLimiter, flash, back, base }`.

| Module | Owns | Model |
|--------|------|-------|
| `ledger.js` | uploads, transactions, rules, categories, Overview, Transactions screen, image plumbing | Sonnet reads screenshots, PDF pages and CSV lines (`crm_money_read`) |
| `receipts.js` | receipts (`money_receipts`), matching them to bank lines, the running total of receipts the bank has not shown yet, Receipts screen | Sonnet reads the receipt (`crm_money_read`, its own prompt) |
| `prices.js` | what the same thing costs between the shops he uses and over time, from receipt item lines; "why there?" and his answers (`money_price_answers`); Prices screen | none |
| `categories.js` | categories Douglas adds (`money_categories`), moving shops into one, Categories screen | none |
| `budget.js` | the month's plan line by line (`money_budgets`), spend against it, how it follows his agreements, Budget screen | none |
| `subscriptions.js` | recurring-charge detection, mail evidence, `money_subscriptions`, Subscriptions screen | Sonnet reads mail (`crm_money_mail`) |
| `offers.js` | retailer offers found in mail (origin `mail`), the Offers screen (which also lists web codes) | Sonnet (`crm_money_mail`) |
| `deals.js` | web search for codes for merchants Douglas actually spends with (origin `web`) | Sonnet with web tools (`crm_money_deals`) |
| `insights.js` | weekly spending challenge, habit findings, Challenge screen | Opus (`crm_money_challenge`) |

Feature slots are in `lib/feature-runners.js`, on the Hub's existing Sonnet and Opus tiers (Fable and Opus were used to build the tool, not to run it).
Model calls go `lib/model.js enqueueModelJob` → VPS queue → Mac worker → result collected on a later
tick via `subscription-agent-jobs.getJob` (see `lib/crm/boox.js` and `lib/crm/ask.js` for the pattern;
never block a request waiting for the Mac). Chain is Claude → ChatGPT → Grok, except `crm_money_deals`,
which falls straight to Grok because ChatGPT's lane has no web and would invent codes.

## PDF statements and CSV exports

`files.js` cuts a file into parts and `ledger.js` stores one `money_uploads` row per part (`source`
`pdf`/`csv`, `part` "page 2 of 5" / "lines 81–160 of 412", `file_sha256` tying the parts together,
`text` the page's text or the CSV lines). Each part is read like a screenshot, with the same prompt
and checks:

- **PDF:** split with pdf-lib into one-page PDFs (at most 30 pages). The page's text comes from unpdf
  and is laid out by position, so a figure stays under its "Paid out" or "Paid in" heading. The reader
  gets the page as a PDF document plus that text. If ChatGPT or Grok stand in, the Mac renders the page
  with Poppler. A page with text but no amounts (terms and conditions) is marked empty and not sent. A
  statement that opens without a password but cannot be split goes as text only. A password-protected
  one is refused.
- **CSV:** cut into runs of up to 80 lines or 12,000 characters, each under the header row. The bank's
  preamble above the header is dropped. The reader works out the columns from the header; nothing
  parses bank-specific formats. Sent as text, with no attachment, so every lane can read it.
- **Checked against the file:** every amount the reader returns for a PDF page or CSV part must
  appear in that part's text, written in some way a bank writes amounts. If it doesn't, the row is
  kept but marked unsure, for Douglas to check on its own.
- **Overlaps:** lines on other pages or parts of the same file never count as already held. Across
  kinds of upload (a screenshot and a statement word the same payment differently, and an app dates a
  card payment on the day it was made while a statement may date it when it settled), a line matches
  one already held on the same account and amount, within 4 days (nearest first), when the merchant
  names match. Those lines are not added again, and the upload's note says how many were matched.
  `money_line_claims` records which file each held line was paired with, so another page of the same
  file cannot pair with it a second time.
- The text is removed from the queue's packet when the job ends, and from `money_uploads` after 30
  days, along with the picture or page.

## Other currencies

A pocket held in another currency (a "GBP Statement" section of a Revolut statement) is read in that
currency: the reader returns `currency` per row. The line keeps the bank's own figure in `fx_cents` /
`fx_currency`, and `dup_key` stays on that figure so a later statement recognises it. `convertForeign`
(every ledger tick) then sets `amount_cents` in euro at the rate Douglas himself got, taken from his
exchanges on that account: an exchange shows on both sides ("Exchanged to GBP" is -€57.92 on the euro
side and +£50.00 on the pound side; same day, same words, opposite sign, both transfers; several on one
day pair by size). An exchange takes its own euro figure; every other line takes the nearest exchange's
rate in that currency (exchanges under 5.00 are used only when there is nothing larger). With no
exchange to go by, the line counts at face value and is marked for him to correct. An amount he types
is always euro. A card payment abroad from the euro account is already in euro and is not touched.

## Receipts

Agreed 16 Nov 2026. Douglas uploads a receipt when he gets it (photo, or an emailed PDF of up to 4
pages), which is usually days before its bank line reaches an upload.

- **A receipt never counts as spending.** The bank line is the fact; the receipt only sits beside it.
  Nothing in `money_receipts` is read by the totals, the challenge or any other module.
- **Reading:** a `money_uploads` row with `source = 'receipt'`, sent through `crm_money_read` with the
  receipt prompt (shop, date, total paid, tip, currency, card or cash, last four card digits, items with
  categories). The reply keeps the shared `readable` / `transactions` shape (with `transactions` empty)
  so the Mac worker's existing check accepts it. A PDF receipt's total must appear in its text, or the
  receipt is marked unsure. No date printed: the upload day is used and the receipt is marked.
- **Matching** (`reconcile`, every tick and after each reading): matched on its own only when a bank line
  has the exact amount, the shop names agree, and it is dated from 1 day before to 6 days after the
  purchase, nearest on or after first. Anything looser is offered as "Is this it?" (same amount but a
  different name; same shop with the bank up to 25% higher, a tip; same shop in another currency). He
  can say No (never offered again), match by hand from nearby lines, unmatch (that line is never matched
  to it again), mark it paid in cash, or set it aside. A deleted bank line frees its receipt. His
  decisions (`decided_by = 'you'`) survive reading the receipt again.
- **Cash:** an ATM withdrawal already counts as spending (category Cash), so a cash receipt is never
  added again; it only shows what the cash went on. A receipt printed "cash" is set to cash on reading.
- **The running total:** waiting receipts are a running total of spending the bank has not shown yet.
  A waiting receipt is "not found" once every account with lines in the last 60 days is held to 6 days
  past its purchase; until then it is "not on a bank upload yet". The Receipts screen shows the bank's
  figure for the month, how much of it has a receipt, the waiting total, and "about €X" for the month
  with this month's waiting receipts added. The Overview repeats that line under the month's total.
  Personal Today warns when a receipt is not found or could not be read.
- Item categories are shown with the receipt but do not yet split the bank line's category in totals.

## Challenging the spending

Agreed 16 Nov 2026: a standing process, not only the weekly reading. Measure (automatic), question (the
same questions every time), decide (his answer), hold to it (from the ledger), ask again when the answer
is stale. Nothing in it is a market price check: every comparison is between shops he uses, from his own
receipts.

- **Coffee** is its own category (`CATEGORIES`). The reader files coffee shops and takeaway coffee
  there; lines the reader had already put under Eating out were moved once by name (`ledger.splitCoffee`,
  guarded by setting `money_coffee_split`), leaving anything he or a rule of his had categorised.
- **Subscriptions: is it worth it?** The Hub cannot see whether a service is used, so it asks: "In the
  last month, how much did you use it?" (`use_level`: most days, about weekly, once or twice, hardly
  ever, not at all; `use_at`). From that it works out a cost per use, lists what he says he hardly or
  never uses with its yearly cost, and asks again after 90 days. Only active subscriptions are asked about.
- **Standing checks** on the Challenge screen (`insights.checks`, no model) for Coffee, Groceries and
  Eating out: the last 28 days against the 28 before, the yearly rate, a table by shop over 90 days
  (times, average each, total), the gap between the dearest and cheapest average visit among shops used
  more than once, and for Groceries the top-up trips under €15. "Hold me to it" sets a cap for the month
  (`capCategory`: an ordinary category commitment, judged from the ledger, suggested at a fifth under
  what he spends now).
- **Prices** (`prices.js`, /crm/personal/money/prices): the receipt reader names each item line
  (`product` in plain words, `brand`, `quantity`, `size`, `unit`), and is given the product names
  already in use so the same thing is written the same way. Items are compared per kilo, per litre or
  each (`product|family` key), all worked out from `money_receipts.items` on every view; there is no
  items table. Shown: **Why there?** (the shop he buys it in most in 120 days against a shop whose
  latest receipt has it at least 5% cheaper, with what those purchases cost above that price over 90
  days); **Shop against shop** (one of each thing bought in both, needs 3 in common); **Prices that
  moved** (same shop, same brand, 2% or more); and what he buys again and again with its history. Lines
  more than 2.5 times apart are taken to be different things and not compared. He answers "why there?"
  in a line (`money_price_answers`, one per product and pair of shops); an answered question is not
  asked again, on screen or in the challenge, until he presses "Ask me again".
- **The weekly challenge** is given all of it as numbered statistics (`by_shop`, `top_ups`,
  `subscription_value`, `subscription_unrated`, `cheaper_elsewhere`, `shop_basket`, `price_rise`) and
  is told to ask why he buys something where his own receipts show it dearer. A new answer on use, or
  a change in the price findings, counts as something new to read.
- Not done: correcting a product name by hand; items do not split a bank line's category.

## Categories

Agreed 17 Nov 2026. The built-in list (`CATEGORIES` in `common.js`) stays; Douglas adds his own on
/crm/personal/money/categories (name, his own line on what goes in it, and whether it is a bill paid
in one go). `categories()` returns the built-ins with his own just before Other, read afresh each call,
and every module uses it: the bank-line and receipt readers are told about his categories in the user
prompt (with his description) and may return them; category pickers, the Transactions filter and
corrections accept them; the budget proposes, plans and judges them (`billCategories()` makes a bill of
his judged against the plan only, and leaves it out of the challenge's weekday habits); the challenge's
category statistics include them; any category, his own included, can be capped. "Move shops into it"
writes his ordinary merchant rules (`ledger.setRule`), so past lines move (not ones he set by hand) and
new lines follow. Removing one sends its lines to Other, deletes its rules, this month's budget line and
any active cap on it; past months' plans keep the name. Renaming is not built.

## Budget

Agreed 17 Nov 2026. A plan for each calendar month, one line per category, and where the bank lines
stand against it. There is no chat: the budget follows the questions, answers and agreements that
already exist in Money. No model is involved; `budget.tick` only makes sure the month's plan exists.

- **Where a line's figure comes from** (`base_*`): the Hub's figure is his own average over the last
  three whole months held (statements start by the 5th and reach within 3 days of the month's end),
  rounded up to €5; with no whole month, the last 28 days scaled to a month. A figure he types is his
  own and carries into every later month until he changes it or takes the Hub's figure back.
- **How it follows his agreements** (`apply`, on every view and tick of the current month):
  a category cap for the month (from a challenge's "I'll do this" or a standing check's "Hold me to
  it") is the plan for that line while it runs (`source = 'cap'`); dropped, the line goes back to its
  base. A cap he kept is next month's plan (`'kept'`). A cap he broke is put to him again on the line.
  A subscription he marks cancelled comes off any line still averaged from months that include it.
- **What sits on each line** (`linksFor`): his agreements with their progress, what he said was wrong
  and why, what he said "not now" to, open challenges aimed at that category or at a merchant filed
  under it, subscriptions on his cancel list, ones he says he hardly uses, ones not yet rated, and
  "why there?" questions and answers on Groceries. Each links to where it is answered.
- **Judging a line:** over (spent more than planned); running ahead (not a bill, at least 5 days of
  the month held and 2 purchases, and on course for more than 15% over); bills (Home & utilities,
  Insurance, Subscriptions, Fees & interest) are judged against the plan only. The pace runs to the
  newest bank line, not to today. Receipts the bank has not shown yet are listed beside the line they
  mostly belong to, never added to it. Spending in a category with no line shows as "not in the plan".
- **Pay and putting away** (optional, settings `money_budget_income_cents` / `_savings_cents`):
  take-home less savings less the plan is what has no job; take-home less the month as it is going is
  what would be left.
- A month that has ended is never rewritten. Months before the first plan show spend only.
- **The weekly challenge** is given `budget` and `budget_line` statistics and told to hold him to the
  plan, saying whether it was a cap, his own figure or only his average.

## Rules that apply to every module

- **Personal only.** Only read `sources` with `space = 'personal'`. No money data is ever written to
  `sources`, `atoms` or any knowledge table, and none reaches Work screens, reports, search or the digest.
- **Privacy to outside services.** The web search sends merchant names and product categories only: no
  amounts, account names, balances, dates of birth, addresses or Douglas's name or email.
- **Mail already captured is the only mail access.** No new Gmail scope. Read `sources` rows
  (`kind='email'`, any `atomise_status` including `held`/`ignored`: this reading creates no facts and
  does not release anything for the knowledge reader). If captured mail does not reach back far enough
  to judge something, say so on screen instead of guessing.
- **Nothing is invented.** A subscription needs ≥ 2 matching charges or a mail that says so; an offer
  needs the mail's own words; a web code needs a source URL and the quoted text where it appeared, and is
  shown as *found, not tested*. Never claim a code works. Nothing is bought, cancelled, emailed or sent
  by the Hub: it only tells Douglas and links out.
- **Challenge, don't flatter.** Wording is direct and specific (amounts, counts, comparisons with his own
  previous months) and never moralising or generic budgeting advice. He has ADHD: lead with the one thing
  that matters, short lines.
- **Stale work is skipped, not caught up.** Bounded model work per tick (one in-flight job per module),
  look-back windows, and a weekly cadence for deals and challenge. Failures show on the Money screen with
  a retry control.
- **Derive, don't duplicate.** Subscriptions, offers and findings are derived from transactions and mail;
  Douglas's own decisions (category corrections, "not a subscription", "dismiss") are never overwritten.
- **Uploads are sensitive.** Only the extracted rows are kept long term; `money_uploads.image` and `.text`
  are set to NULL 30 days after reading. They are only ever served to the signed-in admin (CSV text as
  sandboxed plain text).

## Shared contracts

- `lib/crm/money/common.js`: `CATEGORIES` (the built-ins), `categories()` (with his own; use this), `billCategories()`, `KINDS`, `normMerchant`, `eur`, `dublinDay`, `addDays`, `SPEND_SQL`.
- Tables in `ledger.js` (`money_uploads`, `money_transactions`, `money_rules`) and `offers.js`
  (`money_offers`) are fixed contracts: other modules may read them and, where stated, write to them, but
  do not change their columns without the owning module. Other modules' own tables are defined in their own
  `SCHEMA` (`CREATE TABLE IF NOT EXISTS`; add columns with a `migrate(db)` export using `ALTER TABLE` guarded
  by `pragma table_info`).
- `amount_cents` is negative for money out. Spending totals use `kind='spend' AND status!='ignored'`
  (`SPEND_SQL`); transfers and income never count.
- Views: `views/crm/money/*.ejs`, rendered with `page: 'money'`, `tab: <overview|budget|transactions|categories|receipts|prices|subscriptions|offers|challenge>`,
  and `<%- include('_nav') %>` from `views/crm/money/_nav.ejs` (include path `money/_nav` from `views/crm/`).
  Styles go in your own marked section of `public/money.css`.
- Tests: `test/crm-money-<module>.test.js`, node:test, temp `CRM_DB_PATH`/`HUB_DB_PATH`, `HUB_DISABLE_JOBS=1`
  (copy the header of `test/crm-vendors.test.js`). Synthetic data only (rule 3).
