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
import { forecast, buildForecastContext, DEFAULT_SPEND_WINDOW_DAYS } from './forecast.js';
import { numericToCents, centsToNumeric } from './money.js';
import { friendlyDate, position } from './behaviour.js';

const MONTH_DAYS = 30.44;
const toCents = (value) => numericToCents(value ?? 0);
const fromCents = centsToNumeric;

export async function trimPercent(client = { query }) {
  const { rows } = await client.query("select value from settings where key = 'lean_trim_percent'");
  const value = Number(rows[0]?.value);
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 90) : 30;
}

// The plan. Each step includes the ones before it, because that is how it would
// actually be lived.
export async function leanPlan({
  client = { query },
  window = DEFAULT_SPEND_WINDOW_DAYS,
  forecastContext = null,
} = {}) {
  const trim = await trimPercent(client);
  const context = forecastContext ?? await buildForecastContext({
    client,
    window,
  });
  const costs = context.costs;
  const { commitments, variable, debt_keys: debtKeys } = costs;
  const base = await forecast({ days: 400, window, client, forecastContext: context });

  const cutCommitments = commitments.filter((row) => row.tier === 'cut');
  const trimVariable = variable.filter(
    (row) => row.tier === 'trim' && row.recurring && !row.is_debt,
  );

  const sum = (rows) => rows.reduce((total, row) => total + row.per_month_cents, 0);
  const optionalCommitmentCents = sum(cutCommitments);
  const allowanceCents = costs.discretionary_allowance_cents;
  const optionalSavingCents = optionalCommitmentCents + allowanceCents;
  const trimSavingCents = Math.round((sum(trimVariable) * trim) / 100);
  const optionalIds = cutCommitments.map((row) => row.commitment_id);

  const steps = [];
  if (optionalSavingCents > 0) {
    steps.push({
      key: 'optional',
      title: 'Stop the optional costs',
      detail: 'The luxury allowance and active optional commitments. These are included until you choose otherwise.',
      removes: [
        ...(allowanceCents > 0
          ? [{ what: 'Discretionary allowance', per_month: fromCents(allowanceCents) }]
          : []),
        ...cutCommitments.map((row) => ({ what: row.name, per_month: row.per_month })),
      ],
      commitmentIds: optionalIds,
      allowanceCents: 0,
      spendAdjustmentCentsPerDay: 0,
      savesCents: optionalSavingCents,
    });
  }
  if (trimSavingCents > 0) {
    steps.push({
      key: 'trim',
      title: `Spend ${trim} percent less on flexible essentials`,
      detail: 'Food, fuel, pets and care stay in the plan, at a lower amount.',
      removes: trimVariable
        .slice(0, 8)
        .map((row) => ({
          what: row.name,
          per_month: fromCents(Math.round((row.per_month_cents * trim) / 100)),
          from: row.per_month,
        })),
      removesMore: Math.max(trimVariable.length - 8, 0),
      commitmentIds: optionalIds,
      allowanceCents: 0,
      spendAdjustmentCentsPerDay: Math.round(trimSavingCents / MONTH_DAYS),
      savesCents: optionalSavingCents + trimSavingCents,
    });
  }

  // The gap this has to close comes from the same loaded model and projection.
  const here = await position({
    client,
    window,
    forecastContext: context,
    projection: base,
  });
  const gapCents = toCents(here.gap_per_month);

  // Each step re-projected. Commitments are excluded by id; variable spending
  // comes off the daily rate. Never both for the same money.
  const projected = [];
  for (const step of steps) {
    const view = await forecast({
      days: 400,
      window,
      client,
      forecastContext: context,
      discretionaryCentsPerMonth: step.allowanceCents,
      excludeCommitmentIds: step.commitmentIds,
      spendAdjustmentCentsPerDay: step.spendAdjustmentCentsPerDay,
    });
    const savedCents = step.savesCents;
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
  const floorSavedCents = steps.at(-1)?.savesCents ?? 0;
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
        .filter((row) => row.tier !== 'cut' && !debtKeys.has(row.match_key))
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

// What selling something buys, in days. Reusing the projection rather than
// dividing the balance by the gap, because the projection knows where the
// paydays fall and a closed form does not.
export async function assetLevers({
  client = { query },
  window = DEFAULT_SPEND_WINDOW_DAYS,
  forecastContext = null,
} = {}) {
  const { rows } = await client.query(
    'select id, name, estimated_value from assets where sellable and sold_on is null order by estimated_value desc',
  );
  if (!rows.length) return [];

  const context = forecastContext ?? await buildForecastContext({
    window,
    client,
  });
  const base = await forecast({ days: 400, window, client, forecastContext: context });
  const out = [];
  let runningCents = 0;
  for (const asset of rows) {
    runningCents += toCents(asset.estimated_value);
    const view = await forecast({
      days: 400,
      window,
      client,
      forecastContext: context,
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
