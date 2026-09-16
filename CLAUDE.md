# CLAUDE.md

Guidance for future sessions working in this repo. Read this before changing
anything.

## What this is

A private household budgeting app for two people, Mat and Skye. It pulls bank
data from Redbark, an Australian open banking aggregator, and our Postgres is
the system of record: Redbark stores nothing on its side.

**All five stages are built**: ingest and transfer detection, categories and
rules, buckets and payday allocation, forecast and runway, email alerts. On top
of those, `src/analyst.js` runs periodic analysis and predictive budgeting
through the Claude API, and accounts can be created by hand for debts open
banking cannot reach.

## Engineering principles, non negotiable

- Fewest parts, most basic tech that does the job. Do not be a merchant of
  complexity.
- Backend: Node.js with Express. Database access with `pg` and plain SQL. No
  ORM.
- Frontend: plain HTML, CSS and JavaScript served as static files by the same
  Express app. No framework, no build step, no bundler.
- Migrations: numbered plain `.sql` files in `/migrations`, applied by
  `scripts/migrate.js`, which records what it applied in `schema_migrations`.
- Tests: the built in `node:test` runner. No test framework dependency.
- Keep dependencies minimal. Ask before adding one.
- Clean, readable code with short comments explaining the "why".
- **Do not use em dashes or en dashes** in code comments, UI text or docs. Use
  commas, colons or full stops instead.

## Stack and layout

Six runtime dependencies: `express`, `pg`, `express-session`,
`connect-pg-simple`, `bcryptjs`, `@anthropic-ai/sdk`. No development dependencies. Node 22 or newer,
which gives `--env-file` and the test runner without any package. Email is sent
with `fetch` against a provider's JSON API, so alerts add no package.

```
migrations/  numbered .sql, applied in order
scripts/     migrate.js, discover.js, create-user.js
src/         db.js          one shared pg pool, SSL and type parsers
             redbark.js     every Redbark API call, isolated here
             sync.js        the sync engine, npm run sync
             transfers.js   transfer detection and the pair actions
             matching.js    description similarity and date helpers
             money.js       integer cents, exact decimals
             categorise.js  rules and the category precedence
             buckets.js     pay periods and bucket maths
             commitments.js finds the outgoings that repeat
             forecast.js    the projection and the runway
             alerts.js      what is worth saying, and when
             email.js       sending, with no dependency
             analyst.js     the snapshot, and the Claude API
             behaviour.js   the Today page: position, whether it stuck, trade offs
             auth.js        sessions, the gate, login
             server.js      the Express app
             routes/        one file per area
public/      today (the front door), login, accounts, spending, transactions,
             categories, rules, buckets, forecast, transfers, sync, alerts,
             plus app.js and styles.css
docs/        behaviour.md, the reasoning behind the Today page
test/        node:test suites and redacted fixtures
```

## Rules that are easy to break by accident

**Money.** Redbark sends integer minor units. Keep integer cents in JavaScript
everywhere and convert to a decimal string only at the `numeric(12,2)` boundary,
using `src/money.js`. Never do floating point arithmetic on an amount. `db.js`
registers type parsers so numeric arrives as a string and date arrives as
`YYYY-MM-DD`: do not remove them, a date parsed into a JavaScript Date in the
server's local timezone can move a transaction a day.

**forecast.js, commitments.js and analyst.js use money.js too.** An earlier version
of the forecast had its own Math.round(Number(x) * 100), which is float arithmetic
on money. Amounts reach the forecast as 2dp strings or integer cents; a float is
refused, not rounded. Medians of amounts are taken in integer cents and pick an
observed value, never a half cent average. Rates like "per month" are computed
in SQL as numeric.

**Recent spending is the guide, not the long average.** The everyday spend rate
defaults to the last two months (SPEND_WINDOW_DAYS, and a selector on the
Forecast page). Two months is long enough that one quiet fortnight does not set
the rate, and short enough to exclude the 2025 renovation. A year of history is full of one offs, an 11,000 dollar car repair, a
renovation, and of circumstances that have since changed. The forecast reports
the 30, 60 and 90 day rates side by side so a skew is visible. The analysis
prompt says the same thing to Claude.

**"Today" is the household's day.** src/dates.js derives every date from the
clock in HOUSEHOLD_TIMEZONE (Australia/Perth), and db.js sets that zone on every
Postgres connection so current_date agrees. Render and new Date() are UTC, which
is yesterday in Perth from 4pm to midnight UTC: the pay period was wrong for a
third of every day. Never call new Date().toISOString().slice(0, 10) for a
calendar date; use today(), daysAgo(), daysFromNow(), addDays().

**Merchant keys are computed in JavaScript and stored**, in
transactions.merchant_key, never recomputed in SQL. Same reason as matchKeyFor:
two copies drift. Two keys that are the same place are merged by giving them the
same display_name in merchants, which is why there is no alias table.

**Sign convention.** Negative is money out. On a **loan** account this inverts in
meaning: a repayment is positive, because it reduces the debt, and interest
charged is negative. That is what makes a mortgage repayment pair as equal and
opposite against the ING side.

**Account numbers must never appear in source.** Roles and `is_liquid` live in
the `accounts` table and are set through the UI. Transfer matching reads the
masked number from that table, never from a literal.

**The Redbark key** comes from `process.env.REDBARK_API_KEY` only. Never log it,
never send it to the browser, never write it to a file.

**Never commit real transaction data.** Fixtures are redacted by
`npm run discover -- --fixtures`: descriptions, amounts, merchants, account
numbers and names, ids and institutions are replaced, and every date is shifted
by one constant. Structure, field names, id formats, sign conventions and pending
flags are preserved exactly.

**Tests must never touch the live database.** `test/helpers.js` refuses to run
without a `TEST_DATABASE_URL` that differs from `DATABASE_URL`, then repoints
`DATABASE_URL` at the test database so no fallback path can reach live data.
Test files share one database, so `npm test` runs them with
`--test-concurrency=1`. Do not remove that.

## Redbark API

The app talks to **v2** at `https://api.redbark.com/v2`. Every call is isolated
in `src/redbark.js` so an API change is a one file fix. The REST API is in beta.

v1 cannot serve this app: it filters pending transactions out upstream, so
pending to posted matching is impossible there.

Things that will bite you:

- `Redbark-Version` is required on every request, currently `2026-10-01.wattle`.
- Transactions take `account` only. `connectionId` is a v1 idea and is rejected.
- `include_pending=true` is required. Pending is excluded by default.
- Omitting `from` silently limits the read to 30 days.
- One read caps at 5000 rows, flagged by `X-Redbark-Truncated`. Backfill is
  windowed to stay under it.
- History reaches about 7 years, then `400 from_too_old`. ING serves back to
  January 2022 in practice.
- Transactions are the "heavy" rate limit tier, 30 a minute. The client
  throttles itself and backs off on 429 and 5xx.
- Transaction ids are content hashes in two namespaces, `txn_fk_bank_tx_` and
  `txn_fk_bank_tx_s_`. They are stable across calls but must not be assumed
  stable across a transaction posting.

## More rules that are easy to break

**`budget_flows` is the one definition of what counts.** A transfer between two
accounts we own is not spending, except when money leaves a spendable account
for a loan or mortgage: that really does leave our cash. Only the side leaving
the liquid account counts. Use this view rather than filtering `is_transfer` by
hand, or the mortgage becomes invisible to the budget.

**Category precedence is manual, then rule, then provider.** Recategorising must
never overwrite a category someone set by hand. `categoriseAll` compares against
what is already stored, so every field it writes must also be selected, or every
row looks changed on every run.

**Express matches routes in order.** Specific paths like `/recategorise` and
`/provider-map` must be registered before `/:id`, or `/:id` swallows them.

**SQL inside a JavaScript template literal.** `\s` is not a valid escape there
and silently becomes a plain `s`, so a whitespace class quietly turns into "runs
of the letter s". Use POSIX classes like `[[:space:]]` in SQL strings.

**Nothing that identifies an account is sent to the Claude API.** Not as a
field, and not inside a description: banks put account and BSB numbers in the
description text itself, so `scrubLabel` replaces runs of four or more digits
before anything leaves the machine. Every new field added to the snapshot has to
go through it. The snapshot is stored with each answer so claims can be checked.

**Analysis is off by default and rate limited by cadence.** It costs money per
run and sends financial data off the machine, so it never turns itself on, and
a twice daily sync must not mean twice daily analysis.

**Accepted expense proposals become ordinary manual commitments.** There is no
separate "planned expense" concept to keep in step with the forecast.

**There is one definition of a commitment's match key**, `matchKeyFor`, and
`everydaySpendRate` groups in JavaScript so it can use it directly. An earlier
version wrote the same normalisation again in SQL, and the two drifted apart the
moment one changed: commitments stopped matching and were counted twice, once as
a commitment and again as everyday spending, which made the runway look far
shorter than it was. Do not reintroduce a second copy of that logic in SQL.

**Spending rates exclude one offs, and divide by the days there is history
for.** A renovation or a new engine is real spending and shows in every total,
but it is not a guide to next month, so `transactions.one_off` keeps it out of
the rate only. Do not go back to defending against it with a short window: a
short window forgets one large purchase by forgetting everything, and
`scripts/backtest.js` measures the cost of that. Run the backtest rather than
arguing about the window. Dividing by the days asked for rather than the days
covered understates the rate badly on a young database.

**A commitment and a merchant have two different keys.** `matchKeyFor` keeps
three words and drops numeric ones, `merchantKeyFor` strips processor prefixes
and keeps four. They are not interchangeable and joining `commitments.match_key`
to `transactions.merchant_key` in SQL matches almost nothing. When both are
needed, group in JavaScript with the one definition, the same rule as
`everydaySpendRate`.

**Comparing two windows of different lengths breaks on anything lumpy.** A
fortnightly payment falls a different number of times per day in a 56 day window
than in a 180 day one, so a raw comparison invents changes that did not happen.
Anything comparing before and after a date has to exclude commitments and
anything with fewer than two occurrences on both sides, and report what it left
out rather than dropping it.

**The Today page must never bend a number.** `docs/behaviour.md` sets out which
persuasion techniques are used and which are refused, and why the refusals are
self interested rather than merely principled. The short version: every figure
must be true and must agree with the rest of the app, nothing is ever attributed
to Mat or to Skye by name, and the page never implies that cancelling a few
subscriptions closes a gap it does not close. Read that document before changing
anything on that page.

## Design decisions worth keeping

- **Pending resolution updates the row in place** rather than deleting and
  reinserting, so `first_seen_at`, any transfer pairing and the Stage 2
  `category_id` survive the transition.
- **Transfer rejection is recorded per pair**, in `transfer_rejections`, not as a
  flag on the rows. A transaction offered against the wrong counterpart must stay
  free to pair with the right one.
- **Zero amount rows are never paired.** Real data has $0 card authorisations,
  and two of those are trivially equal and opposite.
- **Ambiguity is left to a person.** A pair is only taken automatically when it
  beats every other still available candidate on both sides. Ties go to the
  Transfers page.
- **A batch is collapsed by id before writing**, because a transaction can come
  back in more than one backfill window.
- **The pay cycle is configured, not inferred.** History is suggested, but the
  figure someone sets always wins, because a job change makes the past a bad
  guide.
- **Carry over starts from a bucket's first allocation**, so spending from
  before the bucket existed does not roll in as a debt.
- **Changing the cadence removes periods of the old shape**, or two periods
  contain today and the wrong one wins.
- **Commitment amounts come from recent occurrences**, so a rate rise is picked
  up rather than averaged away, and reference numbers are dropped from the match
  key or every occurrence lands in its own group.
- **Only liquid accounts count as spendable cash.** The mortgage redraw is
  money we would have to borrow back.
- **An intention is checked against the transactions**, not against a tick box.
  When there is nothing observable to check, it says so rather than showing a
  green tick.
- **Alerts carry a dedupe key** that changes only when the situation
  meaningfully changes, and everything considered is logged even when it is not
  sent.

## Deployment

Render: one Web Service running `npm start`, one Cron Job running `npm run sync`
on `0 10,22 * * *` UTC, which is 6am and 6pm Perth time, and one Render Postgres
on PostgreSQL 18. The Web Service and Cron Job use the **Internal** database url,
your machine uses the **External** one. `src/db.js` enables SSL for any host that
is not localhost, so one code path covers both. Migrations are run by hand from
your machine against the external url: Render does not run them for you.

See README.md for the full setup, including which environment variables go
where.

## Working style

- Propose a plan before starting, and wait for approval.
- Stop at the end of each numbered step and summarise.
- If the Redbark docs or real responses contradict the brief, say so and propose
  a change rather than working around it silently.
- Ask before adding any dependency.
