// One description of what the household costs.
//
// Forecast, Today and Lasting used to load and classify the same transactions
// independently. The copies disagreed about irregular costs and merchant
// overrides, so each page projected a different household. This module does the
// database work once and returns a model the projection and every presentation
// can share.
import { query } from './db.js';
import { numericToCents, centsToNumeric } from './money.js';
import { today as householdToday } from './dates.js';
import { matchKeyFor } from './commitments.js';

const DAY_MS = 86_400_000;
const toCents = (value) => numericToCents(value ?? 0);
const fromCents = centsToNumeric;
const perMonth = (cents, days) => Math.round((cents * 3044) / (days * 100));

function allowanceFrom(value) {
  try {
    return Math.max(toCents(value ?? '0'), 0);
  } catch {
    return 0;
  }
}

// How many days a window of this length actually has history for.
//
// A rate is what left divided by the time it left over, and on a database
// younger than the window those are not the same number. Dividing by the days
// asked for rather than the days covered understates the rate badly: 75 days of
// spending divided by a 120 day window reads a third low, and every page that
// does it disagrees with every page that does not.
//
// One definition, for the same reason matchKeyFor has one. Every page that
// turns a windowed total into a per month figure divides by this.
export function coveredDays(earliest, window) {
  if (!Number.isInteger(window) || window < 1) {
    throw new TypeError('window must be a positive integer');
  }
  const covered = earliest
    ? Math.round(
        (Date.parse(`${householdToday()}T00:00:00Z`) -
          Date.parse(`${String(earliest).slice(0, 10)}T00:00:00Z`)) /
          DAY_MS,
      ) + 1
    : window;
  return Math.max(Math.min(window, covered), 1);
}

// The same figure, read straight from the database. For the pages that want the
// divisor without loading a whole cost model.
export async function effectiveWindowDays(window, client = { query }) {
  const { rows: [row] } = await client.query(
    'select min(txn_date) as earliest from budget_flows where counts and amount < 0',
  );
  return coveredDays(row?.earliest, window);
}

export async function buildCostModel({ window, client = { query } } = {}) {
  if (!Number.isInteger(window) || window < 1) {
    throw new TypeError('cost model window must be a positive integer');
  }

  const { rows: commitmentRows } = await client.query(
    `select c.id, c.match_key, c.label, c.typical_amount, c.cadence_days, c.next_due,
            c.annual, cat.name as category, coalesce(grp.name, cat.name) as group_name,
            round(-c.typical_amount * 30.44 / nullif(c.cadence_days, 0), 2) as per_month,
            cat.lean_tier as category_tier
       from commitments c
       left join categories cat on cat.id = c.category_id
       left join categories grp on grp.id = cat.parent_id
      where c.active and c.cadence_days > 0
      order by -c.typical_amount * 30.44 / c.cadence_days desc`,
  );

  // A merchant can produce more than one statement label. Map every observed
  // label through matchKeyFor so each commitment finds the merchant judgement
  // without pretending merchant_key and match_key are interchangeable.
  const { rows: merchantLabels } = await client.query(
    `select m.match_key as merchant_key, m.display_name, m.what_it_is,
            m.lean_tier,
            coalesce(t.display_description, t.description) as label,
            max(t.txn_date) as last_seen
       from merchants m
       join budget_flows t on t.merchant_key = m.match_key
      group by m.match_key, m.display_name, m.what_it_is, m.lean_tier,
               coalesce(t.display_description, t.description)
      order by max(t.txn_date) desc`,
  );
  const merchantByCommitmentKey = new Map();
  for (const row of merchantLabels) {
    const key = matchKeyFor(row.label);
    if (key && !merchantByCommitmentKey.has(key)) {
      merchantByCommitmentKey.set(key, row);
    }
  }

  const { rows: debtLabels } = await client.query(
    `select distinct coalesce(display_description, description) as label
       from budget_flows
      where counts and amount < 0 and to_own_debt`,
  );
  const debtKeys = new Set(debtLabels.map((row) => matchKeyFor(row.label)).filter(Boolean));

  const commitments = commitmentRows.map((row) => {
    const merchant = merchantByCommitmentKey.get(row.match_key);
    const tier = debtKeys.has(row.match_key)
      ? 'keep'
      : merchant?.lean_tier ?? row.category_tier ?? 'cut';
    return {
      id: row.id,
      commitment_id: row.id,
      match_key: row.match_key,
      label: row.label,
      name: merchant?.display_name ?? row.label,
      typical_amount: row.typical_amount,
      cadence_days: row.cadence_days,
      next_due: row.next_due,
      annual: row.annual,
      category: row.category,
      group: row.group_name,
      tier,
      is_debt: debtKeys.has(row.match_key),
      what_it_is: merchant?.what_it_is ?? null,
      per_month_cents: toCents(row.per_month),
      per_month: row.per_month,
    };
  });
  const commitmentKeys = new Set(commitments.map((row) => row.match_key));

  const { rows } = await client.query(
    `select t.amount, t.txn_date, t.merchant_key, t.to_own_debt,
            coalesce(t.display_description, t.description) as label,
            coalesce(m.display_name, t.merchant_key, 'Not described by the bank') as name,
            coalesce(m.lean_tier, cat.lean_tier, 'cut') as tier,
            coalesce(cat.name, 'Uncategorised') as category
       from budget_flows t
       left join merchants m on m.match_key = t.merchant_key
       left join categories cat on cat.id = t.category_id
      where t.counts and t.amount < 0
        and not t.one_off and not t.no_longer_expected
        and t.txn_date > current_date - $1::integer
        and t.txn_date <= current_date`,
    [window],
  );

  const variableRows = [];
  let totalCents = 0;
  let committedCents = 0;
  for (const row of rows) {
    const cents = -toCents(row.amount);
    totalCents += cents;
    if (commitmentKeys.has(matchKeyFor(row.label))) {
      committedCents += cents;
      continue;
    }
    variableRows.push({
      ...row,
      cents,
      place: row.merchant_key || matchKeyFor(row.label) || row.label,
      tier: row.to_own_debt ? 'keep' : row.tier,
    });
  }

  const datesByPlace = new Map();
  for (const row of variableRows) {
    if (!datesByPlace.has(row.place)) datesByPlace.set(row.place, new Set());
    datesByPlace.get(row.place).add(String(row.txn_date));
  }

  const { rows: [context] } = await client.query(
    `select min(txn_date) as earliest,
            (select value from settings where key = 'forecast_discretionary_monthly') as allowance
       from budget_flows
      where counts and amount < 0`,
  );
  const effectiveDays = coveredDays(context.earliest, window);

  const grouped = new Map();
  let essentialCents = 0;
  let recurringEssentialCents = 0;
  let irregularEssentialCents = 0;
  let irregularEssentialTransactions = 0;
  let discretionaryCents = 0;
  for (const row of variableRows) {
    const recurring = datesByPlace.get(row.place).size >= 3;
    if (row.tier === 'cut') {
      discretionaryCents += row.cents;
    } else {
      essentialCents += row.cents;
      if (recurring) recurringEssentialCents += row.cents;
      else {
        irregularEssentialCents += row.cents;
        irregularEssentialTransactions++;
      }
    }

    const groupKey = `${row.place}\u0000${row.tier}`;
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, {
        key: row.place,
        name: row.name,
        category: row.category,
        tier: row.tier,
        is_debt: row.to_own_debt,
        recurring,
        days_paid: datesByPlace.get(row.place).size,
        cents: 0,
      });
    }
    grouped.get(groupKey).cents += row.cents;
    grouped.get(groupKey).is_debt ||= row.to_own_debt;
  }

  const { rows: [excluded] } = await client.query(
    `select coalesce(sum(-t.amount), 0) as total, count(*)::int as transactions
       from budget_flows t
      where t.counts and t.amount < 0 and (t.one_off or t.no_longer_expected)
        and t.txn_date > current_date - $1::integer
        and t.txn_date <= current_date`,
    [window],
  );

  const everydayCents = essentialCents + discretionaryCents;
  const rate = {
    days: window,
    effective_days: effectiveDays,
    total: fromCents(totalCents),
    committed: fromCents(committedCents),
    everyday: fromCents(everydayCents),
    not_expected_again: excluded.total,
    not_expected_again_transactions: excluded.transactions,
    per_day_cents: Math.round(everydayCents / effectiveDays),
    per_day: fromCents(Math.round(everydayCents / effectiveDays)),
    essential: fromCents(essentialCents),
    essential_per_day_cents: Math.round(essentialCents / effectiveDays),
    essential_per_day: fromCents(Math.round(essentialCents / effectiveDays)),
    recurring_essential: fromCents(recurringEssentialCents),
    recurring_essential_per_day_cents: Math.round(recurringEssentialCents / effectiveDays),
    recurring_essential_per_day: fromCents(
      Math.round(recurringEssentialCents / effectiveDays),
    ),
    irregular_essential: fromCents(irregularEssentialCents),
    irregular_essential_transactions: irregularEssentialTransactions,
    discretionary: fromCents(discretionaryCents),
    discretionary_per_day_cents: Math.round(discretionaryCents / effectiveDays),
    discretionary_per_day: fromCents(Math.round(discretionaryCents / effectiveDays)),
  };

  const variable = [...grouped.values()]
    .map((row) => {
      const monthlyCents = perMonth(row.cents, effectiveDays);
      return {
        ...row,
        per_month_cents: monthlyCents,
        per_month: fromCents(monthlyCents),
      };
    })
    .sort((a, b) => b.per_month_cents - a.per_month_cents);

  return {
    window,
    effective_days: effectiveDays,
    discretionary_allowance_cents: allowanceFrom(context.allowance),
    rate,
    commitments,
    variable,
    debt_keys: debtKeys,
    historical_discretionary_per_month_cents: perMonth(
      discretionaryCents,
      effectiveDays,
    ),
  };
}
