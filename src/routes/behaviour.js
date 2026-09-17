// The Today page: position, whether the last decision held, and what one
// change would buy. See src/behaviour.js and docs/behaviour.md for why this
// page exists at all when the Forecast page already has the numbers.
import { Router } from 'express';
import { query } from '../db.js';
import { position, didItStick, movers, tradeOff, whatToStop, intentions, debts, thisPeriod, cashCurve, payPeriods } from '../behaviour.js';
import { forecast, buildForecastContext, DEFAULT_SPEND_WINDOW_DAYS } from '../forecast.js';
import { numericToCents } from '../money.js';

export const behaviourRouter = Router();

const windowFrom = (req) =>
  Math.min(Math.max(Number(req.query.window) || DEFAULT_SPEND_WINDOW_DAYS, 14), 400);

// When the household last changed shape. Everything on the "did it stick" view
// is measured from here. Suggested from the data, kept once set: a person knows
// why their spending changed and the data only knows that it did.
async function changePoint(client = { query }) {
  const { rows } = await client.query(
    `select value from settings where key = 'behaviour_change_point'`,
  );
  if (rows[0]?.value) return { date: rows[0].value, source: 'the date you set' };

  // Otherwise, the last time a regular income arrived that has since stopped.
  //
  // "Regular" is doing the work. The first version of this took the most recent
  // income of any kind that had gone quiet, and picked a tax refund that had
  // arrived twice, which is not a change in the household's shape. A salary
  // arrives many times before it stops, so the bar is six occurrences and a
  // total worth noticing.
  const { rows: guess } = await client.query(`
    select t.merchant_key, max(t.txn_date) as last_seen, count(*)::int as times
      from budget_flows t
      join categories c on c.id = t.category_id and c.kind = 'income'
     where t.counts and t.amount > 0
       and t.merchant_key is not null
     group by t.merchant_key
    having count(*) >= 6
       and sum(t.amount) > 10000
       and max(t.txn_date) < current_date - 30
     order by max(t.txn_date) desc
     limit 1
  `);
  if (guess[0]?.last_seen) {
    return {
      date: String(guess[0].last_seen).slice(0, 10),
      source: `the last of ${guess[0].times} regular payments from an income that has since stopped`,
    };
  }
  return { date: null, source: 'nothing to compare against yet' };
}

// How far forward the Home page draws, and the curve to draw.
//
behaviourRouter.get('/', async (req, res, next) => {
  try {
    const window = windowFrom(req);
    const forecastContext = await buildForecastContext({ window });
    const projection = await forecast({ days: 400, window, forecastContext });
    const here = await position({ window, forecastContext, projection });
    const point = req.query.since
      ? { date: req.query.since, source: 'the date you asked for' }
      : await changePoint();
    const since = point.date;
    const [stuck, moved, decisions, debtRows, costs, period] = await Promise.all([
      since ? didItStick({ since }) : null,
      since ? movers({ since }) : null,
      intentions(),
      // The same window as the headline, and the same cost model. Left to its
      // own default the card was built on 120 days while the figure above it
      // used whatever was asked for; without the model it measured the same
      // payments a second way and came out 291.72 short of the "Debt" figure
      // directly above it on the front page.
      debts({ window, costs: forecastContext.costs }),
      whatToStop({ window, limit: 40, forecastContext, positionResult: here }),
      thisPeriod({ projection }),
    ]);

    res.json({
      position: here,
      period,
      // Income that has not started yet, so the front page can say whether any
      // has been entered without asking the analyst routes for it.
      expecting: (projection.expected_income_streams ?? []).map((row) => ({
        label: row.label, amount: row.amount, starts_on: row.starts_on,
      })),
      curve: cashCurve(projection),
      // The next few pay periods, cut from the same projection as the curve.
      // The first is the stub from today to payday, which the fortnight card
      // already covers, so the page starts from the one after it.
      periods: payPeriods(projection).slice(0, 7),
      change_point: point,
      stuck,
      movers: moved,
      intentions: decisions,
      debts: debtRows,
      costs,
    });
  } catch (err) {
    next(err);
  }
});

// Setting the change point by hand. The suggestion is only a suggestion.
behaviourRouter.post('/change-point', async (req, res, next) => {
  try {
    const { date } = req.body ?? {};
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json({ error: 'Give a date as YYYY-MM-DD, or nothing to go back to the suggestion' });
    }
    if (date) {
      await query(
        `insert into settings (key, value) values ('behaviour_change_point', $1)
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [date],
      );
    } else {
      await query(`delete from settings where key = 'behaviour_change_point'`);
    }
    res.json(await changePoint());
  } catch (err) {
    next(err);
  }
});

// What one change, or several together, would do to the date. Nothing is
// stored: this is for looking at.
behaviourRouter.post('/trade-off', async (req, res, next) => {
  try {
    const { monthly = 0, commitment_ids: commitmentIds = [] } = req.body ?? {};
    // Through money.js rather than Number(x) * 100, so a third decimal place is
    // refused rather than silently rounded into a different amount.
    let monthlyCents;
    try {
      monthlyCents = numericToCents(String(monthly));
    } catch {
      return res.status(400).json({ error: 'A monthly amount is required, as dollars with at most two decimal places' });
    }
    res.json(await tradeOff({
      monthlyCents: Math.max(monthlyCents, 0),
      commitmentIds: Array.isArray(commitmentIds) ? commitmentIds : [],
      window: windowFrom(req),
    }));
  } catch (err) {
    next(err);
  }
});

behaviourRouter.get('/intentions', async (req, res, next) => {
  try {
    res.json({ intentions: await intentions() });
  } catch (err) {
    next(err);
  }
});

behaviourRouter.post('/intentions', async (req, res, next) => {
  try {
    const {
      what, trigger_text: trigger, merchant_key: merchantKey,
      target_monthly: target, review_on: reviewOn,
    } = req.body ?? {};
    if (!what || !String(what).trim()) return res.status(400).json({ error: 'Say what the decision is' });

    let targetMonthly = null;
    if (target !== null && target !== undefined && String(target).trim() !== '') {
      const parsed = Number(target);
      if (!Number.isFinite(parsed)) {
        return res.status(400).json({ error: 'That amount is not a number' });
      }
      targetMonthly = Math.abs(parsed).toFixed(2);
    }

    const { rows } = await query(
      `insert into intentions (what, trigger_text, merchant_key, target_monthly, review_on)
       values ($1, $2, $3, $4, $5) returning *`,
      [
        String(what).trim(),
        trigger ? String(trigger).trim() : null,
        merchantKey || null,
        // Number('abc').toFixed(2) is the string "NaN", which numeric(12,2)
        // accepts as NaN and the page then renders as $NaN.00. Refused, not
        // coerced, the same way money.js refuses a float.
        targetMonthly,
        reviewOn || null,
      ],
    );
    res.status(201).json({ intention: rows[0] });
  } catch (err) {
    next(err);
  }
});

behaviourRouter.post('/intentions/:id', async (req, res, next) => {
  try {
    const { status } = req.body ?? {};
    if (!['open', 'kept', 'slipped', 'dropped'].includes(status)) {
      return res.status(400).json({ error: 'Unknown status' });
    }
    const { rows } = await query(
      'update intentions set status = $2, updated_at = now() where id = $1 returning *',
      [req.params.id, status],
    );
    if (!rows.length) return res.status(404).json({ error: 'No such decision' });
    res.json({ intention: rows[0] });
  } catch (err) {
    next(err);
  }
});
