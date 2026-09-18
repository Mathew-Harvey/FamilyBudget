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
import { optionalBreakdown } from './costs.js';
import { forecast, buildForecastContext, DEFAULT_SPEND_WINDOW_DAYS } from './forecast.js';
import { numericToCents, centsToNumeric, dailyFromMonthly } from './money.js';
import { friendlyDate, position, cashCurve, curveHorizon } from './behaviour.js';

const toCents = (value) => numericToCents(value ?? 0);
const fromCents = centsToNumeric;

export async function trimPercent(client = { query }) {
  const { rows } = await client.query("select value from settings where key = 'lean_trim_percent'");
  const value = Number(rows[0]?.value);
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 90) : 30;
}

// The plan. Each step includes the ones before it, because that is how it would
// actually be lived.
// choices is what the person has ticked on the page: which optional costs to
// stop, whether the allowance goes to zero, and the trim percent. Absent, the
// scenario is the whole plan. Present, it is exactly those, so the curve moves
// as the ticks do and nothing else on the page changes meaning.
export async function leanPlan({
  client = { query },
  window = DEFAULT_SPEND_WINDOW_DAYS,
  forecastContext = null,
  choices = null,
} = {}) {
  const trim = await trimPercent(client);
  const context = forecastContext ?? await buildForecastContext({
    client,
    window,
  });
  const costs = context.costs;
  const { commitments, variable, debt_keys: debtKeys } = costs;
  const base = await forecast({ days: 400, window, client, forecastContext: context });

  const cutCommitments = costs.optional_commitments;
  const trimVariable = variable.filter(
    (row) => row.tier === 'trim' && row.recurring && !row.is_debt,
  );

  const sum = (rows) => rows.reduce((total, row) => total + row.per_month_cents, 0);
  const optionalCommitmentCents = sum(cutCommitments);
  const allowanceCents = costs.discretionary_allowance_cents;
  const optionalSavingCents = optionalCommitmentCents + allowanceCents;
  // Rounded per row and then summed, not the other way round, so the figure
  // heading the card is exactly what the lines under it add up to. One rounding
  // of the total headed step two with 603.65 over four rows adding to 603.66,
  // which is a card that disagrees with itself by a cent.
  const trimRowCents = (row) => Math.round((row.per_month_cents * trim) / 100);
  const trimSavingCents = trimVariable.reduce((total, row) => total + trimRowCents(row), 0);
  const optionalIds = cutCommitments.map((row) => row.commitment_id);

  const steps = [];
  if (optionalSavingCents > 0) {
    steps.push({
      key: 'optional',
      title: 'Stop the optional costs',
      detail: 'The optional allowance and the subscriptions judged optional. These are included until you choose otherwise.',
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
      // The tier's own word. "Flexible essentials" was a fifth name for the
      // three tiers after the other four had just been reduced to one set.
      title: `Spend ${trim} percent less on what could be trimmed`,
      detail: 'Food, fuel, pets and care stay in the plan, at a lower amount.',
      removes: trimVariable
        .slice(0, 8)
        .map((row) => ({
          what: row.name,
          per_month: fromCents(trimRowCents(row)),
          from: row.per_month,
        })),
      removesMore: Math.max(trimVariable.length - 8, 0),
      commitmentIds: optionalIds,
      allowanceCents: 0,
      spendAdjustmentCentsPerDay: dailyFromMonthly(trimSavingCents),
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
  let floorView = null;
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
    // What this step adds on its own, as against everything up to and including
    // it. Each card lists the things that step removes and those sum to the
    // increment, so a card headed with the cumulative figure disagreed with its
    // own rows: step two was headed 1,123.92 over four lines adding to 603.66.
    const addedCents = savedCents - (projected.at(-1)?.saves_cents ?? 0);
    // Lasting means the money coming in covers what is going out, not that the
    // projection happened to reach its last day without hitting zero. Saving
    // 5,689 against a gap of 6,883 runs out eventually and the first version of
    // this said "never runs out", because 400 days was not long enough to show
    // it. That is the overclaim docs/behaviour.md exists to prevent.
    const lasts = savedCents >= gapCents;
    floorView = view;
    projected.push({
      key: step.key,
      title: step.title,
      detail: step.detail,
      removes: step.removes,
      removes_more: step.removesMore ?? 0,
      saves_per_month: fromCents(savedCents),
      saves_cents: savedCents,
      adds_per_month: fromCents(addedCents),
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

  // The scenario the ticks describe.
  //
  // Same three levers as the steps, applied only where ticked, and re-projected
  // through the same forecast. The saving is worked out the same way the steps
  // work theirs out, per row rounded then summed, so the figure on the card is
  // the rows it lists. With nothing ticked differently it is the floor, and the
  // floor's own projection is reused rather than run again.
  const stopSet = new Set((choices?.stop ?? optionalIds).map(String));
  const keepAllowance = choices?.allowance === 'keep';
  const chosenTrim = choices?.trim ?? trim;
  const chosenTrimRowCents = (row) => Math.round((row.per_month_cents * chosenTrim) / 100);
  const chosenTrimSaving = trimVariable.reduce((total, row) => total + chosenTrimRowCents(row), 0);
  const chosenSavesCents = sum(cutCommitments.filter((row) => stopSet.has(String(row.commitment_id))))
    + (keepAllowance ? 0 : allowanceCents)
    + chosenTrimSaving;
  const isWholePlan = !choices
    || (stopSet.size === optionalIds.length && optionalIds.every((id) => stopSet.has(String(id)))
        && !keepAllowance && chosenTrim === trim);
  const chosenView = isWholePlan && floorView ? floorView : await forecast({
    days: 400,
    window,
    client,
    forecastContext: context,
    discretionaryCentsPerMonth: keepAllowance ? undefined : 0,
    excludeCommitmentIds: [...stopSet],
    spendAdjustmentCentsPerDay: dailyFromMonthly(chosenTrimSaving),
  });

  // Every curve on one horizon, or the comparison is drawn against a lie. The
  // longest of them, so a plan that pushes the crossing out is shown reaching
  // it rather than being cut off where the money as it is failed.
  const horizon = Math.max(
    curveHorizon(base),
    floorView ? curveHorizon(floorView) : 0,
    curveHorizon(chosenView),
  );

  return {
    window_days: window,
    trim_percent: trim,
    now: {
      runway_date: base.runway_date,
      runway_date_friendly: friendlyDate(base.runway_date),
      runway_days: base.runway_days,
      gap_per_month: fromCents(gapCents),
    },
    curve: {
      as_is: cashCurve(base, horizon),
      // Null when there is nothing to change, rather than the same curve twice.
      with_plan: floorView ? cashCurve(floorView, horizon) : null,
    },
    // The optional costs themselves, with what the page needs to offer them:
    // the id a tick sends back, the year figure that undoes a monthly framing,
    // and the key a decision can watch itself against.
    optional: cutCommitments.map((row) => ({
      id: row.commitment_id,
      name: row.name,
      match_key: row.match_key,
      what_it_is: row.what_it_is,
      per_month: row.per_month,
      per_year: fromCents(row.per_month_cents * 12),
    })),
    allowance_per_month: fromCents(allowanceCents),
    // What that one figure is made of. It is the largest thing on the list and
    // was the only one with nothing under it: a row saying 2,482.10 a month for
    // "takeaway, clothes, whatever is not a bill" against which the honest
    // answer is often that most of it is at places nobody has judged either
    // way. Same cost model as the row above, so the parts add up to it.
    allowance: optionalBreakdown(costs),
    // What the projection is built on, for the page to say in four rows. From
    // the same base projection and cost model as everything else here, so it
    // cannot disagree with the curve it explains.
    assumes: {
      income: base.expected_income,
      cadence: base.cycle?.cadence ?? null,
      essential_per_day: base.projected_everyday_rate.essential_per_day,
      irregular_essential: base.everyday_rate.irregular_essential,
      window_days: base.spend_window_days,
      allowance_per_month: fromCents(allowanceCents),
      allowance_chosen: costs.discretionary_allowance_chosen,
      optional_history_per_month: fromCents(costs.historical_discretionary_per_month_cents),
      optional_subscriptions_per_month: fromCents(optionalCommitmentCents),
    },
    chosen: {
      stop: [...stopSet],
      // The rows at the ticked percent, so a card at 20 percent does not list
      // figures worked out at 30.
      trim_rows: trimVariable.slice(0, 8).map((row) => ({
        what: row.name,
        per_month: fromCents(chosenTrimRowCents(row)),
        from: row.per_month,
      })),
      trim_rows_more: Math.max(trimVariable.length - 8, 0),
      allowance: keepAllowance ? 'keep' : 'zero',
      trim_percent: chosenTrim,
      saves_per_month: fromCents(chosenSavesCents),
      lasts: chosenSavesCents >= gapCents,
      still_short_per_month: fromCents(Math.max(gapCents - chosenSavesCents, 0)),
      runway_date: chosenView.runway_date,
      runway_date_friendly: friendlyDate(chosenView.runway_date),
      beyond_horizon: chosenSavesCents < gapCents && chosenView.runway_date === null,
      horizon_date_friendly: friendlyDate(chosenView.series.at(-1).date),
      curve: cashCurve(chosenView, horizon),
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
      ...(await debtServicing(client, window, costs)),
      ...commitments
        .filter((row) => row.tier !== 'cut' && !debtKeys.has(row.match_key))
        .map((row) => ({ what: row.name, per_month: row.per_month, per_month_cents: row.per_month_cents })),
    ]
      .sort((a, b) => b.per_month_cents - a.per_month_cents)
      .map((row) => ({ what: row.what, per_month: row.per_month })),
    // Repeating costs that landed in the optional tier only because nothing has
    // judged them. They are not offered as a saving, because proposing that
    // somebody cancel a thing nobody has looked at is a default pretending to
    // be advice. Named instead, so the answer is a decision rather than a
    // silent omission.
    undecided: costs.unjudged_commitments
      .map((row) => ({ what: row.name, per_month: row.per_month, per_month_cents: row.per_month_cents }))
      .sort((a, b) => b.per_month_cents - a.per_month_cents)
      .map(({ per_month_cents: _skip, ...row }) => row),
  };
}

// What is being paid to our own debts, per account, whether or not any of it
// became a commitment.
async function debtServicing(client, window, costs = null) {
  const { debts } = await import('./behaviour.js');
  const rows = await debts({ client, window, costs });
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
      id: asset.id,
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
