# CLAUDE.md

Guidance for future sessions working in this repo. Read this before changing
anything.

## What this is

A private household budgeting app for two people, Mat and Skye. It pulls bank
data from Redbark, an Australian open banking aggregator, and our Postgres is
the system of record: Redbark stores nothing on its side.

Built in stages. **Stage 1 is complete**: ingest, dedupe, pending to posted
matching, transfer detection and a verification UI. Later stages are Stage 2
categories and rules, Stage 3 buckets and payday allocation, Stage 4 forecast
and runway, Stage 5 email alerts.

Do not build ahead. The schema leaves room for later stages, for example the
nullable `category_id` on `transactions`, but nothing beyond the current stage
should be written.

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

Five runtime dependencies: `express`, `pg`, `express-session`,
`connect-pg-simple`, `bcryptjs`. No development dependencies. Node 22 or newer,
which gives `--env-file` and the test runner without any package.

```
migrations/  numbered .sql, applied in order
scripts/     migrate.js, discover.js, create-user.js
src/         db.js        one shared pg pool, SSL and type parsers
             redbark.js   every Redbark API call, isolated here
             sync.js      the sync engine, npm run sync
             transfers.js transfer detection and the pair actions
             matching.js  description similarity and date helpers
             money.js     integer cents, exact decimals
             auth.js      sessions, the gate, login
             server.js    the Express app
             routes/      accounts, transactions, transfers, sync
public/      login, accounts, transactions, transfers, sync, plus app.js and
             styles.css
test/        node:test suites and redacted fixtures
```

## Rules that are easy to break by accident

**Money.** Redbark sends integer minor units. Keep integer cents in JavaScript
everywhere and convert to a decimal string only at the `numeric(12,2)` boundary,
using `src/money.js`. Never do floating point arithmetic on an amount. `db.js`
registers type parsers so numeric arrives as a string and date arrives as
`YYYY-MM-DD`: do not remove them, a date parsed into a JavaScript Date in the
server's local timezone can move a transaction a day.

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
