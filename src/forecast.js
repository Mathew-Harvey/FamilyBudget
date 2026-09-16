// Stage 4: cash forecast and runway.
//
// Projects spendable cash forward day by day from three things:
//   income     the pay cycle, using expected income when set, otherwise what
//              recent periods actually delivered
//   committed  the recurring outgoings found in src/commitments.js
//   everyday   the rest of our spending, as a daily rate from recent history
//
// Only liquid accounts count. The mortgage is a debt, not a buffer, and its
// redraw is deliberately ignored: it is money we would have to borrow back.
import { query } from './db.js';
import { numericToCents, centsToNumeric } from './money.js';
import { today as householdToday, addDays } from './dates.js';
import { periodsBetween, getPayCycle } from './buckets.js';
import { upcomingCommitments, matchKeyFor, medianCents } from './commitments.js';

const DAY_MS = 86_400_000;
const toDate = (value) => new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
const iso = (date) => date.toISOString().slice(0, 10);

// Money is added and subtracted as integer cents here, then rendered back to a
// decimal string at the edge, using the same exact conversions as everywhere
// else. An earlier version had its own Math.round(Number(x) * 100) here, which
// is float arithmetic on money and exactly what money.js exists to prevent.
// numericToCents refuses a float outright, so a caller passing one fails loudly
// instead of being quietly rounded.
const toCents = (value) => numericToCents(value ?? 0);
const fromCents = centsToNumeric;

// How far back the everyday spend rate looks.
//
// This was two months, chosen to duck the 2025 renovation. That worked, but it
// was the wrong instrument: a short window forgets one large purchase by
// forgetting everything, including the ordinary months that make a rate stable.
// Now that a one off can be marked as one, the window can go back to being
// about how much evidence to use, and more evidence is better.
//
// scripts/backtest.js measures this rather than assuming it. Standing at each
// week over the last six months and predicting the next sixty days of real
// spending, the mean error was:
//
//   120 days  $2,761      <- the default
//   150 days  $2,804
//    90 days  $3,899
//    60 days  $4,680
//    30 days  $5,016
//
// Shorter is not more current, it is noisier. Run the script again when there
// is more history, because this was eighteen tests on one year of data.
export const DEFAULT_SPEND_WINDOW_DAYS = Number(process.env.SPEND_WINDOW_DAYS || 120);

// What we can actually spend today: the latest balance of every liquid account.
export async function liquidBalance(client = { query }) {
  const { rows } = await client.query(`
    select a.id, a.bank, a.name, a.masked_number,
           b.balance, b.balance_date
      from accounts a
      left join lateral (
        select balance, balance_date from balances
         where account_id = a.id order by balance_date desc limit 1
      ) b on true
     where a.is_liquid
  `);
  const totalCents = rows.reduce((total, row) => total + toCents(row.balance ?? 0), 0);
  return { accounts: rows, total: fromCents(totalCents), total_cents: totalCents };
}

// The everyday spend rate: what goes out that is not a tracked commitment.
//
// The grouping is done here rather than in SQL on purpose. Deciding what is
// committed means comparing a description against a commitment's match key, and
// matchKeyFor is the only definition of how that key is built. Writing the same
// normalisation again in SQL meant the two drifted apart the moment one changed,
// and a commitment that fails to match gets counted twice, once as a commitment
// and again as everyday spending, which makes the runway look shorter than it is.
export async function everydaySpendRate(days = DEFAULT_SPEND_WINDOW_DAYS, client = { query }) {
  // The window is half open so it is exactly `days` long. It used to be
  // `>= current_date - days`, which is days + 1 days of spending divided by
  // days, and it disagreed with the Spending page by one day's worth.
  //
  // One offs are excluded. They really happened and they still appear in every
  // total, but a renovation is not a guide to next month, and leaving it in
  // meant the only defence was a window short enough to have forgotten it.
  const { rows } = await client.query(
    `select t.amount, coalesce(t.display_description, t.description) as label
       from budget_flows t
      where t.counts and t.amount < 0
        and not t.one_off
        and t.txn_date > current_date - $1::integer
        and t.txn_date <= current_date`,
    [days],
  );

  const { rows: [excluded] } = await client.query(
    `select coalesce(sum(-t.amount), 0) as total, count(*)::int as transactions
       from budget_flows t
      where t.counts and t.amount < 0 and t.one_off
        and t.txn_date > current_date - $1::integer
        and t.txn_date <= current_date`,
    [days],
  );

  const { rows: commitments } = await client.query('select match_key from commitments where active');
  const keys = new Set(commitments.map((row) => row.match_key));

  let totalCents = 0;
  let committedCents = 0;
  for (const row of rows) {
    const cents = -toCents(row.amount);
    totalCents += cents;
    if (keys.has(matchKeyFor(row.label))) committedCents += cents;
  }

  // Divide by the days we could actually have seen spending in, not by the days
  // asked for. A window of 120 days against 40 days of synced history divides
  // by three times the evidence and reports a rate a third of the truth, which
  // turns a short runway into a comfortable one. This matters most right after
  // a first sync, which is exactly when someone is deciding whether to trust
  // the app.
  const { rows: [span] } = await client.query(
    `select min(txn_date) as earliest from budget_flows where counts and amount < 0`,
  );
  const covered = span.earliest
    ? Math.round((Date.parse(`${householdToday()}T00:00:00Z`) - Date.parse(`${span.earliest}T00:00:00Z`)) / 86_400_000) + 1
    : days;
  const effectiveDays = Math.max(Math.min(days, covered), 1);

  const everydayCents = Math.max(totalCents - committedCents, 0);
  return {
    days,
    effective_days: effectiveDays,
    total: fromCents(totalCents),
    committed: fromCents(committedCents),
    everyday: fromCents(everydayCents),
    one_off_excluded: excluded.total,
    one_off_transactions: excluded.transactions,
    per_day_cents: Math.round(everydayCents / effectiveDays),
    per_day: fromCents(Math.round(everydayCents / effectiveDays)),
  };
}

// What each payday is expected to bring. The configured figure wins, because
// after a job change history is a poor guide.
export async function expectedIncomeCents(client = { query }) {
  const cycle = await getPayCycle(client);
  if (!cycle) return { cents: 0, source: 'no cycle set' };
  if (cycle.expected_income !== null && cycle.expected_income !== undefined) {
    return { cents: toCents(cycle.expected_income), source: 'the figure you set' };
  }

  // Fall back to the median of what recent periods actually brought in.
  // The filter belongs inside the aggregate, not in a where clause. A where
  // clause on a left joined table turns the outer join into an inner one, so a
  // pay period that brought in nothing vanished from the set instead of
  // counting as a zero, and the median of what is left reads high. A period
  // with no pay is exactly the kind the forecast needs to know about.
  const { rows } = await client.query(`
    select coalesce(sum(t.amount) filter (where c.kind = 'income'), 0) as income
      from pay_periods p
      left join budget_flows t
        on t.counts and t.txn_date between p.starts_on and p.ends_on
      left join categories c on c.id = t.category_id
     where p.ends_on < current_date
     group by p.id, p.starts_on
     order by p.starts_on desc
     limit 6
  `);
  if (!rows.length) return { cents: 0, source: 'no history yet' };
  // The lower middle value, the same median used for commitment amounts, so an
  // even number of periods does not invent an income that never arrived.
  return {
    cents: medianCents(rows.map((row) => toCents(row.income))),
    source: 'the median of recent periods',
  };
}

// The day by day projection.
export async function forecast({
  days = 90,
  buffer = 0,
  client = { query },
  // Which expected income to believe. A scenario can ask for the confirmed
  // only, to see how it looks without the hopeful money.
  includeConfidence = ['confirmed', 'likely'],
  // One off amounts applied on a date, which is how a purchase is tested
  // against the runway without changing anything stored.
  extraEvents = [],
  // How many days of recent spending set the everyday rate.
  window = DEFAULT_SPEND_WINDOW_DAYS,
  // Trade offs. Spending less every day, or stopping a commitment, so the
  // question "what would this actually buy us" can be answered as a date
  // rather than as a number of dollars. Neither changes anything stored.
  spendAdjustmentCentsPerDay = 0,
  excludeCommitmentIds = [],
} = {}) {
  const cycle = await getPayCycle(client);
  const opening = await liquidBalance(client);
  const rate = await everydaySpendRate(window, client);
  // The same rate over the other windows, so the page can show how sensitive
  // the runway is to the choice.
  const rateByWindow = {};
  for (const span of [30, 60, 90, 120, 180]) {
    rateByWindow[span] = span === window ? rate : await everydaySpendRate(span, client);
  }
  const income = await expectedIncomeCents(client);

  const today = householdToday();
  const end = addDays(today, days);

  // Paydays in the window, from the configured cycle.
  const paydays = cycle
    ? periodsBetween(cycle.cadence, cycle.anchor_date, today, end)
        .map((period) => period.starts_on)
        .filter((date) => date >= today && date <= end)
    : [];

  const skip = new Set(excludeCommitmentIds.map(String));
  const commitments = (await upcomingCommitments(today, end, client)).filter(
    (commitment) => !skip.has(String(commitment.commitment_id)),
  );

  // Income we know is coming but that has not appeared in the history yet: a
  // job starting, a side income beginning. Counted from its start date, so the
  // runway is not pessimistic about money we are confident of. A scenario can
  // exclude the less certain ones.
  const { rows: expected } = await client.query(
    `select label, amount, cadence_days, starts_on, ends_on, confidence
       from expected_income
      where active and confidence = any($1::text[])
      order by starts_on nulls first`,
    [includeConfidence],
  );

  // Bucket everything by date so one pass builds the curve.
  const eventsByDate = new Map();
  const push = (date, event) => {
    if (!eventsByDate.has(date)) eventsByDate.set(date, []);
    eventsByDate.get(date).push(event);
  };
  for (const date of paydays) push(date, { kind: 'income', label: 'Pay', amount_cents: income.cents });

  for (const stream of expected) {
    const cadence = Number(stream.cadence_days);
    // A cadence of zero or less would step the walk below nowhere and spin
    // forever. The table has a check constraint of its own, so this is defence
    // against a bad migration or a hand edited row rather than normal input.
    if (!Number.isFinite(cadence) || cadence <= 0) continue;
    let when = toDate(stream.starts_on ?? today);
    // Something already under way is picked up from today rather than replayed
    // from its start date.
    while (iso(when) < today) when = new Date(when.getTime() + cadence * DAY_MS);
    const stops = stream.ends_on ? toDate(stream.ends_on) : null;
    while (iso(when) <= end && (!stops || when <= stops)) {
      push(iso(when), {
        kind: 'expected_income',
        label: `${stream.label} (${stream.confidence})`,
        amount_cents: toCents(stream.amount),
      });
      when = new Date(when.getTime() + cadence * DAY_MS);
    }
  }
  for (const commitment of commitments) {
    push(commitment.date, {
      kind: 'commitment',
      label: commitment.label,
      amount_cents: toCents(commitment.amount),
    });
  }

  // Scenario events, for example "what if we spend 5000 on a bike in November".
  for (const event of extraEvents) {
    push(event.date, {
      kind: event.kind ?? 'scenario',
      label: event.label,
      amount_cents: toCents(event.amount),
    });
  }

  // Things the projection cannot fix by itself, said out loud rather than
  // quietly folded in.
  const warnings = [];

  // The projection starts from the last balance we were told about. If that is
  // days old, the opening figure is stale and everything after it is shifted.
  const staleDays = opening.accounts
    .map((account) => (account.balance_date ? Math.round((toDate(today).getTime() - toDate(account.balance_date).getTime()) / DAY_MS) : null))
    .filter((days) => days !== null);
  const stalest = staleDays.length ? Math.max(...staleDays) : 0;
  if (stalest > 2) {
    warnings.push({
      kind: 'stale_balance',
      message: `The newest balance we have is ${stalest} days old, so this starts from a figure that has moved. Run a sync.`,
    });
  }

  // An expected income stream that restates the salary already in the pay cycle
  // is counted twice, and the runway comes out long by a whole wage.
  if (cycle && income.cents > 0) {
    for (const stream of expected) {
      const streamMonthly = (toCents(stream.amount) * 30.44) / Number(stream.cadence_days || 30);
      const cycleMonthly = (income.cents * 30.44) / (cycle.cadence === 'monthly' ? 30.44 : cycle.cadence === 'fortnightly' ? 14 : 7);
      if (Math.abs(streamMonthly - cycleMonthly) < cycleMonthly * 0.1) {
        warnings.push({
          kind: 'possible_double_count',
          message: `"${stream.label}" is about the same as the pay you already have configured, so it may be counted twice.`,
        });
      }
    }
  }

  const bufferCents = toCents(buffer);
  let balanceCents = opening.total_cents;
  const series = [];
  let runwayDate = null;
  let lowest = { date: today, cents: balanceCents };

  for (let day = 0; day <= days; day++) {
    const date = addDays(today, day);
    const events = eventsByDate.get(date) ?? [];

    // Day zero is today's actual balance, so nothing is applied to it.
    if (day > 0) {
      for (const event of events) balanceCents += event.amount_cents;
      balanceCents -= Math.max(rate.per_day_cents - spendAdjustmentCentsPerDay, 0);
    }

    if (balanceCents < lowest.cents) lowest = { date, cents: balanceCents };
    // Day zero counts. Skipping it meant that a household already under its
    // buffer today reported no runway limit at all, which reads like good news
    // and is the opposite of the truth.
    if (runwayDate === null && balanceCents < bufferCents) runwayDate = date;

    series.push({
      date,
      balance: fromCents(balanceCents),
      balance_cents: balanceCents,
      events: events.map((event) => ({ ...event, amount: fromCents(event.amount_cents) })),
    });
  }

  return {
    generated_for: today,
    days,
    opening_balance: opening.total,
    liquid_accounts: opening.accounts,
    everyday_rate: rate,
    rate_by_window: rateByWindow,
    spend_window_days: window,
    expected_income: { amount: fromCents(income.cents), source: income.source },
    cycle,
    paydays,
    expected_income_streams: expected,
    runway_date: runwayDate,
    runway_days: runwayDate ? Math.round((toDate(runwayDate).getTime() - toDate(today).getTime()) / DAY_MS) : null,
    buffer: fromCents(bufferCents),
    warnings,
    lowest_balance: fromCents(lowest.cents),
    lowest_date: lowest.date,
    closing_balance: fromCents(balanceCents),
    series,
    upcoming: [...commitments]
      .slice(0, 40)
      .map((commitment) => ({ ...commitment, amount: String(commitment.amount) })),
  };
}
