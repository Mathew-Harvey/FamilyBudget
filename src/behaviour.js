// Presenting the numbers so that they actually change what we do.
//
// The rest of this app works out what is true. This file is about whether
// anyone acts on it, which is a different problem and mostly not a numerical
// one. docs/behaviour.md sets out the reasoning, what is deliberately used and
// what is deliberately refused. The short version:
//
//   - A runway is a date, never a number of days. "68 days" is arithmetic.
//     "23 November" collides with a real calendar and real plans.
//   - Every cost is also priced in days of runway, because that is the currency
//     that matters when the runway is the problem.
//   - Every suggestion is expressed as the date moving, not as dollars saved.
//   - Credit comes before criticism, because it is true here and because a
//     person told their effort failed stops making the effort.
//   - Nothing is ever attributed to Mat or to Skye. Only to categories. This is
//     a two person household and the fastest way to make a budgeting app
//     unopenable is to turn it into evidence.
//
// Every number here has to be true. The techniques below work by making real
// things vivid, and they are worth using for exactly that reason. The moment
// one of them needs a number bent to work, it goes, because the whole value of
// this thing is that the figures can be trusted.
import { query } from './db.js';
import { forecast, DEFAULT_SPEND_WINDOW_DAYS } from './forecast.js';
import { matchKeyFor } from './commitments.js';
import { numericToCents, centsToNumeric } from './money.js';
import { today as householdToday } from './dates.js';

const DAY_MS = 86_400_000;
const MONTH_DAYS = 30.44;

const toCents = (value) => numericToCents(value ?? 0);
const fromCents = centsToNumeric;
const parse = (value) => Date.parse(`${String(value).slice(0, 10)}T00:00:00Z`);

// A date a person can picture, which is the whole point of using one.
export function friendlyDate(iso, from = null) {
  if (!iso) return null;
  const date = new Date(parse(iso));
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const plain = `${date.getUTCDate()} ${months[date.getUTCMonth()]}`;
  // The year only when it is not this one. A runway date is weeks away and
  // reads better without it, but a debt that clears in 2029 written as
  // "26 August" is worse than useless, it is wrong by three years.
  const thisYear = new Date(parse(from ?? householdToday())).getUTCFullYear();
  return date.getUTCFullYear() === thisYear ? plain : `${plain} ${date.getUTCFullYear()}`;
}

// What a recurring cost is really worth, in the three units that matter.
//
// A subscription is sold monthly because a small monthly number is easy to
// agree to. That framing is doing work, and it is doing it against us, so the
// annual figure is shown next to it. The runway figure is the honest local
// unit: with cash going out faster than it comes in, a dollar saved is a
// fraction of a day before the money is gone.
export function priceIn({ monthlyCents, dailyGapCents, balanceCents }) {
  const yearly = monthlyCents * 12;

  // Days of runway this buys back if it stops.
  //
  // Not the share of one day's gap that it covers, which is what this said at
  // first and is the wrong shape entirely: it made a 300 dollar a month
  // subscription look like nothing. Stopping it slows the burn, and the runway
  // is the balance divided by what is left of the burn, so the gain is
  //
  //   balance / (gap - saving)  -  balance / gap
  //
  // which grows as the saving approaches the gap, and that is the real shape of
  // it. Small economies do very little on their own and several together do
  // more than their sum, which is worth seeing rather than being told.
  const dailySaving = monthlyCents / MONTH_DAYS;
  let runwayDays = null;
  let clearsTheGap = false;
  if (dailyGapCents > 0 && balanceCents > 0) {
    if (dailySaving >= dailyGapCents) clearsTheGap = true;
    else runwayDays = balanceCents / (dailyGapCents - dailySaving) - balanceCents / dailyGapCents;
  }

  return {
    per_month: fromCents(Math.round(monthlyCents)),
    per_year: fromCents(Math.round(yearly)),
    // Null when nothing is being burned, because then it does not buy time, it
    // buys savings, and when it covers the whole gap, which is a sentence and
    // not a number.
    runway_days: runwayDays === null ? null : Math.round(runwayDays * 10) / 10,
    clears_the_gap: clearsTheGap,
  };
}

// The blunt position. Three numbers and a date, and nothing else, because a
// dashboard of twenty numbers is a dashboard nobody reads.
export async function position({ client = { query }, window = DEFAULT_SPEND_WINDOW_DAYS } = {}) {
  const projection = await forecast({ days: 400, window, client });
  const rate = projection.everyday_rate;

  const { rows: [committed] } = await client.query(
    // Rounded in SQL: money.js refuses anything that is not exact to the cent,
    // and a rate worked out from a cadence is not.
    `select round(coalesce(sum(-typical_amount * 30.44 / nullif(cadence_days, 0)), 0), 2) as per_month
       from commitments where active`,
  );

  // Living, and paying down what we owe. Both leave the account, so the runway
  // is the same either way, but they are not the same kind of thing: one is
  // consumed and one buys down a liability. Reporting a single "going out"
  // figure is true and useless, because a third of it is not a monthly choice
  // and none of it can be trimmed the way the rest can.
  // Measured as a share of what went out rather than as its own total, then
  // applied to the figure the runway is actually built from. Two independent
  // measurements of the same quantity disagree by a fraction of a percent and
  // then visibly fail to add up on the page, which reads as a bug and costs
  // more than the precision is worth. One total, split proportionally.
  const { rows: [share] } = await client.query(
    `select coalesce(sum(-amount) filter (where to_own_debt), 0) as debt,
            coalesce(sum(-amount), 0) as total
       from budget_flows
      where counts and amount < 0 and not one_off and not no_longer_expected
        and txn_date > current_date - $1::integer and txn_date <= current_date`,
    [rate.effective_days],
  );

  const everydayMonthly = Math.round((toCents(rate.everyday) * MONTH_DAYS) / rate.effective_days);
  const committedMonthly = toCents(committed.per_month);
  const outMonthly = everydayMonthly + committedMonthly;

  // Income the same way the projection sees it, so the gap on this page and
  // the curve on the forecast page cannot disagree.
  const cycleMonthly = projection.cycle
    ? Math.round((toCents(projection.expected_income.amount) * MONTH_DAYS) /
        (projection.cycle.cadence === 'monthly' ? MONTH_DAYS : projection.cycle.cadence === 'fortnightly' ? 14 : 7))
    : 0;
  const streamsMonthly = (projection.expected_income_streams ?? [])
    .filter((stream) => stream.confidence !== 'possible')
    .reduce((total, stream) => total + Math.round((toCents(stream.amount) * MONTH_DAYS) / Number(stream.cadence_days || 30)), 0);
  const inMonthly = cycleMonthly + streamsMonthly;

  const totalCents = toCents(share.total);
  const debtMonthly = totalCents > 0
    ? Math.round((outMonthly * toCents(share.debt)) / totalCents)
    : 0;

  const gapMonthly = outMonthly - inMonthly;
  const dailyGapCents = Math.max(Math.round(gapMonthly / MONTH_DAYS), 0);

  return {
    as_of: householdToday(),
    spendable: projection.opening_balance,
    spendable_cents: toCents(projection.opening_balance),
    in_per_month: fromCents(inMonthly),
    out_per_month: fromCents(outMonthly),
    everyday_per_month: fromCents(everydayMonthly),
    committed_per_month: fromCents(committedMonthly),
    living_per_month: fromCents(outMonthly - debtMonthly),
    debt_per_month: fromCents(debtMonthly),
    // Positive means going backwards. Named gap rather than deficit because
    // one of those is a word people read and the other is a word they skip.
    gap_per_month: fromCents(gapMonthly),
    going_backwards: gapMonthly > 0,
    daily_gap_cents: dailyGapCents,
    runway_date: projection.runway_date,
    runway_date_friendly: friendlyDate(projection.runway_date),
    runway_days: projection.runway_days,
    window_days: window,
    effective_days: rate.effective_days,
    warnings: projection.warnings,
  };
}

// Spending either side of a date, with the regular bills taken out.
//
// Comparing a short recent window against a long earlier one is the only way to
// say anything about a change that happened five weeks ago, and it does one
// terrible thing: a fortnightly mortgage falls a different number of times per
// day in a 35 day window than in a 180 day one, so it appears to have gone up
// by over a thousand a month when nothing about it changed at all. The same
// goes for every monthly bill, the quarterly water, and the annual rates.
//
// So commitments come out. That is also the more useful question: "did we cut"
// is about the spending that is a decision each time, not about the mortgage.
// The exclusion uses matchKeyFor directly rather than repeating the
// normalisation in SQL, for the reason set out in CLAUDE.md: the two copies
// drift and the commitment silently starts being counted twice.
async function discretionary({ since, before, client, by }) {
  const { rows } = await client.query(
    `select coalesce(t.display_description, t.description) as label,
            t.merchant_key,
            coalesce(m.display_name, t.merchant_key, 'Not described by the bank') as place,
            m.what_it_is,
            coalesce(grp.name, cat.name, 'Uncategorised') as group_name,
            t.amount, t.txn_date
       from budget_flows t
       left join merchants m on m.match_key = t.merchant_key
       left join categories cat on cat.id = t.category_id
       left join categories grp on grp.id = cat.parent_id
      where t.counts and t.amount < 0 and not t.one_off and not t.no_longer_expected
        and t.txn_date >= $1::date - $2::integer`,
    [since, before],
  );

  const { rows: commitments } = await client.query('select match_key from commitments where active');
  const committed = new Set(commitments.map((row) => row.match_key));

  const buckets = new Map();
  for (const row of rows) {
    if (committed.has(matchKeyFor(row.label))) continue;
    const key = by === 'place' ? (row.merchant_key ?? row.place) : row.group_name;
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        label: by === 'place' ? row.place : row.group_name,
        what_it_is: row.what_it_is,
        beforeCents: 0,
        afterCents: 0,
        timesSince: 0,
        timesBefore: 0,
        // Distinct DATES, not charges. Three payments to a builder on one
        // afternoon is one event, and counting rows let it through the gate
        // below and onto the page as "+654 a month", a recurring habit invented
        // out of a single day.
        daysSince: new Set(),
        daysBefore: new Set(),
      });
    }
    const bucket = buckets.get(key);
    const cents = -toCents(row.amount);
    const date = String(row.txn_date).slice(0, 10);
    if (date >= since) {
      bucket.afterCents += cents;
      bucket.timesSince++;
      bucket.daysSince.add(date);
    } else {
      bucket.beforeCents += cents;
      bucket.timesBefore++;
      bucket.daysBefore.add(date);
    }
  }

  // A single payment is not a rate. Insurance and health cover are paid once a
  // year, and one of them landing inside the recent window turns into "health
  // spending is up 200 a month" when nothing changed except the calendar. Two
  // observations on one side or the other is the minimum for the comparison to
  // mean anything, and what falls out is reported separately rather than
  // dropped, because the money did genuinely leave.
  const out = [];
  const irregular = [];
  for (const bucket of buckets.values()) {
    if (bucket.daysSince.size >= 2 || bucket.daysBefore.size >= 2) out.push(bucket);
    else irregular.push(bucket);
  }
  out.irregular = irregular;
  return out;
}

// Did the cut stick?
//
// This is the most useful thing the app can show, and the easiest to get wrong.
// Everyone who has ever decided to spend less believes they then spent less.
// Comparing the rate before and after the decision is the only way to know, and
// the answer is frequently that real cuts were made and then spent elsewhere.
//
// It leads with what was cut. That is not softening: on this household the cuts
// were real and large, and a version of this that opened with the failure would
// be both less accurate and less likely to be looked at twice.
export async function didItStick({ since, client = { query }, before = 180 } = {}) {
  if (!since) throw new Error('A date to compare against is required');
  const now = householdToday();
  const afterDays = Math.max(Math.round((parse(now) - parse(since)) / DAY_MS), 1);

  // The same length of history either side would be ideal, but there is rarely
  // that much after a recent change, so the earlier window is longer and both
  // sides are expressed as a monthly rate.
  const rows = await discretionary({ since, before, client, by: 'group' });

  const lines = rows.map((row) => {
    const beforeMonthly = Math.round((row.beforeCents * MONTH_DAYS) / before);
    const afterMonthly = Math.round((row.afterCents * MONTH_DAYS) / afterDays);
    return {
      group: row.key,
      before_per_month: fromCents(beforeMonthly),
      after_per_month: fromCents(afterMonthly),
      change_per_month: fromCents(afterMonthly - beforeMonthly),
      change_cents: afterMonthly - beforeMonthly,
    };
  });

  const cuts = lines.filter((line) => line.change_cents < 0).sort((a, b) => a.change_cents - b.change_cents);
  const rises = lines.filter((line) => line.change_cents > 0).sort((a, b) => b.change_cents - a.change_cents);
  const cutTotal = cuts.reduce((total, line) => total + line.change_cents, 0);
  const riseTotal = rises.reduce((total, line) => total + line.change_cents, 0);

  return {
    since,
    days_since: afterDays,
    compared_against_days: before,
    cut: fromCents(-cutTotal),
    rose: fromCents(riseTotal),
    net_per_month: fromCents(cutTotal + riseTotal),
    stuck: cutTotal + riseTotal < 0,
    cuts,
    rises,
    lines: lines.sort((a, b) => a.change_cents - b.change_cents),
  };
}

// What moved, place by place, so the rises have names rather than being a
// category that grew.
export async function movers({ since, before = 180, client = { query }, limit = 12 } = {}) {
  const now = householdToday();
  const afterDays = Math.max(Math.round((parse(now) - parse(since)) / DAY_MS), 1);
  const rows = await discretionary({ since, before, client, by: 'place' });

  const scored = rows.map((row) => {
    const beforeMonthly = Math.round((row.beforeCents * MONTH_DAYS) / before);
    const afterMonthly = Math.round((row.afterCents * MONTH_DAYS) / afterDays);
    return {
      place: row.label,
      merchant_key: row.key,
      what_it_is: row.what_it_is,
      times_since: row.timesSince,
      before_per_month: fromCents(beforeMonthly),
      after_per_month: fromCents(afterMonthly),
      change_cents: afterMonthly - beforeMonthly,
      change_per_month: fromCents(afterMonthly - beforeMonthly),
    };
  });

  return {
    up: scored.filter((row) => row.change_cents > 0).sort((a, b) => b.change_cents - a.change_cents).slice(0, limit),
    down: scored.filter((row) => row.change_cents < 0).sort((a, b) => a.change_cents - b.change_cents).slice(0, limit),
    // Paid too rarely to have a rate: annual bills, mostly. Kept out of the
    // comparison and listed here, because the money did leave and quietly
    // dropping it would be its own kind of dishonesty.
    irregular: (rows.irregular ?? [])
      .filter((row) => row.afterCents > 0)
      .map((row) => ({ place: row.label, spent: fromCents(row.afterCents) }))
      .sort((a, b) => Number(b.spent) - Number(a.spent))
      .slice(0, 8),
  };
}

// What stopping something would actually buy, as a date.
//
// "Saving $90 a month" is a number nobody can act on, because nobody knows what
// $90 a month is worth. "23 November becomes 7 December" is the same fact in
// the unit that is currently scarce, and it is the unit the household is
// already worried about.
export async function tradeOff({ monthlyCents = 0, commitmentIds = [], window = DEFAULT_SPEND_WINDOW_DAYS, client = { query } } = {}) {
  const base = await forecast({ days: 400, window, client });
  const adjusted = await forecast({
    days: 400,
    window,
    client,
    spendAdjustmentCentsPerDay: Math.round(monthlyCents / MONTH_DAYS),
    excludeCommitmentIds: commitmentIds,
  });

  const moved = base.runway_date && adjusted.runway_date
    ? Math.round((parse(adjusted.runway_date) - parse(base.runway_date)) / DAY_MS)
    : null;

  return {
    from: base.runway_date,
    from_friendly: friendlyDate(base.runway_date),
    to: adjusted.runway_date,
    to_friendly: friendlyDate(adjusted.runway_date),
    // Null when the change clears the gap entirely, which is the answer worth
    // saying out loud rather than rendering as a very large number.
    days_gained: adjusted.runway_date ? moved : null,
    clears_the_gap: base.runway_date !== null && adjusted.runway_date === null,
  };
}

// The things worth stopping, ranked by what they buy rather than by size.
//
// Ranked by annual cost, because that is the number that makes a small monthly
// charge look like what it is. Only recurring things: telling someone to spend
// less at the supermarket is not an action, it is a mood.
export async function whatToStop({ client = { query }, window = DEFAULT_SPEND_WINDOW_DAYS, limit = 15 } = {}) {
  const here = await position({ client, window });

  const { rows } = await client.query(
    `select c.id, c.match_key, c.label, c.typical_amount, c.cadence_days, c.annual,
            cat.name as category,
            coalesce(grp.name, cat.name) as group_name
       from commitments c
       left join categories cat on cat.id = c.category_id
       left join categories grp on grp.id = cat.parent_id
      where c.active and c.cadence_days > 0
      order by -c.typical_amount * 30.44 / c.cadence_days desc
      limit $1`,
    [limit],
  );

  // Which of these are debt repayments rather than subscriptions.
  //
  // Worked out here rather than joined in SQL, because commitments.match_key
  // and transactions.merchant_key are two different normalisations of the same
  // description: matchKeyFor keeps three words and drops purely numeric ones,
  // merchantKeyFor strips processor prefixes and keeps four. Joining one to the
  // other matches almost nothing, which is exactly the drift CLAUDE.md warns
  // about, and the symptom was a "what to stop" list headed by the mortgage.
  // One definition, applied in JavaScript.
  // to_own_debt is the column built for exactly this question, and it already
  // covers the three ways a debt payment is recognised. The earlier version
  // asked "is it a transfer", which misses every hand entered debt: the credit
  // card payments have no counterpart row to pair with, so servicing Skye's
  // card was offered as something to cancel.
  const { rows: transferLabels } = await client.query(
    `select distinct coalesce(display_description, description) as label
       from budget_flows
      where counts and amount < 0 and to_own_debt`,
  );
  const debtKeys = new Set(transferLabels.map((row) => matchKeyFor(row.label)));

  // What a merchant is called, and whether it was marked essential, joined on
  // the commitment key rather than the merchant key. Those are two different
  // normalisations of the same description and joining them in SQL matched 13
  // of 33 commitments, so most rows silently lost their name and their
  // essential flag. Resolved here through the one definition instead.
  const { rows: merchantRows } = await client.query(
    `select m.match_key, m.display_name, m.what_it_is, m.essential,
            (select coalesce(t.display_description, t.description)
               from budget_flows t where t.merchant_key = m.match_key limit 1) as sample_label
       from merchants m`,
  );
  const byCommitmentKey = new Map();
  for (const row of merchantRows) {
    if (!row.sample_label) continue;
    const key = matchKeyFor(row.sample_label);
    if (key && !byCommitmentKey.has(key)) byCommitmentKey.set(key, row);
  }

  return {
    daily_gap_cents: here.daily_gap_cents,
    spendable_cents: here.spendable_cents,
    runway_date: here.runway_date,
    runway_date_friendly: here.runway_date_friendly,
    items: rows.map((row) => {
      const monthlyCents = Math.round((-toCents(row.typical_amount) * MONTH_DAYS) / Number(row.cadence_days));
      const merchant = byCommitmentKey.get(row.match_key);
      return {
        commitment_id: row.id,
        // The key a decision watches to check itself later.
        merchant_key: row.match_key,
        // The name someone gave it beats what the bank wrote, every time.
        label: merchant?.display_name ?? row.label,
        raw_label: row.label,
        what_it_is: merchant?.what_it_is ?? null,
        essential: merchant?.essential ?? false,
        // Fixed means it cannot simply be cancelled this month. It still shows,
        // because knowing the mortgage is 47,000 a year is worth knowing, but
        // it is listed apart from the things that are a choice.
        fixed: debtKeys.has(row.match_key) || Boolean(merchant?.essential),
        annual: row.annual,
        category: row.category,
        group: row.group_name,
        cadence_days: row.cadence_days,
        ...priceIn({
          monthlyCents,
          dailyGapCents: here.daily_gap_cents,
          balanceCents: here.spendable_cents,
        }),
      };
    }),
  };
}

// Decisions, and whether they held.
//
// The status is worked out from the transactions, not from what anyone ticked.
// An intention with nothing to watch stays self reported and says so, because
// an unverifiable claim presented as a verified one is the exact thing this
// file is supposed to avoid.
export async function intentions({ client = { query } } = {}) {
  const { rows } = await client.query(
    `select * from intentions where status in ('open', 'kept', 'slipped') order by created_at desc`,
  );
  if (!rows.length) return [];

  // What a decision watches is a commitment's match key, and budget_flows
  // carries a merchant key, which is a different normalisation of the same
  // description. Joining one to the other in SQL would match almost nothing and
  // every decision would look like it held, which is the worst possible way for
  // this to be wrong. So the check is done here with matchKeyFor, the one
  // definition, over the transactions since the earliest decision was made.
  const earliest = rows.reduce(
    (oldest, row) => (String(row.starts_on) < oldest ? String(row.starts_on) : oldest),
    String(rows[0].starts_on),
  );
  const { rows: since } = await client.query(
    `select coalesce(display_description, description) as label, txn_date
       from budget_flows
      where counts and amount < 0 and txn_date >= $1::date`,
    [earliest.slice(0, 10)],
  );

  const seen = new Map();
  for (const row of since) {
    const key = matchKeyFor(row.label);
    const date = String(row.txn_date).slice(0, 10);
    const entry = seen.get(key) ?? { count: 0, last: null };
    entry.count++;
    if (!entry.last || date > entry.last) entry.last = date;
    seen.set(key, entry);
  }

  const now = householdToday();
  return rows.map((row) => {
    const days = Math.round((parse(now) - parse(row.starts_on)) / DAY_MS);
    const start = String(row.starts_on).slice(0, 10);
    // Only charges on or after the day the decision was made count against it.
    const hits = row.merchant_key
      ? [...seen.entries()]
          .filter(([key]) => key === row.merchant_key)
          .map(([, entry]) => entry)
          .filter((entry) => entry.last >= start)
      : [];
    const charges = hits.reduce((total, entry) => total + entry.count, 0);

    let verdict = 'too early to tell';
    if (!row.merchant_key) verdict = 'nothing to check it against';
    else if (charges > 0) verdict = 'still being charged';
    // A fortnight proves nothing about a monthly bill, so only call it held
    // once a full cycle has had the chance to go past.
    else if (days >= 35) verdict = 'held';

    return {
      ...row,
      days_since: days,
      charges_since: charges,
      last_charge: hits[0]?.last ?? null,
      verdict,
    };
  });
}

// What is owed, what it is being serviced at, and when each one is gone.
//
// A balance is a number you get used to. A date it disappears is not, and it is
// the same fact. The small debts are the motivating ones here: the mortgage is
// a thirty year fixture, but the solar battery and the cards clear inside a
// couple of years at the current rate, and seeing that is worth more than
// seeing the total.
//
// The payoff date ignores interest, which is honest for the interest free
// finance and optimistic for a credit card. It says so rather than pretending
// to an accuracy it does not have: the real schedule depends on a rate this app
// is not told.
export async function debts({ client = { query }, window = DEFAULT_SPEND_WINDOW_DAYS } = {}) {
  const { rows } = await client.query(
    `select a.id, a.name, a.role, a.bank,
            b.balance,
            round(coalesce(d.per_month, 0), 2) as per_month,
            coalesce(d.payments, 0) as payments,
            d.first_payment,
            round(coalesce(y.paid_in_year, 0), 2) as per_year
       from accounts a
       left join lateral (
         select balance from balances where account_id = a.id
          order by balance_date desc limit 1
       ) b on true
       left join lateral (
         -- The window, or the days since the first payment if that is shorter.
         --
         -- Two things had to be true at once. It has to use the same window as
         -- the headline, or the rows in this card do not add up to the "paying
         -- down debt" figure directly above them and the page contradicts
         -- itself. And it must not divide by days an account did not exist for,
         -- which is the same defect everydaySpendRate had. least() does both.
         select sum(-t.amount) * 30.44
                  / greatest(least($1::integer, current_date - min(t.txn_date)), 30) as per_month,
                count(*)::int as payments,
                sum(-t.amount) as paid_in_window,
                min(t.txn_date) as first_payment
           from budget_flows t
           left join merchants m on m.match_key = t.merchant_key
          where t.counts and t.to_own_debt
            and t.txn_date > current_date - $1::integer
            and (m.pays_account_id = a.id
                 or t.internal_to_account_id = a.id
                 or exists (
                   select 1 from transactions p
                    where p.id = t.transfer_pair_id and p.account_id = a.id
                 ))
       ) d on true
       left join lateral (
         -- A full year, for the debts paid too rarely to have a monthly rate.
         -- The Bendigo card is one annual fee: the window cannot see it and the
         -- year can.
         select sum(-t.amount) as paid_in_year
           from budget_flows t
           left join merchants m on m.match_key = t.merchant_key
          where t.counts and t.to_own_debt
            and t.txn_date > current_date - 365
            and (m.pays_account_id = a.id
                 or t.internal_to_account_id = a.id
                 or exists (
                   select 1 from transactions p
                    where p.id = t.transfer_pair_id and p.account_id = a.id
                 ))
       ) y on true
      where not a.is_liquid
      order by b.balance nulls last`,
    [window],
  );

  const now = Date.parse(`${householdToday()}T00:00:00Z`);
  return rows.map((row) => {
    const owedCents = Math.abs(toCents(row.balance ?? 0));

    // Three payments in a year is the least that can establish a monthly rate.
    //
    // Below that, dividing by the window invents one. The Bendigo card is paid
    // once a year to keep the line of credit open, and a single payment spread
    // over a 120 day window was reported as 25.37 a month, which is 304 a year
    // against a real cost of 25. Twelve times over, on a page whose whole claim
    // is that the numbers are true. Now it reports the year, because that is
    // what one payment a year actually tells us.
    const regular = row.payments >= 3;
    const perMonthCents = regular ? toCents(row.per_month ?? 0) : 0;
    const perYearCents = toCents(row.per_year ?? 0);
    const months = perMonthCents > 0 && owedCents > 0 ? owedCents / perMonthCents : null;
    // Anything past about a decade is a fixture, not a countdown, and putting a
    // date on it would be false precision about a rate that will change.
    const clearedOn = months !== null && months < 120
      ? new Date(now + months * 30.44 * DAY_MS).toISOString().slice(0, 10)
      : null;
    return {
      account_id: row.id,
      name: row.name,
      role: row.role,
      owed: fromCents(owedCents),
      owed_cents: owedCents,
      per_month: fromCents(perMonthCents),
      per_year: fromCents(perYearCents),
      payments_seen: row.payments,
      // False when there were too few payments to call it a rate. The UI says
      // what was actually observed instead of implying a monthly commitment.
      regular,
      months_left: months === null ? null : Math.round(months),
      cleared_on: clearedOn,
      cleared_on_friendly: clearedOn ? friendlyDate(clearedOn) : null,
      // A card with no balance is a line of credit being kept open, not a debt.
      unused_credit_line: owedCents === 0 && perMonthCents > 0,
    };
  });
}
