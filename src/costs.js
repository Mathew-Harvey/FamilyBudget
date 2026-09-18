// One description of what the household costs.
//
// Forecast, Today and Lasting used to load and classify the same transactions
// independently. The copies disagreed about irregular costs and merchant
// overrides, so each page projected a different household. This module does the
// database work once and returns a model the projection and every presentation
// can share.
import { query } from './db.js';
import { numericToCents, centsToNumeric, centsPerMonth, apportion } from './money.js';
import { today as householdToday } from './dates.js';
import { matchKeyFor } from './commitments.js';

const DAY_MS = 86_400_000;
const toCents = (value) => numericToCents(value ?? 0);
const fromCents = centsToNumeric;

// The stored allowance, or null when nobody has chosen one.
//
// A missing row and an unreadable one are the same answer: no decision. That
// matters because the decision and the number zero used to be the same thing.
// The setting was seeded at 0.00, so a household that had never opened the
// page was forecast as spending nothing at all on anything optional, which on
// this one hid 3,825 a month. Nobody chose that and nobody could see it.
function storedAllowance(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  try {
    return Math.max(toCents(value), 0);
  } catch {
    return null;
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

// How hard a cost would be to stop, in SQL.
//
// The merchant beats the category, because a category is too blunt to decide
// with: this household's "Services" holds health cover and drone parts. Nothing
// paying down our own debt is ever optional, whatever its category says. One
// definition, because a page that grouped by its own copy of this would put a
// merchant in a different tier from the one the plan uses.
export const TIER_SQL = `
  case when t.to_own_debt then 'keep'
       else coalesce(m.lean_tier, cat.lean_tier, 'cut') end`;

// What each tier cost over the window, on the same filter the Spending page
// totals use, so they add up to the figure above them.
//
// Four buckets here, not three. TIER_SQL sends anything with no judgement on it
// to 'cut', which is the right default for a projection: it counts unassessed
// spending as optional, which shortens the runway rather than flattering it. It
// is the wrong thing to draw. On this household 13,051 of spending landed in
// 'cut' and 12,771 of that had simply never been categorised, so the page was
// reporting "52 percent is a choice" about money nobody had looked at. A
// default is not a finding, so the default gets its own name and its own mark.
export async function tierTotals({ window, client = { query } } = {}) {
  if (!Number.isInteger(window) || window < 1) {
    throw new TypeError('window must be a positive integer');
  }
  const { rows } = await client.query(
    // Cast to text: lean_tier is an enum and "unknown" is deliberately not one
    // of its values, because it is the absence of a tier rather than a fourth.
    `select case when t.to_own_debt then 'keep'
                 when m.lean_tier is not null then m.lean_tier::text
                 when cat.lean_tier is not null then cat.lean_tier::text
                 else 'unknown' end as tier,
            coalesce(sum(-t.amount), 0) as spent,
            count(*)::int as transactions
       from budget_flows t
       left join merchants m on m.match_key = t.merchant_key
       left join categories cat on cat.id = t.category_id
      where t.counts and t.amount < 0
        and (cat.kind is null or cat.kind = 'expense')
        and not t.one_off and not t.no_longer_expected
        and t.txn_date > current_date - $1::integer
        and t.txn_date <= current_date
      group by 1`,
    [window],
  );
  const by = new Map(rows.map((row) => [row.tier, row]));
  return ['keep', 'trim', 'cut', 'unknown'].map((tier) => ({
    tier,
    spent: by.get(tier)?.spent ?? '0',
    transactions: by.get(tier)?.transactions ?? 0,
  }));
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
    // Where the tier came from, not just what it is. 'cut' is the default when
    // nothing has judged this merchant or its category, and a default is not a
    // finding: the plan was offering to cancel things nobody had ever looked at,
    // which is the same mistake the Spending page was making in a diagram.
    const assessed = debtKeys.has(row.match_key) ? 'debt'
      : merchant?.lean_tier ? 'merchant'
      : row.category_tier ? 'category'
      : 'default';
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
      tier_source: assessed,
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
            coalesce(m.lean_tier, cat.lean_tier, 'cut') as tier,  -- see TIER_SQL
            (m.lean_tier is null and cat.lean_tier is null) as tier_defaulted,
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
      tier_source: row.to_own_debt ? 'debt' : (row.tier_defaulted ? 'default' : 'set'),
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
        tier_source: row.tier_source,
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
    irregular_essential_per_day_cents: Math.round(irregularEssentialCents / effectiveDays),
    irregular_essential_per_day: fromCents(
      Math.round(irregularEssentialCents / effectiveDays),
    ),
    discretionary: fromCents(discretionaryCents),
    discretionary_per_day_cents: Math.round(discretionaryCents / effectiveDays),
    discretionary_per_day: fromCents(Math.round(discretionaryCents / effectiveDays)),
  };

  const variable = [...grouped.values()]
    .map((row) => {
      const monthlyCents = centsPerMonth(row.cents, effectiveDays);
      return {
        ...row,
        per_month_cents: monthlyCents,
        per_month: fromCents(monthlyCents),
      };
    })
    .sort((a, b) => b.per_month_cents - a.per_month_cents);

  const historicalDiscretionaryCents = centsPerMonth(discretionaryCents, effectiveDays);
  // Until someone chooses, the plan assumes the household it can see.
  //
  // History is the suggestion and the figure someone sets always wins, which is
  // how the pay cycle already works and for the same reason: only a person
  // knows whether last quarter is a guide to next one. What changed is the
  // answer when nobody has said. Zero was never anybody's intention, and a
  // forecast built on it describes a household that buys no coffee, no haircut
  // and no present, then reports the resulting surplus as though it were money.
  const chosenCents = storedAllowance(context.allowance);

  return {
    window,
    effective_days: effectiveDays,
    earliest_transaction: context.earliest ? String(context.earliest).slice(0, 10) : null,
    discretionary_allowance_cents: chosenCents ?? historicalDiscretionaryCents,
    // Whether that figure is a decision or the default standing in for one. The
    // plan is the same either way; the pages that ask for the decision need to
    // know which they are looking at.
    discretionary_allowance_chosen: chosenCents !== null,
    rate,
    commitments,
    // The ones a scenario is allowed to turn off. Three pages were each
    // filtering on the tier themselves, which is three places to disagree about
    // what "optional" means. This module owns classification, so it owns this.
    optional_commitments: commitments.filter(
      (row) => row.tier === 'cut' && row.tier_source !== 'default',
    ),
    // Cut only because nothing has said otherwise. Named so a page can ask
    // rather than assume, never offered as a saving.
    unjudged_commitments: commitments.filter(
      (row) => row.tier === 'cut' && row.tier_source === 'default',
    ),
    variable,
    debt_keys: debtKeys,
    historical_discretionary_per_month_cents: historicalDiscretionaryCents,
  };
}

// What optional day to day spending actually came to, month by month.
//
// The allowance is one number, and one number cannot say whether 3,200 a month
// is what every month looks like or the average of a quiet one and a bad one.
// That is the difference between a figure someone can argue with and a figure
// they can only accept, and this is the one screen in the app that asks for a
// decision rather than reporting one.
//
// Same filter and the same commitment exclusion as the rate above, with the
// commitment keys taken from a model that has already been built rather than
// worked out again. Two definitions of "optional" would put a chart under a
// number that disagreed with it.
export async function optionalByMonth(costs, { months = 12, client = { query } } = {}) {
  if (!Number.isInteger(months) || months < 1) {
    throw new TypeError('months must be a positive integer');
  }
  const { rows } = await client.query(
    `select to_char(t.txn_date, 'YYYY-MM') as month,
            coalesce(t.display_description, t.description) as label,
            -t.amount as spent
       from budget_flows t
       left join merchants m on m.match_key = t.merchant_key
       left join categories cat on cat.id = t.category_id
      where t.counts and t.amount < 0
        and not t.one_off and not t.no_longer_expected
        and (${TIER_SQL}) = 'cut'
        and t.txn_date >= (date_trunc('month', current_date)
                            - make_interval(months => $1::integer - 1))::date
        and t.txn_date <= current_date`,
    [months],
  );

  const commitmentKeys = new Set(costs.commitments.map((row) => row.match_key));
  const totals = new Map();
  for (const row of rows) {
    if (commitmentKeys.has(matchKeyFor(row.label))) continue;
    totals.set(row.month, (totals.get(row.month) ?? 0) + toCents(row.spent));
  }

  // Every month in the span, including the ones nothing was spent in, because a
  // chart that silently drops a month is a chart that lies about the trend.
  const thisMonth = householdToday().slice(0, 7);
  const firstMonth = costs.earliest_transaction?.slice(0, 7) ?? null;
  const out = [];
  let [year, month] = thisMonth.split('-').map(Number);
  for (let back = 0; back < months; back++) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    out.unshift({
      month: key,
      spent: fromCents(totals.get(key) ?? 0),
      spent_cents: totals.get(key) ?? 0,
      // A month is only comparable to another month if it is a whole one. The
      // current month is always part way through, and the earliest is whenever
      // the bank's history happens to start, so neither can be held up as
      // evidence of a quiet month.
      complete: key !== thisMonth && (firstMonth === null || key > firstMonth),
    });
    month--;
    if (month === 0) { month = 12; year--; }
  }
  return out;
}

// How many places the breakdown names before it starts counting them instead.
// Twelve is enough to recognise where the money goes and short enough to read;
// the Spending page ranks all of them and is one link away.
const NAMED_PLACES = 12;

// What the allowance is actually made of.
//
// "Everything else optional, day to day" is the largest optional figure in the
// app and the only one with nothing underneath it. It is not a category anybody
// chose. It is the residue: what is left of the money out of a spendable
// account after the transfers, the refunds, the one offs, the repeating costs
// and everything judged must pay or could trim have been taken out of it. The
// caption says takeaway and clothes, and some of it is, but TIER_SQL sends
// whatever nothing has judged to 'cut', so every place nobody has ever looked
// at lands in that figure silently and reads as a decision somebody made.
//
// This app has refused that default twice already: tierTotals gives it a fourth
// bucket rather than drawing it as a finding, and the plan will not offer to
// cancel a repeating cost nobody has judged. The allowance is the third and
// much the largest instance, so the split is named here, once, rather than left
// to each page to work out or to leave out.
//
// Pure. Every figure comes from the model that has already been built, so there
// is no second definition of optional, no second query, and nothing here can
// drift from the number it is explaining.
export function optionalBreakdown(costs) {
  const historyCents = costs.historical_discretionary_per_month_cents;
  const inForceCents = costs.discretionary_allowance_cents;

  const places = costs.variable
    .filter((row) => row.tier === 'cut')
    .sort((a, b) => b.cents - a.cents);

  // A share of one total, never a second measurement of it. Turning each place
  // into its own monthly rate and heading the list with a separate conversion
  // of the whole leaves rows that do not add up to the number above them.
  //
  // The cost of that is a place here can read a cent under what the Spending
  // page reports for the same place over the same window, because that page is
  // making its own claim about that merchant and this one is making a claim
  // about a part of the allowance. A cent is the smallest difference there is
  // and only somebody comparing two pages side by side will ever see it;
  // eight rows that visibly fail to add up to the figure they are a breakdown
  // of is wrong at a glance, on the page whose whole job is to be checkable.
  // Do not "fix" this by rating each place on its own.
  const shares = apportion(historyCents, places.map((row) => row.cents));

  let judgedCents = 0;
  let judgedPlaces = 0;
  let unjudgedCents = 0;
  let unjudgedPlaces = 0;
  const rows = places.map((row, index) => {
    const cents = shares[index];
    // 'cut' with nothing behind it is the default, and a default is not a
    // judgement. tier_source is 'debt' only where the tier was forced to keep,
    // so here it is one or the other.
    const judged = row.tier_source !== 'default';
    if (judged) { judgedCents += cents; judgedPlaces++; } else { unjudgedCents += cents; unjudgedPlaces++; }
    return {
      key: row.key,
      name: row.name,
      category: row.category,
      judged,
      days_paid: row.days_paid,
      per_month_cents: cents,
      per_month: fromCents(cents),
    };
  });

  const named = rows.slice(0, NAMED_PLACES);
  const tail = rows.slice(NAMED_PLACES);

  return {
    // The days a rate divides by, not the days it asked for. See coveredDays:
    // on a database younger than the window the two differ, and the page says
    // this number out loud.
    effective_days: costs.effective_days,
    // What optional day to day spending has actually been running at. The rows
    // below add up to exactly this.
    per_month: fromCents(historyCents),
    per_month_cents: historyCents,
    // What the plan is carrying, which is this unless somebody chose otherwise.
    in_force_per_month: fromCents(inForceCents),
    chosen: costs.discretionary_allowance_chosen,
    // The two ways a chosen figure can differ from the life behind it, each as
    // its own non negative number so no page has to read a minus sign to know
    // which way round it is. The first is the one that matters: money that has
    // been going out and that the projection is not carrying.
    not_in_the_plan_per_month: fromCents(Math.max(historyCents - inForceCents, 0)),
    above_history_per_month: fromCents(Math.max(inForceCents - historyCents, 0)),
    // The finding, and the reason this function exists.
    judged: { per_month: fromCents(judgedCents), places: judgedPlaces },
    unjudged: { per_month: fromCents(unjudgedCents), places: unjudgedPlaces },
    places: named,
    // Named rather than dropped, or the list quietly stops adding up to its
    // own heading at the twelfth row.
    rest: tail.length
      ? {
          places: tail.length,
          per_month: fromCents(tail.reduce((total, row) => total + row.per_month_cents, 0)),
        }
      : null,
  };
}
