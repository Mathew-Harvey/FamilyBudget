// Stage 3: pay periods and zero based buckets.
//
// Money arrives on a cycle. Each period, every dollar of income is given a job
// by putting it in a bucket. A bucket's balance for a period is what carried in,
// plus what was allocated, minus what was spent from it.
//
// Transfers between our own accounts are never income and never spending. They
// are excluded everywhere in here.
import { query, withTransaction } from './db.js';
import { normaliseDescription } from './matching.js';

const DAY_MS = 86_400_000;

export const CADENCES = ['weekly', 'fortnightly', 'monthly'];

const toDate = (value) => (value instanceof Date ? value : new Date(`${String(value).slice(0, 10)}T00:00:00Z`));
const iso = (date) => date.toISOString().slice(0, 10);
const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);

// Walks the cycle forward from the anchor, giving [start, end] for each period.
// Monthly keeps the anchor's day of month, clamped for short months.
export function periodsBetween(cadence, anchorDate, from, to) {
  const anchor = toDate(anchorDate);
  const first = toDate(from);
  const last = toDate(to);
  const periods = [];

  if (cadence === 'monthly') {
    const day = anchor.getUTCDate();
    // Step back to the first period boundary on or before `from`.
    let cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
    const startOfMonth = (d) => {
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Math.min(day, lastDay)));
    };
    let start = startOfMonth(cursor);
    if (start > first) {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - 1, 1));
      start = startOfMonth(cursor);
    }
    while (start <= last) {
      const nextMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      const next = startOfMonth(nextMonth);
      periods.push({ starts_on: iso(start), ends_on: iso(addDays(next, -1)) });
      start = next;
    }
    return periods;
  }

  const length = cadence === 'weekly' ? 7 : 14;
  // Align to the anchor so periods land on the same weekday every time.
  const stepsFromAnchor = Math.floor((first.getTime() - anchor.getTime()) / (length * DAY_MS));
  let start = addDays(anchor, stepsFromAnchor * length);
  while (start <= last) {
    periods.push({ starts_on: iso(start), ends_on: iso(addDays(start, length - 1)) });
    start = addDays(start, length);
  }
  return periods;
}

export async function getPayCycle(client = { query }) {
  const { rows } = await client.query(
    'select cadence, anchor_date, expected_income, updated_at from pay_cycle where id',
  );
  if (!rows.length) return null;
  return { ...rows[0], anchor_date: String(rows[0].anchor_date).slice(0, 10) };
}

export async function setPayCycle(cadence, anchorDate, expectedIncome = null, client = { query }) {
  if (!CADENCES.includes(cadence)) throw new Error(`cadence must be one of ${CADENCES.join(', ')}`);
  const { rows } = await client.query(
    `insert into pay_cycle (id, cadence, anchor_date, expected_income) values (true, $1, $2, $3)
     on conflict (id) do update set cadence         = excluded.cadence,
                                    anchor_date     = excluded.anchor_date,
                                    expected_income = excluded.expected_income,
                                    updated_at      = now()
     returning cadence, anchor_date, expected_income`,
    [cadence, anchorDate, expectedIncome],
  );
  return rows[0];
}

// Makes sure a pay_periods row exists for every period covering our
// transactions, and a year ahead for the forecast in Stage 4.
export async function ensurePayPeriods(options = {}) {
  const run = async (client) => {
    const cycle = await getPayCycle(client);
    if (!cycle) return 0;

    const { rows } = await client.query('select min(txn_date) as earliest from transactions');
    const earliest = rows[0].earliest ? String(rows[0].earliest).slice(0, 10) : cycle.anchor_date;
    const from = earliest < cycle.anchor_date ? earliest : cycle.anchor_date;
    const to = iso(addDays(new Date(), options.aheadDays ?? 400));

    const wanted = periodsBetween(cycle.cadence, cycle.anchor_date, from, to);
    let created = 0;
    for (const period of wanted) {
      const result = await client.query(
        `insert into pay_periods (starts_on, ends_on) values ($1, $2)
         on conflict (starts_on) do update set ends_on = excluded.ends_on
         returning (xmax = 0) as inserted`,
        [period.starts_on, period.ends_on],
      );
      if (result.rows[0].inserted) created++;
    }

    // Changing the cycle leaves periods from the old shape behind, and then two
    // periods contain today and the wrong one wins. Drop anything that is not
    // part of the current cycle. Allocations belong to a period shape that no
    // longer exists, so they go with it, and the count is reported rather than
    // being swallowed.
    const starts = wanted.map((period) => period.starts_on);
    const stale = await client.query(
      `select p.id,
              (select count(*) from bucket_allocations ba where ba.pay_period_id = p.id)::int as allocations
         from pay_periods p
        where p.starts_on between $1 and $2
          and p.starts_on <> all($3::date[])`,
      [from, to, starts],
    );
    const allocationsRemoved = stale.rows.reduce((total, row) => total + row.allocations, 0);
    if (stale.rows.length) {
      await client.query('delete from pay_periods where id = any($1::uuid[])', [stale.rows.map((r) => r.id)]);
    }

    return { created, removed: stale.rows.length, allocations_removed: allocationsRemoved };
  };

  if (options.client) return run(options.client);
  return withTransaction(run, options.pool);
}

// Income and spending for one period, from the taxonomy rather than from
// guessing at descriptions. Transfers never count either way.
const PERIOD_TOTALS_SQL = `
  select
    coalesce(sum(t.amount) filter (where c.kind = 'income'), 0)                as income,
    coalesce(sum(-t.amount) filter (where c.kind = 'expense'), 0)              as spent,
    coalesce(sum(-t.amount) filter (where c.kind is null and t.amount < 0), 0) as uncategorised_spend
  from budget_flows t
  left join categories c on c.id = t.category_id
  where t.counts
    and t.txn_date between $1 and $2
`;

export async function periodTotals(period, client = { query }) {
  const { rows } = await client.query(PERIOD_TOTALS_SQL, [period.starts_on, period.ends_on]);
  return rows[0];
}

// The full picture for one period: what came in, what each bucket holds, and
// how much income has not been given a job yet.
export async function periodState(periodId, client = { query }) {
  const periodResult = await client.query('select * from pay_periods where id = $1', [periodId]);
  if (!periodResult.rows.length) return null;
  const period = {
    ...periodResult.rows[0],
    starts_on: String(periodResult.rows[0].starts_on).slice(0, 10),
    ends_on: String(periodResult.rows[0].ends_on).slice(0, 10),
  };

  const totals = await periodTotals(period, client);

  // Spend per bucket in this period, and what each bucket carried in from
  // everything before it. Carry in is only counted for buckets that roll over.
  const { rows: buckets } = await client.query(
    `
    with spend as (
      select bc.bucket_id, coalesce(sum(-t.amount), 0) as spent
        from budget_flows t
        join bucket_categories bc on bc.category_id = t.category_id
       where t.counts and t.txn_date between $2 and $3
       group by bc.bucket_id
    ),
    -- A bucket's history starts the first time money was put in it. Spending
    -- from before that is not overspend, there was simply no budget yet, so it
    -- must not roll in as a huge negative balance.
    started as (
      select ba.bucket_id, min(p.starts_on) as first_period
        from bucket_allocations ba
        join pay_periods p on p.id = ba.pay_period_id
       group by ba.bucket_id
    ),
    prior_alloc as (
      select ba.bucket_id, coalesce(sum(ba.allocated), 0) as allocated
        from bucket_allocations ba
        join pay_periods p on p.id = ba.pay_period_id
       where p.starts_on < $2
       group by ba.bucket_id
    ),
    prior_spend as (
      select bc.bucket_id, coalesce(sum(-t.amount), 0) as spent
        from budget_flows t
        join bucket_categories bc on bc.category_id = t.category_id
        join started st on st.bucket_id = bc.bucket_id
       where t.counts
         and t.txn_date >= st.first_period
         and t.txn_date < $2
       group by bc.bucket_id
    )
    select b.id, b.name, b.notes, b.target, b.carry_over, b.sort_order, b.archived,
           coalesce(ba.allocated, 0)                                  as allocated,
           coalesce(s.spent, 0)                                       as spent,
           case when b.carry_over
                then coalesce(pa.allocated, 0) - coalesce(ps.spent, 0)
                else 0 end                                            as carried_in,
           -- What is actually left to spend. Kept in SQL so the arithmetic
           -- stays exact numeric rather than becoming a JavaScript float.
           case when b.carry_over
                then coalesce(pa.allocated, 0) - coalesce(ps.spent, 0)
                else 0 end
             + coalesce(ba.allocated, 0)
             - coalesce(s.spent, 0)                                   as remaining,
           (select count(*) from bucket_categories x where x.bucket_id = b.id)::int as category_count
      from buckets b
      left join bucket_allocations ba on ba.bucket_id = b.id and ba.pay_period_id = $1
      left join spend s on s.bucket_id = b.id
      left join prior_alloc pa on pa.bucket_id = b.id
      left join prior_spend ps on ps.bucket_id = b.id
     where not b.archived
     order by b.sort_order, b.name
    `,
    [periodId, period.starts_on, period.ends_on],
  );

  // Every figure below is added as a string through Postgres numeric, never as
  // a JavaScript float.
  const { rows: sums } = await client.query(
    `select coalesce(sum(allocated), 0) as total_allocated
       from bucket_allocations where pay_period_id = $1`,
    [periodId],
  );

  const { rows: unbucketed } = await client.query(
    `select coalesce(sum(-t.amount), 0) as spent
       from budget_flows t
       join categories c on c.id = t.category_id
       left join bucket_categories bc on bc.category_id = t.category_id
      where t.counts and c.kind = 'expense'
        and bc.bucket_id is null
        and t.txn_date between $1 and $2`,
    [period.starts_on, period.ends_on],
  );

  const { rows: toAllocate } = await client.query(
    `select ($1::numeric - $2::numeric) as to_allocate`,
    [totals.income, sums[0].total_allocated],
  );

  return {
    period,
    income: totals.income,
    spent: totals.spent,
    uncategorised_spend: totals.uncategorised_spend,
    total_allocated: sums[0].total_allocated,
    to_allocate: toAllocate[0].to_allocate,
    unbucketed_spend: unbucketed[0].spent,
    buckets,
  };
}

// Sets one bucket's allocation for a period.
export async function allocate(bucketId, periodId, amount, client = { query }) {
  const { rows } = await client.query(
    `insert into bucket_allocations (bucket_id, pay_period_id, allocated)
     values ($1, $2, $3)
     on conflict (bucket_id, pay_period_id)
       do update set allocated = excluded.allocated, updated_at = now()
     returning *`,
    [bucketId, periodId, amount],
  );
  return rows[0];
}

// Fills every bucket's allocation for a period with its target, for buckets
// that have no allocation yet. This is the "start of period" action.
export async function applyTargets(periodId, client = { query }) {
  const { rowCount } = await client.query(
    `insert into bucket_allocations (bucket_id, pay_period_id, allocated)
     select b.id, $1, b.target
       from buckets b
      where not b.archived
     on conflict (bucket_id, pay_period_id) do nothing`,
    [periodId],
  );
  return rowCount;
}

// Which period a date falls in.
export async function periodForDate(date, client = { query }) {
  const { rows } = await client.query(
    'select * from pay_periods where $1::date between starts_on and ends_on',
    [date],
  );
  return rows[0] ?? null;
}

export async function currentPeriod(client = { query }) {
  return periodForDate(new Date().toISOString().slice(0, 10), client);
}

// Suggests a pay cycle by looking at what income actually did. Used to fill in
// the setup form rather than making someone work it out.
//
// Not every credit is a payday: refunds, gifts and one off reimbursements are
// all income. So this looks for recurring streams, a description that shows up
// again and again for a similar amount, and derives the cadence from when those
// landed. Two fortnightly salaries a week apart correctly come out as weekly,
// because that is how often money actually arrives.
export async function suggestPayCycle(client = { query }) {
  const { rows } = await client.query(
    `select t.txn_date, t.amount, coalesce(t.display_description, t.description) as label
       from budget_flows t
       join categories c on c.id = t.category_id
      where c.kind = 'income' and t.counts and t.amount > 0
        and t.txn_date >= current_date - 240
      order by t.txn_date desc`,
  );
  if (rows.length < 3) return null;

  // Group by the first few words, which is stable across pay runs even when the
  // bank appends a reference.
  const streams = new Map();
  for (const row of rows) {
    const key = normaliseDescription(row.label).split(' ').slice(0, 3).join(' ');
    if (!streams.has(key)) streams.set(key, []);
    streams.get(key).push({ date: String(row.txn_date).slice(0, 10), amount: Number(row.amount) });
  }

  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  // A stream is a payday source when it recurs at least three times.
  const recurring = [...streams.entries()]
    .filter(([, entries]) => entries.length >= 3)
    .map(([key, entries]) => ({ key, entries, median: median(entries.map((e) => e.amount)) }));
  if (!recurring.length) return null;

  // Drop the small stuff. A stream worth a quarter of the biggest one is a
  // second salary, one worth a fiftieth is a recurring refund.
  const biggest = Math.max(...recurring.map((s) => s.median));
  const salaries = recurring.filter((s) => s.median >= biggest * 0.25);

  const dates = [...new Set(salaries.flatMap((s) => s.entries.map((e) => e.date)))].sort().reverse();
  if (dates.length < 2) return null;

  const gaps = [];
  for (let i = 0; i < dates.length - 1; i++) {
    gaps.push(Math.round((toDate(dates[i]).getTime() - toDate(dates[i + 1]).getTime()) / DAY_MS));
  }

  const counts = new Map();
  for (const gap of gaps) counts.set(gap, (counts.get(gap) ?? 0) + 1);
  const [commonest] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];

  let cadence = 'fortnightly';
  if (commonest <= 8) cadence = 'weekly';
  else if (commonest >= 26) cadence = 'monthly';

  return {
    cadence,
    anchor_date: dates[0],
    observed_gap_days: commonest,
    recent_paydays: dates.slice(0, 8),
    streams: salaries.map((s) => ({ label: s.key, count: s.entries.length, typical_amount: s.median })),
  };
}
