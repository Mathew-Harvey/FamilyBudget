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
             costs.js       the one shared cost classification model
             forecast.js    the projection and the runway
             alerts.js      what is worth saying, and when
             email.js       sending, with no dependency
             analyst.js     the snapshot, and the Claude API
             behaviour.js   the Today page: position, whether it stuck, trade offs
             lean.js        the cumulative Lasting scenarios
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

**Converting between a rate and a period goes through money.js.**
`centsPerMonth`, `monthlyFromDaily` and `dailyFromMonthly` are the only three,
and they keep the arithmetic in integers until the single division.
They were written by hand in a dozen places, as `* 30.44 / days` in some and
`* 3044 / (days * 100)` in others, with a private `MONTH_DAYS` float in two
modules. Only `priceIn` still holds one, deliberately: it divides by the
difference between two daily rates and rounding either to whole cents first
moves the answer by days. SQL keeps its own `* 30.44`, where numeric is exact.

**forecast.js, commitments.js and analyst.js use money.js too.** An earlier version
of the forecast had its own Math.round(Number(x) * 100), which is float arithmetic
on money. Amounts reach the forecast as 2dp strings or integer cents; a float is
refused, not rounded. Medians of amounts are taken in integer cents and pick an
observed value, never a half cent average. Rates like "per month" are computed
in SQL as numeric.

**Recent spending is the guide, not the long average.** The everyday spend rate
defaults to the last 120 days (`SPEND_WINDOW_DAYS`). `scripts/backtest.js`
measured that window against what happened next. A year of history is full of
one offs, an 11,000 dollar car repair, a
renovation, and circumstances that have since changed.

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

**One list of what a test may write to.** `resetDatabase` in `test/helpers.js`
truncates every domain table, and no test file keeps its own copy. Six of them
did, and the copies had drifted: `forecast.test.js` was missing `settings`, so
inserting the discretionary allowance collided with the row migration 027 seeds
and that file could not be run on its own.

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
go through it. `accounts.notes` is free text someone typed about an
account and was the one field that skipped it, with the account's name being
scrubbed on the line above. The snapshot is stored with each answer so claims can be checked.

**Analysis is off by default and rate limited by cadence.** It costs money per
run and sends financial data off the machine, so it never turns itself on, and
a twice daily sync must not mean twice daily analysis.

**A cadence has to step forward.** Zero or less walks
`scheduleCommitments` backwards instead of ending it, and every projection
filters on `cadence_days > 0`, so such a row is invisible to the forecast while
the page goes on listing it as active. Refused at the API on create and on
edit, and refused again where a cadence becomes dates.

**Accepted expense proposals become ordinary manual commitments.** There is no
separate "planned expense" concept to keep in step with the forecast.

**There is one definition of a commitment's match key**, `matchKeyFor`, and
`everydaySpendRate` groups in JavaScript so it can use it directly. An earlier
version wrote the same normalisation again in SQL, and the two drifted apart the
moment one changed: commitments stopped matching and were counted twice, once as
a commitment and again as everyday spending, which made the runway look far
shorter than it was. Do not reintroduce a second copy of that logic in SQL.

**An account is identified by its number at its bank, not by its Redbark id.**
Relinking a connection reissues every account id behind it, and CDR consent
expires yearly so this is routine. `upsertAccounts` matches on
`redbark_account_id` **or** on bank plus masked number, or a relink inserts
duplicates and orphans the originals along with their transactions, balances,
`is_liquid` and roles. Nothing errors when that happens: spendable cash is
simply read off the new empty rows. The same path adopts a hand entered account
when open banking starts serving it, keeping the name, role and balance someone
set.

**Paying down debt is not spending, but it is still cash out.**
`budget_flows.to_own_debt` marks money leaving a liquid account for one of our
own non liquid accounts, found through a matched counterpart, through the
account number in the description, or through `merchants.pays_account_id` for
the hand entered debts that have no counterpart row. It does not change
`counts`: the cash really leaves and the runway is right to include it. It
exists so the Today page can say 12,000 of living and 5,900 of debt servicing
rather than one useless 17,900.

**One saving, one lever.** `forecast()` accepts both a daily spend adjustment
and a list of commitments to exclude. Passing both for the same item counts it
twice: a 322 dollar subscription bought 22 days of runway where the projection
says 2. Everything on the "what to stop" list is a commitment, so pass only the
ids. For the same reason the page shows no per item day estimate: working one
out in closed form ignores the paydays in between and came out about double what
the app's own projection says, and two numbers that disagree are worse than one.

**The split is a share of one total, never a second measurement.** Measuring
"what goes out" twice, once from the rate and once from the flows, gives two
answers a fraction of a percent apart that then visibly fail to add up on the
page. Take the debt share from the flows and apply it to the figure the runway
is built from.

**Spending rates exclude one offs, and divide by the days there is history
for.** A renovation or a new engine is real spending and shows in every total,
but it is not a guide to next month, so `transactions.one_off` keeps it out of
the rate only. Do not go back to defending against it with a short window: a
short window forgets one large purchase by forgetting everything, and
`scripts/backtest.js` measures the cost of that. Run the backtest rather than
arguing about the window. Dividing by the days asked for rather than the days
covered understates the rate badly on a young database.

**A reference number is not an identity.** Both `matchKeyFor` and
`merchantKeyFor` drop any word carrying five or more digits, which spares real
names that contain a number (7ELEVEN, BP1, CAFE63) and removes the policy,
invoice and customer numbers banks staple to a payee. Dropping only purely
numeric words was not enough: one insurer arrived as six merchants worth 673 a
month between them, every PayPal direct debit became a merchant of its own, and
ZipMoney's weekly payments never formed a commitment. A key that is only digits
is a BSB, so it becomes UNKNOWN rather than filing a payment under a branch code.

**A refunded charge is not spending, and its refund is not income.**
`resolveReversals` pairs a credit against an earlier charge at the same merchant
for the same amount within 30 days, and `budget_flows.counts` excludes both
sides. This is the transfer problem in a different costume and gets the same
answer, which is why it needs no change at the two dozen places that filter on
amount. Pairing is strict and one to one, charges before credits within a day
(a refund is usually posted on the same date, and ordering by id there is
ordering by a random uuid), and a credit that already has a pair is skipped or
every sync silently reshuffles which charges counted.

**Transfer detection covers all unpaired history, not a rolling window.** It
used to look back 400 days, which left every first run permanently half
explained: the backfill reaches about seven years, so no transfer older than the
window was ever offered a counterpart. One side of each was still kept out of
the budget by `resolveInternalDestinations`, which reads the destination out of
the description and has no date limit, while the other side counted as money in.
On this household that was 353,000 dollars of internal transfers netting to a
353,000 dollar hole. The Transfers page could not rescue it either, because
`listCandidates` loads through the same `loadState`, so the pairs a person needed
to confirm were never shown. There is no window to tune: only unpaired rows are
read, and whether two rows are equal, opposite and three days apart does not
depend on their age.

**A row already explained one way must be refused by the other, in both
directions.** `resolveReversals` skips rows that are transfers, so `loadState`
has to skip rows that are refunds. Guarding only one way looks sufficient
because a sync pairs transfers before refunds, and that holds on the first run
and never again: every later run sees the refund pairs the one before it wrote.
A 24 cent international transaction fee, already cancelled by its own refund,
was taken as a transfer against an unrelated 24 cent credit on another account.
Nothing errors when that happens, the pair simply stops netting to zero.

**The provider does not get to say something is a transfer.** A transfer
category asserts the money moved between two accounts we own, and the bank
cannot know that: ING files cheque deposits, PayPal refunds, reversed ATM
withdrawals and money from relatives all as `TRANSFER_IN`. `categoriseAll`
refuses a provider mapping of kind `transfer` unless pairing or
`internal_to_account_id` proved it, and leaves the row uncategorised for a rule
or a person. A rule or a manual choice still stands, because those are somebody
saying so rather than the bank guessing. No budget figure moves either way,
since `budget_flows` decides what counts from the pairing and never from the
category, but the label was claiming 375,000 dollars of outside money was
already ours. It also hid 132,000 dollars from the Spending page, which excludes
transfer kinds while the spend rate does not.

**A cost that has been cancelled stops being forecast.** `merchants.ended_on`
keeps a merchant's spending in the history and in every total and out of every
rate, which is what `transactions.one_off` does for a purchase. Waiting for
commitment detection to stand a cancelled bill down takes two full cycles, and
waiting for the window to forget it takes months, which is months of a forecast
that is knowably wrong. Detection also skips ended merchants, or the next sync
resurrects the commitment for as long as the lookback still holds the payments.
Set it on the Spending page, not by hand in the database.

**Removing a cost is not the same as it going away.** Ending Youi moved the
runway from 25 November to 17 December, which was wrong: the household had
switched to Suncorp, not stopped insuring anything. The replacement had three
payments and could not reach the rate on its own, so it went in as a manual
commitment and the honest answer came back to 27 November. When a recurring cost
ends, find what replaced it before believing the new number.

**A detected commitment whose key matches nothing is stale, not late.** The two
cycles of grace never expires it, because `last_seen` is frozen at whatever it
was when it was last detected, so it is projected forward while the same
spending is also counted as everyday. This happens every time a key definition
changes. `detectCommitments` stands those down; manual rows are left alone,
because an accepted expense proposal is supposed to have no history behind it.

**A rate needs enough observations to be a rate.** One payment divided by a
window is not a monthly cost: the Bendigo card is 25 a year to keep open and was
reported at 25.37 a month, twelve times over. `debts()` needs three payments
before it claims a rate, the Spending page needs a merchant paid on three
separate days, and `discretionary()` gates on distinct DATES rather than rows,
because three payments to a builder in one afternoon is one event and counting
rows made it a recurring habit. The Forecast page applies the same three date
gate to each merchant in its recurring essentials baseline. Costs below the
gate are named as irregular rather than silently turned into a monthly rate.

**A cadence is how often something happens, not the gap that happens most.**
`assessSchedule` uses the median gap to decide whether something recurs at all,
because one long gap over a holiday must not turn a monthly bill into a six
weekly one, and the mean of the gaps for the cadence itself, because the cadence
is the denominator of `amount * 30.44 / cadence`. Gaps are right skewed, nothing
can be early by more than the gap and anything can be late, so the median sits
below the mean and every commitment that was not perfectly regular projected
high. A fuel stop with gaps of 7, 7, 21, 7, 14 was carried at 446 a month
against 237 actually spent. Measured the way `scripts/backtest.js` measures the
spend window, over 240 predictions, that change cut the per commitment error
from 114 dollars to 40, and moved the genuinely regular ones by under two
percent, because for anything regular the two statistics agree.

**A commitment is keyed by what its own label reduces to, and by nothing else.**
Hand entered commitments used to be keyed `manual:<label>` so that they and a
detected one could never collide. That is backwards. `costs.js` keeps a
commitment's spending out of the everyday rate by looking up
`matchKeyFor(description)`, which cannot produce a key in that namespace, so
every manual commitment for a merchant with real history was projected AND left
in the rate: a cafe costing 122 a month was carried at 296. Standing Youi down
and entering Suncorp by hand, the worked example above, has three payments of
history behind it and hit exactly this. They should collide, because detection
only ever updates rows it created, so a hand entered one holding the key wins
and is left alone. `scripts/rekey-commitments.js` moves old rows across, and
reconcile fails until they have been moved. A second namespace cannot come back
without reconcile noticing, because the check compares against `matchKeyFor`
rather than against the old prefix.

**A rate divides by the days there is history for, and there is one definition
of that.** `coveredDays` in `src/costs.js` is it, and `effectiveWindowDays`
reads it from the database for callers that do not want a whole cost model.
Dividing by the days asked for instead was the Spending page's bug for as long
as it existed: on 75 days of history read through a 120 day window it reported
4,007 a month where Today and the Forecast reported 7,873, and the figure kept
falling as the window grew. Every new install is younger than the window for
its first four months, so this is not an edge case. It also applies to the
merchant list, `trimmableSpend` and `scripts/reconcile.js`.

**A window on a date needs both ends.** `txn_date > current_date - $1` with no
`txn_date <= current_date` lets a future dated row into a total the rate then
divides as though it had not happened. Reconcile's seventh check exists to
catch exactly that divergence, so a query that only bounds one end will be
caught, eventually, by a check that cannot say which query did it.

**How long a debt has been serviced is not how long the window has seen it.**
`debts()` bounds its denominator by the first payment ever on that account, and
applies the window with a filter rather than in the where clause. Taking the
first payment from inside the window means the denominator starts about one
cadence after the window opens: the mortgage was divided by 106 days instead of
120 and reported at 2,814 a month against a real 2,450, and the debts card
stopped adding up to the "paying down debt" figure directly above it, which is
the one thing the comment in that query promises.

**Do not amortise annual bills into the spend rate. This was tried and
measured.** Rating a bill over its own period instead of the window is
intuitively right and makes no difference: `scripts/backtest.js` puts it at
2,580 against 2,548 for the plain window, slightly worse. The per bill errors
cancel in aggregate, because a bill that misses the window contributes nothing
and one that lands contributes triple. It is a presentation problem, not a rate
problem, so it is fixed by not printing a monthly figure for a bill paid twice
a year. Run the backtest before reopening this.

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

**"Nobody has chosen" and "zero" are not the same claim.** Migration 027 seeded
the discretionary allowance at 0.00, so every household began forecast as buying
nothing it did not have to. On this one that quietly took 3,825 a month out of
the projection, and Today, the plan, the runway and the alerts were all built on
it. Absence of the row now means "follow what optional spending has actually
been", which is the household we can see; a stored value still wins, zero
included, because a person saying zero is a decision and a seed is not. This is
the pay cycle rule in a second costume: history is the suggestion, the figure
someone sets always wins. `buildCostModel` resolves it and exposes
`discretionary_allowance_chosen` so a page can say which it is looking at,
and an unreadable value counts as no decision rather than as zero.

**The allowance is set in one place, `/allowance`, and nowhere else.** The
Forecast page used to carry a checkbox beside a number, and unticking it wrote a
deliberate 0.00, which is the one answer nobody means. It shows the figure and
links across now. Two controls for one number is two places for it to be wrong.

**One number cannot be argued with; twelve months can.** `optionalByMonth` is the
evidence behind the allowance, on the same filter and the same commitment
exclusion as the rate, taking the commitment keys from a model already built so
there is no second definition of "optional". A month is only whole when there was
a whole month of history behind it: the current one is always part way through
and the earliest is wherever the bank's history starts, so neither can be held up
as the quietest month. The chart scales to the tallest ordinary month rather than
the tallest thing on it, because one 11,000 dollar month flattens the other
eleven into stubs and those eleven are the reason for drawing it. Anything above
the ceiling, a month or the allowance line, is drawn cut off and said in words.

**A rate needs enough observations to be a rate, and that is a rule about
merchants, not about the household.** The three date gate is right where it
started: one payment divided by a window is not that merchant's monthly cost,
and the Bendigo card at 25 a year was once reported at 25.37 a month. But
essential spending below the gate was also dropped from the projection
entirely, so the forecast described a household that never pays a vet, renews a
registration or replaces anything, and reconcile named the hole rather than
closing it. Which vet or which mechanic falls in a given month is close to
random, which is exactly why none of them reaches three dates, and a sum of many
small independent events is far steadier than any one of them.
`scripts/backtest-irregular.js` measures it: without them the projection is
short by 211 dollars every 60 days at the median, with them it misses by 23, and
it is closer in 22 of 36 tests. Bias is what matters here, because a projection
integrates its rate and noise cancels while bias compounds.

**`transactions.one_off` is the only thing keeping a genuine one off out of the
rate, and it always was.** While irregular essentials were dropped, a merchant
seen once was shielded by accident, and a 30,000 dollar roof would have been
shielded the same way for as long as nobody paid a roofer twice. Being unusual
is not the same as being one off and the app must not decide that on anyone's
behalf, so the Forecast page carries the list of large amounts at places barely
seen with a control to mark them. That endpoint existed all along and the
redesign dropped the page that used it, which left the defence unreachable.

**`debts()` was 96 percent of the front page.** Two lateral subqueries per non
liquid account, each scanning `budget_flows` and each carrying a correlated
`exists` against `transactions` for the paired side, came to 1,484ms of a
1,543ms request. Opening the app meant more than a second of "Loading..." while
the whole Spending page took 15ms. The debt payments are resolved once into a
CTE and aggregated twice from it, which is 21ms and byte identical output. The
span in that CTE is deliberately unbounded, because `per_month` divides by how
long the debt has been serviced and that is the first payment ever, not the
first the window caught; the year figure filters inside. Profile the parts
before optimising a page: everything else on Today together was 59ms.

**The plan must not offer to cancel something nobody has looked at.** The same
mistake as the Spending diagram, with consequences: `optional_commitments` was
everything in the `cut` tier, and `cut` is where a commitment lands when neither
its merchant nor its category has said anything. `buildCostModel` records
`tier_source` now, `optional_commitments` excludes `default`, and
`unjudged_commitments` carries them so `/plan` can name them and link to the page
that decides them. A default pretending to be advice is worse than a gap.

**A card headed with a cumulative figure over rows that sum to an increment is
two numbers that disagree.** Step two of the plan was headed 1,123.92 above four
lines adding to 603.66, because `saves_per_month` is cumulative by design and
the rows are what that step alone removes. `adds_per_month` is the increment and
heads the card; the cumulative figure moved into the outcome line where it says
what it is. Both come from the server, because the browser does not do
arithmetic on money.

**A default is not a finding, and the Spending page was drawing one as the
other.** `TIER_SQL` sends anything with no judgement on it to `cut`, which is
right for a projection: unassessed spending counted as optional shortens the
runway rather than flattering it. It is wrong to draw. The page reported "A
choice 52 percent" about money nobody had ever looked at, so `tierTotals`
returns a fourth bucket, `unknown`, which is the absence of a tier and not a
member of the enum. It is hatched, like the unreachable part of a gap on
Lasting, because a solid colour there reads as a fourth kind of spending you
could decide about. `TIER_SQL` itself is unchanged: the projection still wants
the conservative default.

**A rate and a total are two different claims.** The Spending page made one of
them twice. Every rate in this app excludes one offs; this page's monthly figure
did not, so an 11,000 dollar engine rebuild already marked as never happening
again was adding 2,790 a month to a headline that matched nothing else in the
app. The total is what actually left, one offs and all, because that is what the
page is a record of. The monthly figure is a rate and excludes them, and the
difference is named underneath rather than left to be discovered.

**A category's name had the least room on the page.** Every one of the twenty
five was an always editable text box squeezed to half a word by the kind
dropdown beside it, which holds one of four values and took twice the width:
"Groceries an", "Home improv", "Personal car". A name is text that becomes a
field when clicked, and the space goes to how much each category is actually
carrying, because whether the taxonomy fits the spending is the only question
that page can answer and nothing else can. Most categories reading "unused"
almost always means the filing has not been done rather than that the categories
are wrong, so the head says which and links to it.

**A rules page leads with the rules, not with an empty form.** Ten fields filled
the first screen while "No rules yet" sat below the fold. The list leads,
numbered, because first match wins and the order is the one thing about a rule
that is not obvious from reading it. The form folds away with the common case,
description contains X and file it under Y, visible and the other seven
conditions behind "narrow it further". A rule that is switched on and catching
nothing is named: waiting for a merchant and quietly not matching look identical
otherwise.

**483 uncategorised rows are fifteen decisions.** 65 of them are ALDI, 62 are
Woolworths, 57 are Coles. The Transactions page grouped nothing and offered a
category dropdown on each of a hundred rows, so the one job people come to that
page for was the same judgement repeated hundreds of times. It groups the
unfiled by merchant now, and filing a group writes a rule through
`/api/rules`, which files the history and everything that arrives from there
later, and stays visible and editable on the Rules page rather than being an
invisible bulk edit. `/api/transactions/unfiled` reads `budget_flows`, so a
transfer between our own accounts is not sitting in the list forever waiting for
a category it should never have.

**A page that reads filters off the query string has to read all of them.** The
incoming map carried `account_id`, `status`, `transfer` and `category_id` and
silently dropped `from`, `to` and `search`, so the allowance page's "find it"
link, which passes a month as `from` and `to`, landed on the unfiltered table
and looked like it had done nothing. Outgoing and incoming are two lists and
they had drifted.

**The pay cycle is load bearing and envelopes are optional, so the page says
so.** Two features shared one page as two equal forms. The cycle cuts history
into pay periods, it is what the fortnight card on Home is measured against, and
it is the income the forecast projects; envelopes are a method this household has
never used. The cycle leads, and it says whether it still agrees with what the
pay has actually been doing, which is the one question worth asking about it: the
figure someone sets always wins precisely because a job change makes the past a
bad guide, and that is exactly when the app should say the two have parted
company rather than quietly projecting the old wage forever. An empty envelope
list explains what they are and that nothing is wrong with not having any, rather
than reading as an unfinished setup. Removing a bucket has had an endpoint all
along and no page that called it.

**Only things that call the Claude API belong on the Insights page.** It had
collected expected income, things that could be sold, and hand entered debts,
none of which have anything to do with analysis, all of them under a switch that
says it is off. They are on `/expected` and `/accounts` now. The switch means
"run itself after a sync": Analyse now works whether or not it is on, which the
page never said, so "off" read as "this page does nothing". Nothing that needs
the key is offered when the key is missing, because a button that only ever
returns an error is a worse answer than a disabled one with the reason beside it.

**A page can be dead with a clean console.** This app catches its own errors and
shows them in a notice, so `load is not defined` on Insights rendered calmly and
the page walker, which watched only the console, reported no problems. It checks
for a visible `.notice.error` and for sections still saying "Loading..." after
the page has settled. Both failures are invisible to a console watcher and
obvious to anyone actually using the page.

**Expected income is a forecast input, not an analyst feature.**
`buildForecastContext` reads `expected_income` straight from the database on
every projection, whether or not anybody has ever switched Claude on. It used to
be entered on the Insights page under a heading called "Levers", beneath a
switch saying analysis is off, so it read as switched off too and the one person
who needed it could not find it. It lives on `/expected` under "the money coming
in" now, which is what it is: a wage that starts in March is the pay cycle's
future. The endpoints are still under `/api/analyst`, which is also wrong and is
invisible from the browser, so moving them would touch the analyst for no gain.

**The fortnight is measured, never a month divided by 2.17.** Every other figure
in this app is monthly and nobody lives a month: the pay lands every fortnight
and has to last until the next lot, which is the unit the decisions are taken
in. `thisPeriod` in `src/behaviour.js` reads what actually came in and went out
since the last payday, bounded at today on both ends, which is a different and
better claim than a rate cut down to size. The word follows the configured
cadence, because calling a weekly period a fortnight is the page telling someone
something wrong about their own pay.

**The balance is not the subject of the period card.** A household with 22,000
in the bank is not living on it for four days, so the card is about the flow
through the period: did the money that arrived cover what has gone out. That
question means the same thing at any balance. The mark on the bars is this
period's own income times the share of the period that has passed, so being
ahead or behind is a length rather than a division, and it is not a second rate.
Without income in the period the line sits at zero and every dollar is past it,
so the card says no pay has landed instead of dressing arithmetic as a warning.

**A workshop page leads with its state, not its form.** Sync opened on a button
with the one fact you came for, how current the data is, buried in a US
formatted timestamp in a table cell. Alerts opened on a settings form with its
master switch unticked in a row of three ticked ones, so whether anything was
being emailed took working out. Accounts asked which accounts count as spendable
without ever printing how much spendable cash that came to. Each of them answers
its own question first now, and the settings sit under it.

**The Set up index counts what is waiting.** Eleven identical rows cannot say
which one needs you, so you read all eleven every time: 42 transfers waiting on a
decision looked exactly like none. `src/routes/setup.js` returns cheap counts
only, no rates and no cost model, because it loads on every visit to the index.
A row with nothing to report stays quiet, which is most of them most of the time.

**The same decision taken forty two times is one decision.** Transfer pairs were
offered individually down a page eight thousand pixels long, and a fortnightly
standing transfer contributes one every fortnight. They group by the two accounts
and the amount, and a group is confirmed in one request through
`/api/transfers/confirm-many`. Which side is "from" is the side the money left,
never whichever uuid sorted first: `/pairs` picks one row per pair with
`t.id < p.id`, so without that the same standing transfer forms two groups
pointing at each other. Individual pairs stay confirmable on their own, because
a group is a convenience and never a claim that the rows are interchangeable.

**A tick is not a text field.** `input { width: 100% }` was being applied to
every checkbox, which stretched the box across its row and squeezed its own
label into a two word column: "Spendable cash / is liquid" on Accounts and four
unreadable stacks on Alerts. `input[type="checkbox"]` has its own size now, and
the one control that turns a page's feature on wears `.switch`.

**One head, one date format.** `pageIntro` in app.js gives every page under Set
up the same head and a way back to its section; ten hand written heads had
drifted and none of them said where they belonged. `formatWhen` is the one
timestamp: four pages called `toLocaleString()`, which renders in the browser's
locale, so an Australian household read "9/17/2026, 3:49:34 AM" for a sync that
ran this morning.

**There is one cash chart, `public/chart.js`.** Home and Forecast each drew the
same projection their own way, which is two pictures of one thing free to
disagree, and the copy on the Forecast page was still painting its axis labels
`var(--ink-soft)`, a token that stopped existing in the restyle. The band is
measured from today's balance rather than filled down to the axis: building up
and running down are then an area and a colour instead of a sign on a number,
and a fortnight that dips before payday and recovers after is visible there and
nowhere else. Today's level and zero are two annotated levels on one dollar
scale, which is not two axes. Zero is drawn only when the money comes near it,
and past a crossing the endpoint figure is dropped, because no account holds
minus two hundred dollars and printing it beside the date the money ran out is a
second, wronger answer to the same question.

**A tier ramp needs ink per step, not per theme.** `--tier-cut` is pale by design
and carried white text at 2.1 to 1, which is unreadable, on every optional
merchant on the Spending page. `--ink-keep`, `--ink-trim` and `--ink-cut` are
separate for that reason. The same class of bug put a data mark at 1.75 to 1:
`--axis` is a hairline and disappears when asked to carry a shape, so a neutral
series mark uses `--neutral`.

**There is one household plan.** Forecast, Today, Lasting, alerts and analysis
all use the same loaded model: recurring keep and trim costs, the saved
discretionary allowance, active commitments and configured income. Historical
cut spending and irregular essentials remain visible as context, but do not
silently enter the runway. Active cut commitments remain included until a
scenario explicitly turns them off, because a subscription still being charged
cannot quietly disappear. Anything `to_own_debt` stays essential regardless of
its category. `src/costs.js` owns classification, no page reimplements it.

**The plan on /plan must say when cutting is not enough.** `src/lean.js` builds
cumulative steps from costs that are present in the household plan, and each
step names what actually goes. Historical optional spending already outside the
plan is not offered as a second saving. "Lasts" means what comes in covers what goes out, never that
the 400 day projection happened to reach its last day above zero: the first
version reported "never runs out" for a step saving 5,689 against a gap of
6,883. When a step is short it says so and by how much, and the floor says
whether all of it together is enough.

**Tier defaults are a starting point, and the merchant beats the category.**
A category is too blunt to decide with: this household's "Services" holds health
cover and drone parts. Resolve the merchant for a commitment in JavaScript
through `matchKeyFor`, never by joining the two key kinds in SQL, or the plan
proposes cancelling the health insurance and stopping the loan repayments, which
is what it did. Anything `to_own_debt` is keep, whatever else says.

**A hypothetical dated today still counts.** `forecast()` skips day zero for
real events, because today's balance already holds them. A scenario event has
not happened, so it cannot be in the balance: events carrying `kind: 'scenario'`
apply on any day, including today. Without that, selling sixteen thousand
dollars of motorbikes bought exactly zero days, silently.

**A control decides how much you are shown, never what is true.** The Forecast
page led with "Household runway: beyond 90 days" in the colour used for good
news, which was the look ahead dropdown reading itself back: the same household
at 365 days said "355 days, runs out 2027-09-07", and at every setting below a
year the page said it did not run out at all. The default hid the finding. The
household question is answered over a fixed 400 days now, the same length Today
and the plan use, through the same `position()`, so all three agree whatever
this page is set to draw. The window bound `runway_date` stays, because the
chart must not draw a crossing outside what it is drawing. `position()` builds
what goes out from the cost model and knows nothing about a scenario, so an
excluded commitment is subtracted in cents afterwards, or the card disagrees
with the curve directly beneath it.

**Past a crossing there is no balance to report, in prose as well as on the
chart.** The chart already drops its endpoint figure there. The line above it
read "takes it to $761.91, dipping to -$718.88" under a headline saying the
money ran out in September, which is the same second, wronger answer the chart
rule exists to refuse. One rule, both places.

**Thirty two rows down a page is a calendar nobody reads.** "What is coming up"
listed every projected event, with the fuel stop six times and the pay five.
They group between paydays now, because that is the stretch each lot of pay has
to cover and it is the unit `thisPeriod` already measures. What goes out is
taken from the balance either side rather than by adding the events up:
everyday spending is applied as a daily rate and is not an event at all, so a
sum of events is short by most of the groceries, and doing it this way means the
listed rows cannot fail to add up to the curve above them. A period is only
whole when a payday closed it, which needs one payday generated past the end of
the window, or a fortnight that happens to end on the last day drawn is labelled
part of a period and reads as a warning about nothing.

**A bar's length is what survives, not what leaves.** Drawn as the share of the
pay spent, the fortnight with the most spending in it had the longest bar, in
green, directly beside a figure saying what was left over. Two marks for one
row pointing opposite ways. And a period with no pay in it gets no bar at all
rather than a full red one: that is the Today period card's rule, say no pay has
landed instead of dressing arithmetic as a warning.

**A commitment is named by its merchant, not by its payment rail.** The list
showed the statement text, so on a phone the mortgage read "OSKO PAYMEN..." and
the insurer "DIRECT DEBIT 0...", which names ING's transfer service and a direct
debit. The cost model already resolves the merchant through `matchKeyFor`; the
statement text moves into the detail as "The bank calls it". The tile takes the
merchant's initials with the tier as its colour, the same tile Spending and
Today use: "Ke", "Tr" and "Op" were a fourth vocabulary for something that
already reads as a word in the line underneath.

**`npm run reconcile` answers "are we counting correctly" without anyone
having to take it on trust.** The tests prove the code does what it was written
to do, on fixtures. `scripts/reconcile.js` checks the real data against
arithmetic that has to hold whatever the code does: every transaction on a
spendable account lands in exactly one bucket and the buckets sum to the raw
total, money moved between our own accounts nets to zero, a refund exactly
cancels its charge, nothing is counted as both pending and posted, both pages
measure the same window, and the difference between the headline and what
actually left is named commitment by commitment rather than shrugged at. It also
reads the source to check that every query summing money in still filters on the
income kind, because a future edit dropping that filter would pass every other
check. Run it after changing anything about what counts.

**A check has to assert something that can actually hold.** Reconcile used to
require that everything moved between our own accounts nets to zero, over a
bucket holding two different things: matched pairs, which have both sides by
construction and must net exactly, and destinations read out of a description,
which exist precisely because the other side is not in the data and so can never
net. One number covering both meant a real imbalance and a gap in the bank's own
reporting were indistinguishable, and the check could not be satisfied however
correct the code was. They are separate now: the pairs must net to zero, and the
one sided ones are held to a materiality threshold with the amount named, since
that is money kept out of the budget on a description alone.

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
  guide. A future anchor is the first full payday and is a boundary, not merely
  a day of month to project backwards through. A temporary expected income
  stream belongs on the cash curve but not in the ongoing monthly income rate.
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
