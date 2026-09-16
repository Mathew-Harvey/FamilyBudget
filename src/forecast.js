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
import { periodsBetween, getPayCycle } from './buckets.js';
import { upcomingCommitments, matchKeyFor } from './commitments.js';

const DAY_MS = 86_400_000;
const toDate = (value) => new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
const iso = (date) => date.toISOString().slice(0, 10);

// Money is added and subtracted as integer cents here, then rendered back to a
// decimal string at the edge. No float arithmetic touches a balance.
const toCents = (value) => Math.round(Number(value) * 100);
const fromCents = (cents) => {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const remainder = abs % 100;
  return `${negative ? '-' : ''}${(abs - remainder) / 100}.${String(remainder).padStart(2, '0')}`;
};

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
export async function everydaySpendRate(days = 90, client = { query }) {
  const { rows } = await client.query(
    `select t.amount, coalesce(t.display_description, t.description) as label
       from budget_flows t
      where t.counts and t.amount < 0
        and t.txn_date >= current_date - $1::integer
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

  const everydayCents = Math.max(totalCents - committedCents, 0);
  return {
    days,
    total: fromCents(totalCents),
    committed: fromCents(committedCents),
    everyday: fromCents(everydayCents),
    per_day_cents: Math.round(everydayCents / days),
    per_day: fromCents(Math.round(everydayCents / days)),
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
  const { rows } = await client.query(`
    select coalesce(sum(t.amount), 0) as income
      from pay_periods p
      left join budget_flows t
        on t.counts and t.txn_date between p.starts_on and p.ends_on
      left join categories c on c.id = t.category_id and c.kind = 'income'
     where p.ends_on < current_date
       and c.kind = 'income'
     group by p.id, p.starts_on
     order by p.starts_on desc
     limit 6
  `);
  if (!rows.length) return { cents: 0, source: 'no history yet' };
  const values = rows.map((row) => toCents(row.income)).sort((a, b) => a - b);
  return { cents: values[Math.floor(values.length / 2)], source: 'the median of recent periods' };
}

// The day by day projection.
export async function forecast({ days = 90, buffer = 0, client = { query } } = {}) {
  const cycle = await getPayCycle(client);
  const opening = await liquidBalance(client);
  const rate = await everydaySpendRate(90, client);
  const income = await expectedIncomeCents(client);

  const today = iso(new Date());
  const end = iso(new Date(Date.now() + days * DAY_MS));

  // Paydays in the window, from the configured cycle.
  const paydays = cycle
    ? periodsBetween(cycle.cadence, cycle.anchor_date, today, end)
        .map((period) => period.starts_on)
        .filter((date) => date >= today && date <= end)
    : [];

  const commitments = await upcomingCommitments(today, end, client);

  // Bucket everything by date so one pass builds the curve.
  const eventsByDate = new Map();
  const push = (date, event) => {
    if (!eventsByDate.has(date)) eventsByDate.set(date, []);
    eventsByDate.get(date).push(event);
  };
  for (const date of paydays) push(date, { kind: 'income', label: 'Pay', amount_cents: income.cents });
  for (const commitment of commitments) {
    push(commitment.date, {
      kind: 'commitment',
      label: commitment.label,
      amount_cents: toCents(commitment.amount),
    });
  }

  const bufferCents = toCents(buffer);
  let balanceCents = opening.total_cents;
  const series = [];
  let runwayDate = null;
  let lowest = { date: today, cents: balanceCents };

  for (let day = 0; day <= days; day++) {
    const date = iso(new Date(Date.now() + day * DAY_MS));
    const events = eventsByDate.get(date) ?? [];

    // Day zero is today's actual balance, so nothing is applied to it.
    if (day > 0) {
      for (const event of events) balanceCents += event.amount_cents;
      balanceCents -= rate.per_day_cents;
    }

    if (balanceCents < lowest.cents) lowest = { date, cents: balanceCents };
    if (runwayDate === null && day > 0 && balanceCents < bufferCents) runwayDate = date;

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
    expected_income: { amount: fromCents(income.cents), source: income.source },
    cycle,
    paydays,
    runway_date: runwayDate,
    runway_days: runwayDate ? Math.round((toDate(runwayDate).getTime() - toDate(today).getTime()) / DAY_MS) : null,
    buffer: fromCents(bufferCents),
    lowest_balance: fromCents(lowest.cents),
    lowest_date: lowest.date,
    closing_balance: fromCents(balanceCents),
    series,
    upcoming: [...commitments]
      .slice(0, 40)
      .map((commitment) => ({ ...commitment, amount: String(commitment.amount) })),
  };
}
