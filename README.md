# FamilyBudget

A private household budgeting app for two people. It pulls our bank data from
Redbark, stores it in Postgres, removes duplicates, matches pending transactions
to their posted versions, detects transfers between our own accounts,
categorises spending, runs zero based buckets each pay period, forecasts the
cash runway, and emails us when something needs attention.

All five stages are built:

1. Ingest, dedupe, pending to posted matching, transfer detection, verification UI
2. Categories and rules
3. Buckets and payday allocation
4. Forecast and runway
5. Email alerts

Plus periodic analysis and predictive budgeting through the Claude API, and
manual accounts for debts open banking cannot reach.

## Stack

Node.js and Express, Postgres through `pg` with plain SQL and no ORM, and a
frontend of plain HTML, CSS and JavaScript served as static files by the same
Express app. No framework, no build step, no bundler. Tests use the built in
`node:test` runner.

Six runtime dependencies: `express`, `pg`, `express-session`,
`connect-pg-simple`, `bcryptjs`, and `@anthropic-ai/sdk` for the analysis.
No development dependencies. Email is sent with `fetch` against a provider's
JSON API, so alerts add no package at all.

## Layout

```
migrations/  numbered .sql files, applied in order by scripts/migrate.js
scripts/     migrate.js, discover.js, create-user.js
src/         db.js         one shared pg pool, SSL and type parsers
             redbark.js    every Redbark API call, isolated here
             sync.js       the sync engine, npm run sync
             transfers.js  transfer detection and the pair actions
             matching.js   description similarity and date helpers
             money.js      integer cents, exact decimals
             categorise.js rules and the category precedence
             buckets.js    pay periods and bucket maths
             commitments.js  finds the outgoings that repeat
             forecast.js   the projection and the runway
             alerts.js     what is worth saying, and when
             email.js      sending, with no dependency
             analyst.js    the snapshot, and the Claude API
             auth.js       sessions, the gate, login
             server.js     the Express app
             routes/       one file per area
public/      ten pages, plus styles.css and app.js
test/        node:test suites and redacted fixtures
```

## Local setup

You need Node 22 or newer and a Postgres you can reach.

```bash
git clone <this repo>
cd FamilyBudget
npm install
cp .env.example .env
```

Fill in `.env`. It is gitignored and must never be committed.

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | Postgres. Locally, use the Render **External** url. |
| `TEST_DATABASE_URL` | A **separate** database used only by `npm test`. Local only. |
| `REDBARK_API_KEY` | From Redbark, Settings > API & MCP. Needs `connections:read` and `data:read`. |
| `REDBARK_API_VERSION` | `2026-10-01.wattle`. Sent on every request, which the API requires. |
| `SESSION_SECRET` | A long random string. `node -e "console.log(crypto.randomUUID())"` |
| `NODE_ENV` | `development` locally, `production` on Render. |
| `EMAIL_API_URL` | Optional. Defaults to Resend's endpoint. |
| `EMAIL_API_KEY` | Optional. Alerts stay off until this and `ALERT_FROM` are set. |
| `ALERT_FROM` | Optional. The address alerts are sent from. |
| `ANTHROPIC_API_KEY` | Optional. Analysis stays off until this is set and switched on. |
| `ANTHROPIC_MODEL` | Optional. Defaults to `claude-opus-5`. |

Then:

```bash
npm run migrate       # create the schema
npm run create-user   # prompts for email and password, no signup page exists
npm run sync          # first run backfills, later runs re-read 21 days
npm start             # http://localhost:3000
```

`npm run discover` prints the shape of what Redbark returns and answers the
questions the parsers depend on. `npm run discover -- --fixtures` refreshes the
redacted test fixtures.

Then, in the app: set each account's role and whether it is spendable on the
Accounts page, set the pay cycle on Buckets, and create buckets for the jobs
your money has. Categories and rules are on their own pages, the runway is on
Forecast, and email alerts are set up on Alerts.

### The test database

Tests refuse to run unless `TEST_DATABASE_URL` is set and is different from
`DATABASE_URL`, and once satisfied they repoint `DATABASE_URL` at the test
database for the duration of the run, so no code path can reach live data even
by accident.

Render gives one database per instance. Either run a local Postgres for tests:

```bash
createdb familybudget_test
# TEST_DATABASE_URL=postgresql://localhost:5432/familybudget_test
```

or, if your Render role is allowed to, create a second database on the same
instance and point `TEST_DATABASE_URL` at it:

```bash
psql "<external url>" -c "create database familybudget_test"
```

Run them with `npm test`.

## Render setup

Three services, all in the same region, so the private network is available.

### 1. Postgres

Create a **Render Postgres** instance on **PostgreSQL 18**. No extensions are
needed: the schema uses `gen_random_uuid()`, which is built in.

Render gives two connection strings for it:

- **Internal Database URL**, a bare hostname such as `dpg-xxxx-a`. Same region,
  private network. Used by the Web Service and the Cron Job.
- **External Database URL**, a full hostname such as
  `dpg-xxxx-a.singapore-postgres.render.com`. Reached over the public internet
  and requires SSL. Used from your own machine.

`src/db.js` turns SSL on for any host that is not localhost, so the same code
works with either url and nothing needs changing between them.

### 2. Web Service

| Setting | Value |
| --- | --- |
| Environment | Node |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/healthz` |

Environment variables:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | the **Internal** Database URL |
| `REDBARK_API_KEY` | your Redbark key |
| `REDBARK_API_VERSION` | `2026-10-01.wattle` |
| `SESSION_SECRET` | a long random string |
| `NODE_ENV` | `production` |
| `EMAIL_API_KEY` | your provider's key, if you want alerts |
| `ALERT_FROM` | the address alerts come from |
| `ANTHROPIC_API_KEY` | your Anthropic key, if you want the analysis |

Do **not** set `TEST_DATABASE_URL` on Render. It is a local only variable.

### 3. Cron Job

| Setting | Value |
| --- | --- |
| Build command | `npm ci` |
| Command | `npm run sync` |
| Schedule | `0 10,22 * * *` |

Render cron schedules are UTC. Perth is UTC+8 all year with no daylight saving,
so `0 10,22 * * *` runs at 6pm and 6am Perth time.

Environment variables: the same as the Web Service, except `SESSION_SECRET`,
which the sync does not use. `DATABASE_URL` is again the **Internal** url.

### Running migrations against Render

From your own machine, with `DATABASE_URL` set to the **External** url:

```bash
npm run migrate
```

Render does not run migrations for you. Do this before the first deploy, and
again after any new file lands in `migrations/`.

## What a sync does, in order

1. Refreshes the account list and upserts it.
2. Reads transactions for each account and upserts them.
3. Snapshots today's balance for every account.
4. Pairs transfers.
5. Categorises everything not set by hand.
6. Refreshes the recurring commitments.
7. Evaluates alerts and sends what is new.

Every step records its counts on the `sync_runs` row, so the Sync page shows
what actually happened.

## How the sync behaves

- **First run per account** backfills in 180 day windows. Redbark caps one read
  at 5000 rows, and the busiest account runs to about 180 transactions a month,
  so the windows keep each read well clear of the cap.
- **Later runs** re-read the last 21 days, so late posting and edited
  transactions are caught. Tune with `SYNC_OVERLAP_DAYS`.
- **Idempotent.** Running it twice in a row changes nothing the second time.
- **Pending to posted.** Redbark transaction ids are content hashes, so an id
  can change when a transaction settles. A newly posted row is matched against
  existing pending rows on equal amount, date within 5 days and description
  similarity, and the pending row is then updated in place. A tie resolves
  nothing rather than guessing. Pending rows Redbark stops returning for 10 days
  are removed, because they were cancelled or reversed.
- **One account failing does not stop the others**, and every run records a
  `sync_runs` row, successes and failures alike.
- **Rate limits.** Transactions are the "heavy" tier at 30 requests a minute.
  The client throttles itself below that and backs off on 429 and 5xx, honouring
  `Retry-After`.

## How transfer detection behaves

Two transactions pair when they are on different accounts we own, equal in size
and opposite in sign, within 3 days, both unpaired, and not previously rejected
as a pair.

Candidates are ranked by date distance first and text hints second, and a pair
is only taken when it beats every other still available candidate on **both**
sides. Anything that ties is left for a person to decide on the Transfers page.

The strongest hint is the counterpart account's last four digits, which ING
writes into the description of the receiving side. That number is read from the
`accounts` table, so no account number appears anywhere in the source.

Zero amount rows are never paired. Real data contains $0 card authorisations,
and two of those on different accounts are trivially equal and opposite.

Rejecting a pair records the **pair**, not the rows, so a transaction offered
against the wrong counterpart is still free to pair with the right one.

A transaction whose counterpart is outside our connected accounts, such as a
repayment to the ING personal loan, is simply left unpaired. Later stages will
treat it as a commitment.

## Categories and rules

Precedence, strongest first: a category set by hand, then the first matching
rule, then the category the bank supplied. Recategorising only ever touches rows
whose category came from a rule or the bank, so a manual choice is never
overwritten. Clearing it by hand hands the row back to the rules.

Rules are ordered and the first match wins. They match on text in any field or
one named field, on account, direction and an amount range, and they can set a
category, rename a transaction for display without touching the bank's
description, add a note, or ignore it.

## Buckets

The pay cycle is configured rather than inferred: how often you are paid, one
date you know you were paid, and optionally what to expect each time. The app
suggests a cycle from your history, but history is a poor guide after a job
change, so the figure you set always wins.

A bucket covers one or more categories and has a target for each period. A
category belongs to at most one bucket, so spending is never counted twice.
Leftovers either roll forward or reset, per bucket. Carry over starts from the
period a bucket was first allocated to, so spending from before the bucket
existed does not roll in as a debt.

## Forecast and runway

Spendable cash is projected forward day by day from three things: expected
income on each payday, the recurring commitments, and an everyday spend rate
taken from the last 90 days with the commitments removed so nothing is counted
twice. The runway is the first day the projection drops below zero, or below a
buffer you choose.

Only liquid accounts count. The mortgage redraw is deliberately ignored: it is
money we would have to borrow back, not money we have.

Commitments are found by looking for a description that repeats at a regular
interval. Regularity is what separates a bill from ordinary shopping: the
supermarket appears forty times a year at no particular spacing, the power bill
appears every two months. Their typical amount comes from the most recent
occurrences, so a rate rise is picked up rather than being averaged away. You
can switch any of them off, or add one by hand that history has not shown yet.

## Alerts

Checked at the end of every sync: a short runway, a bucket over budget, an
unusually large transaction, a failed sync, and things piling up for review.

Nothing is sent until an address is set and alerts are switched on. Each alert
carries a dedupe key that only changes when the situation meaningfully changes,
so a standing problem is reported once rather than twice a day, and a worsening
one is reported again. Everything considered is written to `alert_log` whether
or not it was sent, so you can see what would have gone out.

Email goes through any provider that accepts a JSON POST. The default url is
Resend; set `EMAIL_API_URL` for a different one, plus `EMAIL_API_KEY` and
`ALERT_FROM`.

## Analysis and predictive budgeting

The Insights page sends a snapshot of where the household stands to the Claude
API and gets back a structured read: what is happening, what to do about it, and
what costs look likely to land soon.

Two other things it does:

- **Tell it what is coming.** Describe a cost in plain words, for example "next
  week I'm getting a SmartRider card, probably $50 a week". It works out the
  amount and cadence, says what that would do to the runway, and you decide
  whether to add it. Accepted proposals become ordinary manual commitments, so
  the forecast needs no second idea of a future expense.
- **Manual accounts.** A credit card or personal loan open banking cannot reach
  is entered by hand with its balance. It counts as a debt, never as spendable
  cash, and a sync never touches it.

What is sent, and what is not:

- Sent: balances, the runway, commitments, bucket state, category totals,
  income streams, and transaction descriptions.
- Never sent: account numbers. Not as a field, and not buried inside a bank
  description either, where they routinely appear. Any run of four or more
  digits in a description is replaced before the request leaves the machine.
- The exact snapshot is stored with every answer, so a claim can always be
  checked against the figures it was given. Read `GET /api/analyst/snapshot` to
  see precisely what would be sent, before sending anything.

It stays off until `ANTHROPIC_API_KEY` is set and it is switched on. Automatic
analysis runs at the end of a sync, but only once per cadence, so a twice daily
sync does not mean twice daily analysis.

## Security

- The Redbark key is read from `process.env.REDBARK_API_KEY` only. It is never
  logged, never sent to the browser and never written to a file by the app.
- Every page and API route needs a session, except the login page itself.
- Passwords are bcrypt hashes. There is no signup page: logins are created with
  `npm run create-user`.
- Sessions live in Postgres. Cookies are `httpOnly`, `sameSite=lax`, and
  `secure` when `NODE_ENV=production`.
- The login route is rate limited to 10 attempts per IP per 15 minutes.
- Errors are logged without the request body, so transaction descriptions and
  amounts stay out of the logs. The email provider's own error text is not kept
  either, only the status it returned, because it can echo back what we sent.
- The email API key is never sent to the browser. The Alerts page is told only
  whether one is configured.
- Test fixtures are redacted: descriptions, amounts, merchants, account numbers
  and names, ids and institutions are replaced, and every date is shifted by one
  constant so no real date is published. Structure, field names, id formats,
  sign conventions and pending flags are preserved exactly.

## Money

Redbark sends integer minor units. This app keeps integer cents in JavaScript
everywhere and converts to a decimal string only at the `numeric(12,2)`
boundary, in `src/money.js`. No floating point arithmetic touches an amount, and
`src/db.js` stops `pg` turning numeric columns into floats on the way back.

Note the sign convention on a loan account: a repayment arrives **positive**
because it reduces the debt, and interest charged is negative. That is what lets
a mortgage repayment pair as equal and opposite against the ING side.

## Redbark API notes

The app talks to **v2**, verified against the live API on 2026-09-16. Every call
is isolated in `src/redbark.js`, so an API change is a one file fix.

v1 is not usable for this app: it filters pending transactions out upstream, so
pending to posted matching is impossible there. v2 also returns amounts as
integer minor units rather than decimal strings, and adds the `reference` and
`extended_description` fields that transfer matching leans on.

Worth knowing:

- `Redbark-Version` is required on every request.
- Transactions take `account` only. Passing `connectionId` is a v1 idea and is
  rejected.
- `include_pending=true` is required. Pending rows are excluded by default.
- Omitting `from` silently limits a read to the last 30 days.
- History reaches about 7 years. Beyond that is `400 from_too_old`. Actual depth
  depends on the bank: ING serves back to January 2022.
- Accounts do **not** need to be added to a sync in the Redbark dashboard for
  the API to return their data.
