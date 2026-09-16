// What it would take to last.
//
// The Today page answers "when does the money run out". This answers the
// question that follows, which is the one someone actually needs: what would
// have to go for it not to, and what does each thing buy.
//
// Three rules it holds to, all of them from docs/behaviour.md:
//
//   Name what goes. A plan that says "cut 2,000 a month" is not a plan, it is a
//   number. Every step here lists the actual things, by name and by amount, so
//   it can be argued with and then done.
//
//   Say when it is not enough. Cutting everything discretionary does not
//   necessarily close a gap this size, and a page that implied it did would be
//   doing real harm. If the floor is still short, the floor says so and says by
//   how much.
//
//   One lever per saving. Commitments leave the projection by being excluded
//   from it; variable spending leaves by reducing the daily rate. Those are
//   disjoint, because everydaySpendRate already subtracts commitments. Applying
//   both to the same money is how a 322 dollar subscription once bought 22 days
//   instead of 2.
import { query } from './db.js';
import { forecast, everydaySpendRate, DEFAULT_SPEND_WINDOW_DAYS } from './forecast.js';
import { matchKeyFor } from './commitments.js';
import { numericToCents, centsToNumeric } from './money.js';
import { friendlyDate } from './behaviour.js';

const MONTH_DAYS = 30.44;
const toCents = (value) => numericToCents(value ?? 0);
const fromCents = centsToNumeric;

export async function trimPercent(client = { query }) {
  const { rows } = await client.query("select value from settings where key = 'lean_trim_percent'");
  const value = Number(rows[0]?.value);
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 90) : 30;
}

// Everything that goes out, tiered, with commitments separated from variable
// spending because they are stopped in different ways.
export async function tieredCosts({ client = { query }, window = DEFAULT_SPEND_WINDOW_DAYS } = {}) {
  const rate = await everydaySpendRate(window, client);

  // The recurring costs, which are stopped by name.
  // Commitments, with their tier and their name resolved in JavaScript.
  //
  // Joining commitments.match_key to merchants.match_key in SQL is the drift
  // CLAUDE.md warns about and it bites here worse than anywhere: the join
  // failed for the health cover and for the personal loan repayment, both fell
  // through to the category default of "cut", and the plan opened by proposing
  // that the household cancel its health insurance and stop repaying a loan.
  const { rows: commitments } = await client.query(
    `select c.id, c.match_key, c.label, c.typical_amount, c.cadence_days,
            round(-c.typical_amount * 30.44 / nullif(c.cadence_days, 0), 2) as per_month,
            cat.lean_tier as category_tier
       from commitments c
       left join categories cat on cat.id = c.category_id
      where c.active and c.cadence_days > 0
      order by -c.typical_amount * 30.44 / c.cadence_days desc`,
  );

  // What each merchant is called and how it is tiered, keyed the way a
  // commitment is keyed, through the one definition.
  const { rows: merchantRows } = await client.query(
    `select m.match_key, m.display_name, m.lean_tier,
            (select coalesce(t.display_description, t.description)
               from budget_flows t where t.merchant_key = m.match_key limit 1) as sample_label
       from merchants m`,
  );
  const merchantByCommitmentKey = new Map();
  for (const row of merchantRows) {
    if (!row.sample_label) continue;
    const key = matchKeyFor(row.sample_label);
    if (key && !merchantByCommitmentKey.has(key)) merchantByCommitmentKey.set(key, row);
  }

  // Debt repayments are never a candidate for cutting, whatever anything else
  // says. to_own_debt is the column built for the question.
  const { rows: debtLabels } = await client.query(
    `select distinct coalesce(display_description, description) as label
       from budget_flows where counts and amount < 0 and to_own_debt`,
  );
  const debtKeys = new Set(debtLabels.map((row) => matchKeyFor(row.label)));

  // The variable spending, which is stopped by spending less. Grouped here
  // rather than in SQL so it can use the one match key definition to tell what
  // is already a commitment, the same reason everydaySpendRate does.
  const { rows: spend } = await client.query(
    `select coalesce(t.display_description, t.description) as label,
            t.amount, t.merchant_key,
            coalesce(m.display_name, t.merchant_key, 'Not described by the bank') as name,
            coalesce(m.lean_tier, cat.lean_tier) as tier,
            coalesce(cat.name, 'Uncategorised') as category
       from budget_flows t
       left join merchants m on m.match_key = t.merchant_key
       left join categories cat on cat.id = t.category_id
      where t.counts and t.amount < 0
        and not t.one_off and not t.no_longer_expected and not t.to_own_debt
        and t.txn_date > current_date - $1::integer
        and t.txn_date <= current_date`,
    [window],
  );

  const committedKeys = new Set(commitments.map((row) => row.match_key));
  const variable = new Map();
  for (const row of spend) {
    if (committedKeys.has(matchKeyFor(row.label))) continue;
    const key = row.merchant_key ?? row.name;
    if (!variable.has(key)) {
      // No tier anywhere means nobody has decided, and the safe default for an
      // unknown cost is that it is discretionary: the plan proposes stopping it
      // and a person says otherwise. Proposing to keep it would quietly make
      // the plan too easy.
      variable.set(key, { name: row.name, category: row.category, tier: row.tier ?? 'cut', cents: 0 });
    }
    variable.get(key).cents += -toCents(row.amount);
  }

  const perMonth = (cents) => Math.round((cents * MONTH_DAYS) / rate.effective_days);
  return {
    rate,
    debtKeys,
    commitments: commitments.map((row) => {
      const merchant = merchantByCommitmentKey.get(row.match_key);
      // A cost nobody has tiered is treated as discretionary, so the plan
      // proposes stopping it and a person says otherwise. Defaulting the other
      // way would quietly make the plan easier than it is.
      const tier = debtKeys.has(row.match_key)
        ? 'keep'
        : merchant?.lean_tier ?? row.category_tier ?? 'cut';
      return {
        commitment_id: row.id,
        // Carried through, because the kept list dedupes on it: without it the
        // mortgage appeared twice, once as the account it pays down and once as
        // the direct debit that pays it.
        match_key: row.match_key,
        name: merchant?.display_name ?? row.label,
        tier,
        per_month_cents: toCents(row.per_month),
        per_month: row.per_month,
      };
    }),
    variable: [...variable.values()]
      .map((row) => ({ ...row, per_month_cents: perMonth(row.cents), per_month: fromCents(perMonth(row.cents)) }))
      .filter((row) => row.per_month_cents > 0)
      .sort((a, b) => b.per_month_cents - a.per_month_cents),
  };
}

// The plan. Each step includes the ones before it, because that is how it would
// actually be lived.
export async function leanPlan({ client = { query }, window = DEFAULT_SPEND_WINDOW_DAYS } = {}) {
  const trim = await trimPercent(client);
  const { commitments, variable, debtKeys } = await tieredCosts({ client, window });

  const base = await forecast({ days: 400, window, client });

  const cutCommitments = commitments.filter((row) => row.tier === 'cut');
  // A merchant can bill a subscription AND charge on top of it: Cursor has a
  // monthly plan and separate usage lines. They are different charges and both
  // are really stopped, so the arithmetic is right, but the same name appearing
  // in two steps reads like a mistake. Say which is which.
  const committedNames = new Set(cutCommitments.map((row) => row.name));
  const cutVariable = variable.filter((row) => row.tier === 'cut');
  const trimVariable = variable.filter((row) => row.tier === 'trim');
  const trimCommitments = commitments.filter((row) => row.tier === 'trim');

  const sum = (rows) => rows.reduce((total, row) => total + row.per_month_cents, 0);

  const steps = [
    {
      key: 'extras',
      title: 'Stop the subscriptions and services you chose',
      detail: 'Recurring things you signed up for. Each one is a single decision, and it stays stopped.',
      removes: cutCommitments.map((row) => ({ what: row.name, per_month: row.per_month })),
      commitmentIds: cutCommitments.map((row) => row.commitment_id),
      extraMonthlyCents: 0,
    },
    {
      key: 'shopping',
      title: 'Stop the discretionary shopping',
      detail: 'The things bought as you go that are not food, fuel, cover or care. This is the hardest one to hold, because there is no single moment you decide it.',
      removes: cutVariable.slice(0, 12).map((row) => ({
        what: committedNames.has(row.name) ? `${row.name}, charged on top of the plan` : row.name,
        per_month: row.per_month,
      })),
      removesMore: Math.max(cutVariable.length - 12, 0),
      commitmentIds: cutCommitments.map((row) => row.commitment_id),
      extraMonthlyCents: sum(cutVariable),
    },
    {
      key: 'trim',
      title: `Spend ${trim} percent less on food, fuel and care`,
      detail: 'Not stopping these, spending less on them. A different shop, a smaller tank, generic where it does not matter.',
      removes: [...trimVariable, ...trimCommitments.map((row) => ({ name: row.name, per_month_cents: row.per_month_cents }))]
        .sort((a, b) => b.per_month_cents - a.per_month_cents)
        .slice(0, 8)
        .map((row) => ({
          what: row.name,
          per_month: fromCents(Math.round((row.per_month_cents * trim) / 100)),
          from: fromCents(row.per_month_cents),
        })),
      commitmentIds: cutCommitments.map((row) => row.commitment_id),
      extraMonthlyCents: sum(cutVariable)
        + Math.round(((sum(trimVariable) + sum(trimCommitments)) * trim) / 100),
    },
  ];

  // The gap this has to close, on the same basis the Today page reports it.
  const gapCents = toCents(await monthlyGap(client, window));

  // Each step re-projected. Commitments are excluded by id; variable spending
  // comes off the daily rate. Never both for the same money.
  const projected = [];
  for (const step of steps) {
    const view = await forecast({
      days: 400,
      window,
      client,
      excludeCommitmentIds: step.commitmentIds,
      spendAdjustmentCentsPerDay: Math.round(step.extraMonthlyCents / MONTH_DAYS),
    });
    const savedCents = sum(cutCommitments.filter((row) => step.commitmentIds.includes(row.commitment_id)))
      + step.extraMonthlyCents;
    // Lasting means the money coming in covers what is going out, not that the
    // projection happened to reach its last day without hitting zero. Saving
    // 5,689 against a gap of 6,883 runs out eventually and the first version of
    // this said "never runs out", because 400 days was not long enough to show
    // it. That is the overclaim docs/behaviour.md exists to prevent.
    const lasts = savedCents >= gapCents;
    projected.push({
      key: step.key,
      title: step.title,
      detail: step.detail,
      removes: step.removes,
      removes_more: step.removesMore ?? 0,
      saves_per_month: fromCents(savedCents),
      still_short_per_month: fromCents(Math.max(gapCents - savedCents, 0)),
      runway_date: view.runway_date,
      runway_date_friendly: friendlyDate(view.runway_date),
      runway_days: view.runway_days,
      // True only when it genuinely balances. When it does not but the
      // projection did not reach zero either, the page says "past" the horizon
      // rather than implying it is solved.
      lasts,
      beyond_horizon: !lasts && view.runway_date === null,
      horizon_date: view.series.at(-1).date,
      horizon_date_friendly: friendlyDate(view.series.at(-1).date),
    });
  }

  // What is left when every step is taken: the floor.
  const floorSavedCents = sum(cutCommitments) + steps[2].extraMonthlyCents;
  const stillShortCents = gapCents - floorSavedCents;

  return {
    window_days: window,
    trim_percent: trim,
    now: {
      runway_date: base.runway_date,
      runway_date_friendly: friendlyDate(base.runway_date),
      runway_days: base.runway_days,
      gap_per_month: fromCents(gapCents),
    },
    steps: projected,
    floor: {
      saves_per_month: fromCents(floorSavedCents),
      lasts: stillShortCents <= 0,
      still_short_per_month: fromCents(Math.max(stillShortCents, 0)),
    },
    // What the plan does not touch, said out loud: a page that only lists losses
    // reads as though everything is going.
    //
    // Debt servicing is in here whether or not detection happened to make a
    // commitment of it. It is the biggest thing the household keeps paying and
    // leaving it off because no commitment row exists would be the one omission
    // people would notice.
    kept: [
      ...(await debtServicing(client, window)),
      ...commitments
        .filter((row) => row.tier === 'keep' && !debtKeys.has(row.match_key))
        .map((row) => ({ what: row.name, per_month: row.per_month, per_month_cents: row.per_month_cents })),
    ]
      .sort((a, b) => b.per_month_cents - a.per_month_cents)
      .map((row) => ({ what: row.what, per_month: row.per_month })),
  };
}

// What is being paid to our own debts, per account, whether or not any of it
// became a commitment.
async function debtServicing(client, window) {
  const { debts } = await import('./behaviour.js');
  const rows = await debts({ client, window });
  return rows
    .filter((row) => row.regular && toCents(row.per_month) > 0)
    .map((row) => ({
      what: row.name,
      per_month: row.per_month,
      per_month_cents: toCents(row.per_month),
    }));
}

// The monthly gap, from the same basis the Today page uses.
async function monthlyGap(client, window) {
  const { position } = await import('./behaviour.js');
  const here = await position({ client, window });
  return here.gap_per_month;
}

// What selling something buys, in days. Reusing the projection rather than
// dividing the balance by the gap, because the projection knows where the
// paydays fall and a closed form does not.
export async function assetLevers({ client = { query }, window = DEFAULT_SPEND_WINDOW_DAYS } = {}) {
  const { rows } = await client.query(
    'select id, name, estimated_value from assets where sellable and sold_on is null order by estimated_value desc',
  );
  if (!rows.length) return [];

  const base = await forecast({ days: 400, window, client });
  const out = [];
  let runningCents = 0;
  for (const asset of rows) {
    runningCents += toCents(asset.estimated_value);
    const view = await forecast({
      days: 400,
      window,
      client,
      extraEvents: [{ date: base.generated_for, label: asset.name, amount: fromCents(runningCents), kind: 'scenario' }],
    });
    out.push({
      name: asset.name,
      worth: asset.estimated_value,
      // Cumulative: selling the second one only helps on top of the first.
      with_everything_above: fromCents(runningCents),
      runway_date: view.runway_date,
      runway_date_friendly: friendlyDate(view.runway_date),
      days_gained: view.runway_date && base.runway_date
        ? Math.round((Date.parse(`${view.runway_date}T00:00:00Z`) - Date.parse(`${base.runway_date}T00:00:00Z`)) / 86_400_000)
        : null,
    });
  }
  return out;
}
