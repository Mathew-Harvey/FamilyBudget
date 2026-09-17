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
import { forecast, buildForecastContext, DEFAULT_SPEND_WINDOW_DAYS } from './forecast.js';
import { matchKeyFor } from './commitments.js';
import { numericToCents, centsToNumeric, centsPerMonth, monthlyFromDaily, dailyFromMonthly } from './money.js';
import { today as householdToday, addDays } from './dates.js';
import { currentPeriod, getPayCycle, periodsBetween } from './buckets.js';

const DAY_MS = 86_400_000;
// Only priceIn uses this, and it uses it as a real number on purpose: the
// runway formula below divides by the difference between two daily rates, and
// rounding either to whole cents first moves the answer by days. Every other
// conversion between a rate and a period goes through money.js.
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

// How much of a projection a page draws.
//
// Long enough to hold the answer and no longer. When the money reaches zero the
// chart is about that crossing, so it runs a few weeks past it rather than
// ending on it: a line that stops exactly where it fails looks like the edge of
// the chart rather than the edge of the money. When it does not, half a year is
// as far as anyone can act on, and a 400 day curve on the front page is a
// picture of a household that does not exist yet.
export function curveHorizon(projection) {
  return projection.runway_days === null
    ? 182
    : Math.min(projection.runway_days + 21, projection.days);
}

// The horizon can be given, so two curves drawn against each other share one.
export function cashCurve(projection, horizon = curveHorizon(projection)) {
  return {
    runway_date: projection.runway_date,
    series: projection.series
      .slice(0, horizon + 1)
      .map((point) => ({ date: point.date, balance_cents: point.balance_cents })),
  };
}

// What is coming up, cut into the periods the household actually lives in.
//
// Thirty two rows down a page, with the fuel stop six times and the pay five,
// is a calendar nobody reads. The pay lands every fortnight and has to cover
// what happens before the next lot, which is the same unit the Today page
// measures, so the bills are grouped between paydays.
//
// What goes out is taken from the balance either side rather than by adding the
// events up: everyday spending is applied as a daily rate and is not an event
// at all, so a sum of events would be short by most of the groceries. Doing it
// this way also means the rows cannot fail to add up to the curve above them,
// which is the arithmetic the plan card got wrong.
export function payPeriods(projection) {
  const series = projection.series ?? [];
  if (series.length < 2) return [];

  const balances = new Map(series.map((point) => [point.date, point.balance_cents]));
  const first = series[0].date;
  const last = series.at(-1).date;
  const paydays = projection.paydays ?? [];
  const starts = [first, ...paydays.filter((date) => date > first && date <= last)];

  // One payday past the end of the window, so the last group can say whether it
  // is a whole period or one the look ahead cut in half. Without it a fortnight
  // that happens to end on the last day drawn is labelled partial, which reads
  // as a warning about nothing.
  const beyond = projection.cycle
    ? periodsBetween(projection.cycle.cadence, projection.cycle.anchor_date, last, addDays(last, 40))
      .map((period) => period.starts_on)
      .find((date) => date > last)
    : null;

  return starts.map((start, index) => {
    const next = starts[index + 1];
    const end = next
      ? series[series.findIndex((point) => point.date === next) - 1]?.date ?? start
      : last;
    const opening = index === 0
      ? numericToCents(projection.opening_balance)
      : balances.get(series[series.findIndex((point) => point.date === start) - 1]?.date) ?? 0;
    const closing = balances.get(end) ?? opening;

    const events = series
      .filter((point) => point.date >= start && point.date <= end)
      .flatMap((point) => point.events.map((event) => ({ ...event, date: point.date })));
    const incomeCents = events
      .filter((event) => event.amount_cents > 0)
      .reduce((total, event) => total + event.amount_cents, 0);
    const billsCents = events
      .filter((event) => event.amount_cents < 0)
      .reduce((total, event) => total - event.amount_cents, 0);
    const outCents = incomeCents - (closing - opening);

    return {
      starts: start,
      ends: end,
      // Today is usually part way through a period, and the look ahead usually
      // stops part way through the last one. Neither stub should be compared
      // against a whole fortnight, so each says which it is rather than being
      // assumed.
      partial: (index === 0 && !paydays.includes(first))
        || (!next && beyond !== addDays(last, 1)),
      opening: centsToNumeric(opening),
      closing: centsToNumeric(closing),
      income: centsToNumeric(incomeCents),
      out: centsToNumeric(outCents),
      bills: centsToNumeric(billsCents),
      // The remainder, so the two parts of "out" always add back to it.
      everyday: centsToNumeric(outCents - billsCents),
      left_over: centsToNumeric(closing - opening),
      events,
    };
  });
}


// The blunt position. Three numbers and a date, and nothing else, because a
// dashboard of twenty numbers is a dashboard nobody reads.
export async function position({
  client = { query },
  window = DEFAULT_SPEND_WINDOW_DAYS,
  forecastContext = null,
  projection = null,
} = {}) {
  const context = forecastContext ?? await buildForecastContext({
    window,
    client,
  });
  const costs = context.costs;
  const view = projection ?? await forecast({
    days: 400,
    window,
    client,
    forecastContext: context,
  });
  const rate = view.everyday_rate;

  const everydayMonthly = monthlyFromDaily(view.projected_everyday_rate.per_day_cents);
  const committedMonthly = costs.commitments
    .reduce((total, row) => total + row.per_month_cents, 0);
  const outMonthly = everydayMonthly + committedMonthly;

  // Income the same way the projection sees it, so the gap on this page and
  // the curve on the forecast page cannot disagree.
  // A monthly cycle is already monthly, so it is not divided by anything.
  const cycleMonthly = view.cycle
    ? (view.cycle.cadence === 'monthly'
        ? toCents(view.expected_income.amount)
        : centsPerMonth(toCents(view.expected_income.amount), view.cycle.cadence === 'fortnightly' ? 14 : 7))
    : 0;
  const asOf = householdToday();
  const streamsMonthly = (view.expected_income_streams ?? [])
    // A stream with an end date is temporary, including a one-time partial
    // first pay. It belongs on the cash curve, not in the ongoing monthly
    // income figure used to decide whether the household is going backwards.
    .filter((stream) => stream.confidence !== 'possible' && !stream.ends_on)
    // And a stream that has not started is not income yet. Same rule, other
    // end. A second wage beginning on 5 January was counted in full from the
    // day it was entered: the front page read "18,394.46 in" against a real
    // 14,045.89 and told a household four months away from that money that it
    // had 11,172.87 a month spare. It is on the curve from the day it starts,
    // which is where a future wage belongs, and the page says one is coming.
    .filter((stream) => !stream.starts_on || String(stream.starts_on).slice(0, 10) <= asOf)
    .reduce((total, stream) => total + centsPerMonth(toCents(stream.amount), Number(stream.cadence_days) || 30), 0);
  const inMonthly = cycleMonthly + streamsMonthly;

  // A share of outMonthly, not a second measurement of what goes out.
  //
  // It reads like one, so it is worth saying why it is not. outMonthly is
  // everydayMonthly plus committedMonthly, and both halves of this sum are
  // subsets of those: the debt commitments are part of committedMonthly, and a
  // debt row that is variable and recurring carries to_own_debt, which forces
  // tier 'keep', which puts it in recurring essentials, which is what
  // everydayMonthly is built from. So this adds up parts of one total rather
  // than measuring the same thing twice, and living_per_month below is the
  // remainder. The clamp is only there because the two halves round separately.
  const debtMonthly = Math.min(
    costs.commitments
      .filter((row) => row.is_debt)
      .reduce((total, row) => total + row.per_month_cents, 0)
      + costs.variable
        .filter((row) => row.is_debt && row.recurring)
        .reduce((total, row) => total + row.per_month_cents, 0),
    outMonthly,
  );

  const gapMonthly = outMonthly - inMonthly;
  const dailyGapCents = Math.max(dailyFromMonthly(gapMonthly), 0);

  return {
    as_of: householdToday(),
    spendable: view.opening_balance,
    spendable_cents: toCents(view.opening_balance),
    in_per_month: fromCents(inMonthly),
    out_per_month: fromCents(outMonthly),
    everyday_per_month: fromCents(everydayMonthly),
    recurring_essential_per_month: fromCents(
      monthlyFromDaily(rate.recurring_essential_per_day_cents),
    ),
    discretionary_per_month: fromCents(costs.discretionary_allowance_cents),
    // What optional day to day spending has actually been running at, which the
    // allowance above replaces in the plan. The Forecast page already showed
    // this; Today did not, so a household whose allowance was still at zero
    // read "more is coming in than going out" against an "out" that left out
    // every dollar of it. The plan is unchanged: this is the context
    // docs/behaviour.md requires to stay visible rather than a second figure
    // anything is computed from.
    optional_history_per_month: fromCents(costs.historical_discretionary_per_month_cents),
    optional_history_excluded: fromCents(
      Math.max(costs.historical_discretionary_per_month_cents - costs.discretionary_allowance_cents, 0),
    ),
    committed_per_month: fromCents(committedMonthly),
    living_per_month: fromCents(outMonthly - debtMonthly),
    debt_per_month: fromCents(debtMonthly),
    // Positive means going backwards. Named gap rather than deficit because
    // one of those is a word people read and the other is a word they skip.
    gap_per_month: fromCents(gapMonthly),
    going_backwards: gapMonthly > 0,
    daily_gap_cents: dailyGapCents,
    runway_date: view.runway_date,
    runway_date_friendly: friendlyDate(view.runway_date),
    runway_days: view.runway_days,
    window_days: window,
    effective_days: rate.effective_days,
    warnings: view.warnings,
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
    const beforeMonthly = centsPerMonth(row.beforeCents, before);
    const afterMonthly = centsPerMonth(row.afterCents, afterDays);
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
    const beforeMonthly = centsPerMonth(row.beforeCents, before);
    const afterMonthly = centsPerMonth(row.afterCents, afterDays);
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
export async function tradeOff({
  monthlyCents = 0,
  commitmentIds = [],
  window = DEFAULT_SPEND_WINDOW_DAYS,
  client = { query },
  forecastContext = null,
} = {}) {
  const context = forecastContext ?? await buildForecastContext({
    window,
    client,
  });
  const base = await forecast({ days: 400, window, client, forecastContext: context });
  const adjusted = await forecast({
    days: 400,
    window,
    client,
    forecastContext: context,
    spendAdjustmentCentsPerDay: dailyFromMonthly(monthlyCents),
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
export async function whatToStop({
  client = { query },
  window = DEFAULT_SPEND_WINDOW_DAYS,
  limit = 15,
  forecastContext = null,
  positionResult = null,
} = {}) {
  const context = forecastContext ?? await buildForecastContext({
    window,
    client,
  });
  const costs = context.costs;
  const here = positionResult ?? await position({
    client, window, forecastContext: context,
  });

  return {
    daily_gap_cents: here.daily_gap_cents,
    spendable_cents: here.spendable_cents,
    runway_date: here.runway_date,
    runway_date_friendly: here.runway_date_friendly,
    items: costs.commitments.slice(0, limit).map((row) => {
      const monthlyCents = row.per_month_cents;
      return {
        commitment_id: row.commitment_id,
        // The key a decision watches to check itself later.
        merchant_key: row.match_key,
        label: row.name,
        raw_label: row.label,
        what_it_is: row.what_it_is,
        // The tier itself, not just whether it is optional. The page shows how
        // hard each cost would be to stop, and collapsing three tiers to a
        // boolean here forced it to guess the third one back, which is a second
        // copy of a classification src/costs.js owns.
        tier: row.tier,
        // And where that tier came from. 'cut' is where a commitment lands when
        // nothing has judged it, so the front page was presenting things nobody
        // had looked at as things somebody had decided were optional, and
        // inviting you to tick them off. A default is not a finding.
        tier_source: row.tier_source,
        essential: row.tier !== 'cut',
        // Fixed means it cannot simply be cancelled this month. It still shows,
        // because knowing the mortgage is 47,000 a year is worth knowing, but
        // it is listed apart from the things that are a choice.
        fixed: row.tier !== 'cut',
        annual: row.annual,
        category: row.category,
        group: row.group,
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
export async function debts({
  client = { query },
  window = DEFAULT_SPEND_WINDOW_DAYS,
  costs = null,
} = {}) {
  // One pass over the debt payments, not two per account.
  //
  // This was two lateral subqueries per non liquid account, each scanning
  // budget_flows and each carrying a correlated exists against transactions for
  // the paired side. On the front page that came to 1,484ms of a 1,543ms
  // request: 96 percent of the time it took to open the app, against 15ms for
  // the whole Spending page. The join is the same three way OR as before, so a
  // payment that matches an account more than one way still counts once per
  // account exactly as it did.
  //
  // The span is deliberately unbounded here: per_month divides by how long the
  // debt has been serviced, which is the first payment ever and not the first
  // one the window caught. The year figure filters inside instead.
  const { rows } = await client.query(
    `with paid as (
       select t.txn_date, t.amount, a.id as account_id
         from budget_flows t
         left join merchants m on m.match_key = t.merchant_key
         left join transactions p on p.id = t.transfer_pair_id
         join accounts a
           on (m.pays_account_id = a.id
               or t.internal_to_account_id = a.id
               or p.account_id = a.id)
        where t.counts and t.to_own_debt and not a.is_liquid
     ),
     windowed as (
       select account_id,
              sum(-amount) filter (where txn_date > current_date - $1::integer) * 30.44
                / greatest(least($1::integer, current_date - min(txn_date)), 30) as per_month,
              count(*) filter (where txn_date > current_date - $1::integer)::int as payments,
              min(txn_date) filter (where txn_date > current_date - $1::integer) as first_payment
         from paid group by account_id
     ),
     yearly as (
       -- A full year, for the debts paid too rarely to have a monthly rate. The
       -- Bendigo card is one annual fee: the window cannot see it, the year can.
       select account_id, sum(-amount) as paid_in_year
         from paid
        where txn_date > current_date - 365
        group by account_id
     ),
     labels as (
       -- What paid each account, so a payment can be matched to the commitment
       -- that projects it. Grouped in JavaScript through matchKeyFor, never
       -- joined to commitments.match_key in SQL: the two keys are different
       -- normalisations and would match almost nothing.
       select account_id, array_agg(distinct label) as labels from (
         select a.id as account_id,
                coalesce(t.display_description, t.description) as label
           from budget_flows t
           left join merchants m on m.match_key = t.merchant_key
           left join transactions p on p.id = t.transfer_pair_id
           join accounts a
             on (m.pays_account_id = a.id
                 or t.internal_to_account_id = a.id
                 or p.account_id = a.id)
          where t.counts and t.to_own_debt and not a.is_liquid
       ) x group by account_id
     )
     select a.id, a.name, a.role, a.bank,
            b.balance,
            coalesce(l.labels, '{}') as labels,
            round(coalesce(d.per_month, 0), 2) as per_month,
            coalesce(d.payments, 0) as payments,
            d.first_payment,
            round(coalesce(y.paid_in_year, 0), 2) as per_year
       from accounts a
       left join lateral (
         select balance from balances where account_id = a.id
          order by balance_date desc limit 1
       ) b on true
       left join windowed d on d.account_id = a.id
       left join yearly y on y.account_id = a.id
       left join labels l on l.account_id = a.id
      where not a.is_liquid
      order by b.balance nulls last`,
    [window],
  );

  // What the plan charges each account, as opposed to what the flows measured.
  //
  // These are two measurements of one thing, and the front page was showing
  // both: "Debt 3,652.80" in the out bar, over a card whose rows summed to
  // 3,361.08. The Bendigo card is the gap. Its payments vary, so the flows put
  // it at 875.15 a month and the commitment that the runway is actually built
  // from puts it at 1,166.87. The card sat under the headline looking like its
  // breakdown and was 291.72 short, and its "gone 20 November" was worked out
  // from the rate nothing else in the app uses.
  //
  // There is one household plan, so the card reports the plan. The observed
  // figure stays as per_year, which is a different claim and says so.
  const plannedByAccount = new Map();
  if (costs) {
    const debtCommitments = costs.commitments.filter((c) => c.is_debt);
    for (const row of rows) {
      const keys = new Set((row.labels ?? []).map((label) => matchKeyFor(label)).filter(Boolean));
      const cents = debtCommitments
        .filter((c) => keys.has(c.match_key))
        .reduce((total, c) => total + c.per_month_cents, 0);
      if (cents > 0) plannedByAccount.set(row.id, cents);
    }
  }

  const now = Date.parse(`${householdToday()}T00:00:00Z`);
  return rows.map((row) => {
    const owedCents = Math.abs(toCents(row.balance ?? 0));
    const plannedCents = plannedByAccount.get(row.id) ?? null;

    // Three payments in a year is the least that can establish a monthly rate.
    //
    // Below that, dividing by the window invents one. The Bendigo card is paid
    // once a year to keep the line of credit open, and a single payment spread
    // over a 120 day window was reported as 25.37 a month, which is 304 a year
    // against a real cost of 25. Twelve times over, on a page whose whole claim
    // is that the numbers are true. Now it reports the year, because that is
    // what one payment a year actually tells us.
    // A commitment is already the app's judgement that this recurs, so an
    // account the plan covers is regular whatever the window happened to catch.
    const regular = plannedCents !== null || row.payments >= 3;
    const perMonthCents = plannedCents ?? (regular ? toCents(row.per_month ?? 0) : 0);
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
      // Whether this rate is the household plan's or this query's own reading
      // of the payments. Only a debt the plan does not carry uses the second.
      rate_from: plannedCents !== null ? 'plan' : 'payments',
      observed_per_month: fromCents(toCents(row.per_month ?? 0)),
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

// How this fortnight is going.
//
// Every other figure in this app is a month, and nobody lives a month. This
// household is paid every fortnight: money lands, and it has to last until the
// next lot lands. That is the unit the decisions are actually taken in, and
// "965 a month short" is a fact about a shape while "443 short this fortnight"
// is a fact about the week you are having.
//
// Measured, not converted. Dividing the monthly rate by 2.17 would give a
// fortnight sized number that describes no particular fortnight. This reads
// what actually came in and went out since the last payday, which is a
// different and better claim, and it needs no rate at all.
//
// The balance is deliberately not the subject. A household with 22,000 in the
// bank is not "living on 2,846 for four days", so the card is about the flow
// through this period: did the money that arrived cover what has gone out. That
// question means the same thing at any balance.
export async function thisPeriod({ client = { query }, projection = null } = {}) {
  const period = await currentPeriod(client);
  if (!period) return null;
  // The word follows the configured cycle. Calling a weekly period a fortnight
  // is the page telling somebody something about their own pay that is wrong.
  const cycle = await getPayCycle(client);
  const unit = { weekly: 'week', fortnightly: 'fortnight', monthly: 'month' }[cycle?.cadence]
    ?? 'pay period';

  const starts = String(period.starts_on).slice(0, 10);
  const ends = String(period.ends_on).slice(0, 10);
  const today = householdToday();

  // Bounded at today, not at the end of the period. Both ends, because a future
  // dated row would otherwise be counted as money already spent.
  const { rows: [totals] } = await client.query(
    `select
       coalesce(sum(t.amount) filter (where c.kind = 'income'), 0) as income,
       -- Money out is money out. Without the sign test an uncategorised deposit
       -- fell through "c.kind is null" and had its negation added to the out
       -- total, so a pay that arrived before anyone filed it would not show as
       -- income AND would subtract from spending. Every deposit on this
       -- household happens to be categorised, which is exactly why this would
       -- have gone unnoticed until the one time it was not.
       coalesce(sum(-t.amount) filter (
         where (c.kind = 'expense' or c.kind is null) and t.amount < 0), 0) as out
     from budget_flows t
     left join categories c on c.id = t.category_id
     where t.counts
       and t.txn_date >= $1::date and t.txn_date <= $2::date`,
    [starts, today],
  );

  const day = 86_400_000;
  const parseDay = (iso) => Date.parse(`${iso}T00:00:00Z`);
  const totalDays = Math.round((parseDay(ends) - parseDay(starts)) / day) + 1;
  const elapsed = Math.min(Math.round((parseDay(today) - parseDay(starts)) / day) + 1, totalDays);
  const daysLeft = Math.max(totalDays - elapsed, 0);
  const nextPay = new Date(parseDay(ends) + day).toISOString().slice(0, 10);

  const inCents = toCents(totals.income);
  const outCents = toCents(totals.out);

  // Where an even spend would have reached by now. Not a forecast and not a
  // second rate: it is this period's own income multiplied by the share of the
  // period that has passed, which is the line the "out" bar is read against.
  const paceCents = Math.round((inCents * elapsed) / totalDays);

  // What the plan says is still to come before payday, read off the projection
  // the rest of the app is built from rather than worked out again here.
  let expectedOutCents = null;
  if (projection?.series?.length) {
    const byDate = new Map(projection.series.map((point) => [point.date, point.balance_cents]));
    const now = byDate.get(today);
    const atPayday = byDate.get(ends);
    if (now !== undefined && atPayday !== undefined) expectedOutCents = now - atPayday;
  }

  return {
    cadence: cycle?.cadence ?? null,
    unit,
    starts_on: starts,
    ends_on: ends,
    next_payday: nextPay,
    next_payday_friendly: friendlyDate(nextPay),
    days_total: totalDays,
    days_elapsed: elapsed,
    days_left: daysLeft,
    in_so_far: fromCents(inCents),
    in_so_far_cents: inCents,
    out_so_far: fromCents(outCents),
    out_so_far_cents: outCents,
    // Positive means this fortnight has paid for itself so far.
    net_so_far: fromCents(inCents - outCents),
    ahead: outCents <= paceCents,
    // Without income in this period there is nothing for an even spend to be
    // even against: the pace line is zero, so every dollar is "past" it and
    // saying so would be arithmetic dressed as a warning.
    has_income: inCents > 0,
    pace_cents: paceCents,
    pace: fromCents(paceCents),
    // How far off an even spend it is, which is the number the bar is showing.
    off_pace: fromCents(Math.abs(outCents - paceCents)),
    still_to_come: expectedOutCents === null ? null : fromCents(Math.max(expectedOutCents, 0)),
  };
}
