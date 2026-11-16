# Personal money

Agreed 15 Nov 2026 (Douglas): a Personal-only tracker for his finances. Irish banks have no
open link to trackers, so the data comes in as **screenshots of banking apps**. The tool
categorises spending, watches for subscriptions and retailer offers in Personal mail, looks the
web for discount codes for what he actually buys, and **challenges** his spending. The aim is
to reduce spending and question habits, not to report it politely.

Screens: `/crm/personal/money` (Overview + upload), `/transactions`, `/subscriptions`,
`/offers`, `/challenge`. Work has none of these (404). Nav link shows only in Personal.

## Architecture

Five modules in `lib/crm/money/`, each owning its tables (`SCHEMA`), routes (`mount(router, h)`),
background work (`tick()`) and Overview card (`summary()`). `index.js` runs them. One job,
`crm_money_tick` (60 s, `lib/crm/jobs.js`), calls every module's `tick()` through `runs.track`
under the name `money_<module>`, so a failure is recorded and shown (rule 5). Routes are
mounted by `routes/money.js`, which has already applied `spaceParam` + Personal-only to
`/crm/:space/money/*`. `h` carries `{ spaceParam, requireSameOrigin, writeLimiter, flash, back, base }`.

| Module | Owns | Model |
|--------|------|-------|
| `ledger.js` | uploads, transactions, rules, categories, Overview, Transactions screen, image plumbing | Sonnet reads screenshots (`crm_money_read`) |
| `subscriptions.js` | recurring-charge detection, mail evidence, `money_subscriptions`, Subscriptions screen | Sonnet reads mail (`crm_money_mail`) |
| `offers.js` | retailer offers found in mail (origin `mail`), the Offers screen (which also lists web codes) | Sonnet (`crm_money_mail`) |
| `deals.js` | web search for codes for merchants Douglas actually spends with (origin `web`) | Sonnet with web tools (`crm_money_deals`) |
| `insights.js` | weekly spending challenge, habit findings, Challenge screen | Opus (`crm_money_challenge`) |

Feature slots are in `lib/feature-runners.js`, on the Hub's existing Sonnet and Opus tiers (Fable and Opus were used to build the tool, not to run it).
Model calls go `lib/model.js enqueueModelJob` → VPS queue → Mac worker → result collected on a later
tick via `subscription-agent-jobs.getJob` (see `lib/crm/boox.js` and `lib/crm/ask.js` for the pattern;
never block a request waiting for the Mac). Chain is Claude → ChatGPT → Grok, except `crm_money_deals`,
which falls straight to Grok because ChatGPT's lane has no web and would invent codes.

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
- **Screenshots are sensitive.** Only the extracted rows are kept long term; `money_uploads.image` is set
  to NULL 30 days after reading. Image bytes are only ever served to the signed-in admin.

## Shared contracts

- `lib/crm/money/common.js`: `CATEGORIES`, `KINDS`, `normMerchant`, `eur`, `dublinDay`, `addDays`, `SPEND_SQL`.
- Tables in `ledger.js` (`money_uploads`, `money_transactions`, `money_rules`) and `offers.js`
  (`money_offers`) are fixed contracts: other modules may read them and, where stated, write to them, but
  do not change their columns without the owning module. Other modules' own tables are defined in their own
  `SCHEMA` (`CREATE TABLE IF NOT EXISTS`; add columns with a `migrate(db)` export using `ALTER TABLE` guarded
  by `pragma table_info`).
- `amount_cents` is negative for money out. Spending totals use `kind='spend' AND status!='ignored'`
  (`SPEND_SQL`); transfers and income never count.
- Views: `views/crm/money/*.ejs`, rendered with `page: 'money'`, `tab: <overview|transactions|subscriptions|offers|challenge>`,
  and `<%- include('_nav') %>` from `views/crm/money/_nav.ejs` (include path `money/_nav` from `views/crm/`).
  Styles go in your own marked section of `public/money.css`.
- Tests: `test/crm-money-<module>.test.js`, node:test, temp `CRM_DB_PATH`/`HUB_DB_PATH`, `HUB_DISABLE_JOBS=1`
  (copy the header of `test/crm-vendors.test.js`). Synthetic data only (rule 3).
