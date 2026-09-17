// Stage 4: the forecast, the runway, and the commitments behind them.
import { Router } from 'express';
import { query } from '../db.js';
import { forecast, buildForecastContext, DEFAULT_SPEND_WINDOW_DAYS } from '../forecast.js';
import { detectCommitments, matchKeyFor } from '../commitments.js';
import { optionalByMonth, buildCostModel } from '../costs.js';
import { position, payPeriods } from '../behaviour.js';
import { numericToCents, centsToNumeric } from '../money.js';

// How far the household question is answered over, regardless of how far the
// page has been asked to draw. Today and the plan both use this length, and the
// answer has to be the same on all three.
const HOUSEHOLD_DAYS = 400;

export const forecastRouter = Router();

forecastRouter.get('/', async (req, res, next) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 14), 365);
    // Normalised once here so the forecast only ever sees exact 2dp text.
    const buffer = (Number(req.query.buffer) || 0).toFixed(2);
    const window = Math.min(Math.max(Number(req.query.window) || DEFAULT_SPEND_WINDOW_DAYS, 14), 180);
    let discretionaryCents;
    if (req.query.discretionary !== undefined) {
      try {
        discretionaryCents = numericToCents(String(req.query.discretionary));
      } catch {
        return res.status(400).json({ error: 'Discretionary spending must be a dollar amount with at most two decimal places' });
      }
    }
    if (discretionaryCents !== undefined && discretionaryCents < 0) {
      return res.status(400).json({ error: 'Discretionary spending cannot be negative' });
    }

    const forecastContext = await buildForecastContext({ window });
    const costs = forecastContext.costs;
    const optionalCommitments = costs.optional_commitments;
    const optionalIds = new Set(optionalCommitments.map((row) => String(row.commitment_id)));
    const requestedExclusions = String(req.query.exclude_commitments || '')
      .split(',')
      .filter(Boolean);
    // The control can turn off luxuries. Fixed and essential commitments
    // cannot be hidden by editing a query string.
    const excluded = requestedExclusions.filter((id) => optionalIds.has(id));

    const scenario = {
      buffer,
      window,
      forecastContext,
      discretionaryCentsPerMonth: discretionaryCents,
      excludeCommitmentIds: excluded,
    };
    const projection = await forecast({ days, ...scenario });

    // The same scenario, run out to a fixed horizon.
    //
    // "Beyond 90 days" was the answer to "does the money last", and it was the
    // look ahead control reading itself back. This household runs out on
    // 2027-09-07: at 365 days the page said so, and at the default 90 it said
    // "beyond 90 days" in the colour used for good news. A control may decide
    // how much of the curve you are shown. It may not decide what is true.
    //
    // position() is the same reading Today and the plan lead with, so all three
    // now answer this question identically whatever this page is set to.
    const householdProjection = await forecast({ days: HOUSEHOLD_DAYS, ...scenario });
    const household = await position({ window, forecastContext, projection: householdProjection });

    const historicalDiscretionaryCents =
      costs.historical_discretionary_per_month_cents;
    const optionalCommitmentCents = optionalCommitments
      .reduce((total, row) => total + row.per_month_cents, 0);
    const includedCommitmentCents = optionalCommitments
      .filter((row) => !excluded.includes(String(row.commitment_id)))
      .reduce((total, row) => total + row.per_month_cents, 0);

    // position() builds what goes out from the cost model, which knows nothing
    // about a scenario, so the excluded commitments are still inside its total.
    // Taken off here in cents rather than left to disagree with the curve drawn
    // directly underneath it.
    const excludedCents = optionalCommitmentCents - includedCommitmentCents;
    const outCents = numericToCents(household.out_per_month) - excludedCents;
    const gapCents = numericToCents(household.gap_per_month) - excludedCents;

    res.json({
      ...projection,
      household: {
        horizon_days: HOUSEHOLD_DAYS,
        in_per_month: household.in_per_month,
        out_per_month: centsToNumeric(outCents),
        gap_per_month: centsToNumeric(gapCents),
        going_backwards: gapCents > 0,
        runway_date: householdProjection.runway_date,
        runway_date_friendly: householdProjection.runway_date
          ? household.runway_date_friendly
          : null,
        runway_days: householdProjection.runway_days,
        is_scenario: excluded.length > 0 || discretionaryCents !== undefined,
      },
      periods: payPeriods(projection),
      luxury: {
        allowance_per_month:
          projection.projected_everyday_rate.discretionary_allowance_per_month,
        historical_variable_per_month: centsToNumeric(historicalDiscretionaryCents),
        optional_commitments_per_month: centsToNumeric(optionalCommitmentCents),
        included_commitments_per_month: centsToNumeric(includedCommitmentCents),
        active_commitments: optionalCommitments.map((row) => ({
          id: row.commitment_id,
          label: row.name,
          per_month: row.per_month,
          included: !excluded.includes(String(row.commitment_id)),
        })),
        // Commitments nothing has judged. They reach the 'cut' tier by default
        // and the projection treats them as optional, but a default is not a
        // finding, so they are named rather than offered as a saving. Fourth
        // page this has come up on.
        unjudged_commitments: costs.unjudged_commitments.map((row) => ({
          id: row.commitment_id,
          label: row.name,
          per_month: row.per_month,
        })),
        unjudged_per_month: centsToNumeric(
          costs.unjudged_commitments.reduce((total, row) => total + row.per_month_cents, 0),
        ),
      },
    });
  } catch (err) {
    next(err);
  }
});

// The allowance, and the evidence for choosing one.
//
// Everything here is read through one cost model and one projection, so the
// months under the chart, the figure the plan is using and the consequence of
// changing it cannot disagree with each other or with Today.
forecastRouter.get('/allowance', async (req, res, next) => {
  try {
    const window = Math.min(Math.max(Number(req.query.window) || DEFAULT_SPEND_WINDOW_DAYS, 14), 180);
    const months = Math.min(Math.max(Number(req.query.months) || 12, 2), 24);

    let candidateCents;
    if (req.query.at !== undefined) {
      try {
        candidateCents = numericToCents(String(req.query.at));
      } catch {
        return res.status(400).json({ error: 'That is not a dollar amount' });
      }
      if (candidateCents < 0) {
        return res.status(400).json({ error: 'An allowance cannot be negative' });
      }
    }

    const forecastContext = await buildForecastContext({ window });
    const costs = forecastContext.costs;

    // What this choice does, worked out by the real projection rather than by
    // arithmetic on the page. Two numbers that disagree are worse than one.
    const at = async (cents) => {
      const projection = await forecast({
        days: 400, window, forecastContext, discretionaryCentsPerMonth: cents,
      });
      const view = await position({ window, forecastContext, projection });
      return {
        per_month: centsToNumeric(cents),
        out_per_month: view.out_per_month,
        gap_per_month: view.gap_per_month,
        going_backwards: view.going_backwards,
        runway_date: view.runway_date,
        runway_date_friendly: view.runway_date_friendly,
      };
    };

    const history = await optionalByMonth(costs, { months });
    const whole = history.filter((row) => row.complete);
    // Only from whole months, and only when there are enough of them to be a
    // comparison rather than a coincidence. The quietest month is worth showing
    // because it is a figure the household has already lived on: an allowance
    // that has been met before is a different proposition from one that has not.
    const quietest = whole.length >= 3
      ? whole.reduce((best, row) => (row.spent_cents < best.spent_cents ? row : best))
      : null;

    // The middle month, in integer cents, picking a month that happened rather
    // than averaging two. The rate above it is a mean over a window and one big
    // month drags it a long way: this household spends about 450 a month on
    // things it does not have to buy, and one 11,000 dollar month inside the
    // window reports 3,239. Both are true and they answer different questions,
    // so both are offered and the chart says which is which.
    const sorted = [...whole].sort((a, b) => a.spent_cents - b.spent_cents);
    const typicalMonth = sorted.length >= 3
      ? sorted[Math.floor((sorted.length - 1) / 2)]
      : null;

    // A month that is nothing like the others is usually one purchase, and the
    // fix for that is to mark the purchase as a one off, not to pick a lower
    // allowance and hope. Named rather than quietly smoothed away.
    //
    // All of them, because the chart scales to the tallest ordinary month and
    // has to know which months are not ordinary. One list, so the scale and the
    // callout cannot disagree about that.
    const outliers = typicalMonth
      ? whole.filter((row) => row.spent_cents > typicalMonth.spent_cents * 3)
        .sort((a, b) => b.spent_cents - a.spent_cents)
      : [];

    res.json({
      allowance: {
        per_month: centsToNumeric(costs.discretionary_allowance_cents),
        chosen: costs.discretionary_allowance_chosen,
      },
      typical: {
        per_month: centsToNumeric(costs.historical_discretionary_per_month_cents),
        window_days: costs.window,
        effective_days: costs.effective_days,
      },
      quietest,
      typical_month: typicalMonth,
      outliers,
      outlier: outliers[0] ?? null,
      months: history,
      now: await at(costs.discretionary_allowance_cents),
      preview: candidateCents === undefined ? null : await at(candidateCents),
    });
  } catch (err) {
    next(err);
  }
});

forecastRouter.post('/policy', async (req, res, next) => {
  // Choosing nothing is a real answer, and it is not the same as choosing zero.
  // Clearing the setting hands the plan back to what the spending actually is.
  if (req.body?.follow_history === true) {
    try {
      await query("delete from settings where key = 'forecast_discretionary_monthly'");
      return res.json({ discretionary_monthly: null, chosen: false });
    } catch (err) {
      return next(err);
    }
  }

  let cents;
  try {
    cents = numericToCents(String(req.body?.discretionary_monthly ?? ''));
  } catch {
    return res.status(400).json({ error: 'Discretionary spending must be a dollar amount with at most two decimal places' });
  }
  if (cents < 0) {
    return res.status(400).json({ error: 'Discretionary spending cannot be negative' });
  }
  try {
    const value = centsToNumeric(cents);
    await query(
      `insert into settings (key, value)
       values ('forecast_discretionary_monthly', $1)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [value],
    );
    res.json({ discretionary_monthly: value, chosen: true });
  } catch (err) {
    next(err);
  }
});

forecastRouter.get('/commitments', async (req, res, next) => {
  try {
    const window = Math.min(Math.max(Number(req.query.window) || DEFAULT_SPEND_WINDOW_DAYS, 14), 180);
    const { rows } = await query(`
      select c.*, cat.name as category_name, grp.name as group_name
        from commitments c
        left join categories cat on cat.id = c.category_id
        left join categories grp on grp.id = cat.parent_id
       order by c.active desc, c.typical_amount, c.label
    `);

    // Whether each one is essential, and what decided that. The list used to
    // show the category and nothing else, so a subscription nothing had ever
    // looked at and a mortgage read the same, while the projection was quietly
    // treating the first as optional. Resolved through the cost model, which
    // reads the merchant judgement in JavaScript: matching a commitment key to
    // a merchant key in SQL matches almost nothing.
    const costs = await buildCostModel({ window });
    const assessed = new Map(costs.commitments.map((row) => [String(row.commitment_id), row]));

    res.json({
      // The active total, summed here in cents so the page prints it rather
      // than adding a column of 2dp strings in the browser.
      active_per_month: centsToNumeric(
        costs.commitments.reduce((total, row) => total + row.per_month_cents, 0),
      ),
      commitments: rows.map((row) => {
        const judged = assessed.get(String(row.id));
        return {
          ...row,
          // The name the household would recognise, which is the merchant's
          // display name where one has been set. The statement text is still
          // here as label: "OSKO PAYMENT ING HOME LOAN xxxx3310" truncates to
          // "OSKO PAYMEN..." on a phone, which names the payment rail.
          name: judged?.name ?? row.label,
          // Inactive and zero cadence rows are not in the model at all, so they
          // carry no tier rather than a made up one.
          tier: judged?.tier ?? null,
          tier_source: judged?.tier_source ?? null,
          is_debt: judged?.is_debt ?? false,
          per_month: judged?.per_month ?? null,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

forecastRouter.post('/commitments/detect', async (req, res, next) => {
  try {
    res.json({ found: await detectCommitments() });
  } catch (err) {
    next(err);
  }
});

forecastRouter.post('/commitments', async (req, res, next) => {
  try {
    const { label, typical_amount: amount, cadence_days: cadence, next_due: nextDue, category_id: categoryId } = req.body ?? {};
    if (!label || !String(label).trim()) return res.status(400).json({ error: 'A label is required' });
    if (!Number(amount)) return res.status(400).json({ error: 'A typical amount is required' });
    // Positive, because a cadence is how many days forward to the next one.
    // Zero or less was accepted and stored: every projection filters on
    // cadence_days > 0, so the commitment vanished from the forecast while the
    // page went on listing it as active, and scheduling one directly walks
    // backwards for as long as a Date lasts.
    if (!Number.isFinite(Number(cadence)) || Math.round(Number(cadence)) < 1) {
      return res.status(400).json({ error: 'How often it happens, in days, must be a whole number of days, at least one' });
    }

    // The same key detection would produce, not a namespace of its own.
    //
    // A hand entered commitment used to be keyed "manual:<label>", so that it
    // and a detected one could never fight over the same row. That is exactly
    // backwards: costs.js keeps a commitment's spending out of the everyday
    // rate by looking up matchKeyFor(description), which can never produce a
    // key in that namespace, so every manual commitment for a merchant with
    // real history was counted twice. A cafe costing 122 a month was carried at
    // 296. CLAUDE.md's own worked example, standing Youi down and entering
    // Suncorp by hand, has three payments of history behind it and hit this.
    //
    // They should fight over the same row. Detection only ever updates rows it
    // created, so a manual one holding the key wins and stays untouched.
    const key = matchKeyFor(String(label));
    if (!key) {
      return res.status(400).json({ error: 'That name has nothing in it to match on. Use the name as it appears on the statement.' });
    }
    const { rows } = await query(
      `insert into commitments (match_key, label, typical_amount, cadence_days, next_due,
                                category_id, source, occurrences, regularity)
       values ($1, $2, $3, $4, $5, $6, 'manual', 0, 1)
       returning *`,
      [
        key,
        String(label).trim(),
        // Outgoings are negative everywhere in this app.
        -Math.abs(Number(amount)),
        Math.round(Number(cadence)),
        nextDue || null,
        categoryId || null,
      ],
    );
    res.status(201).json({ commitment: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'There is already a repeating cost with that name' });
    next(err);
  }
});

forecastRouter.post('/commitments/:id', async (req, res, next) => {
  try {
    const { active, typical_amount: amount, cadence_days: cadence, next_due: nextDue, label } = req.body ?? {};
    // Same rule on edit as on create, or a valid commitment can be turned into
    // one no projection will ever see.
    if (cadence !== undefined && cadence !== null
        && (!Number.isFinite(Number(cadence)) || Math.round(Number(cadence)) < 1)) {
      return res.status(400).json({ error: 'How often it happens, in days, must be a whole number of days, at least one' });
    }
    const { rows } = await query(
      `update commitments set
         active         = coalesce($2, active),
         typical_amount = coalesce($3, typical_amount),
         cadence_days   = coalesce($4, cadence_days),
         next_due       = coalesce($5, next_due),
         label          = coalesce($6, label),
         updated_at     = now()
       where id = $1
       returning *`,
      [
        req.params.id,
        active ?? null,
        amount === undefined || amount === null ? null : -Math.abs(Number(amount)),
        cadence ?? null,
        nextDue ?? null,
        label ?? null,
      ],
    );
    if (!rows.length) return res.status(404).json({ error: 'No such repeating cost' });
    res.json({ commitment: rows[0] });
  } catch (err) {
    next(err);
  }
});

forecastRouter.delete('/commitments/:id', async (req, res, next) => {
  try {
    const { rowCount } = await query('delete from commitments where id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'No such repeating cost' });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});
