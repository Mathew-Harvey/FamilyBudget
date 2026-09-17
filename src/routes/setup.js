// What each workshop page would say if you opened it.
//
// The Set up index listed eleven pages and every row looked identical whether
// 42 transfers were waiting on a decision or none were, whether the last sync
// read the banks this morning or failed three days ago. A list that cannot tell
// you which of eleven things needs you is a list you read top to bottom every
// time, so it counts what is waiting and each row says so.
//
// Counts, and honest ones. This is the queue of decisions the app is waiting
// on, and a queue that undercounts is worse than one that takes a moment: the
// number of repeating costs nobody has judged can only be known through the
// cost model, because the merchant judgement is matched in JavaScript through
// matchKeyFor and never joined in SQL. That model is about 36ms. Everything
// else here is a plain count.
import { Router } from 'express';
import { query } from '../db.js';
import { getSettings } from '../alerts.js';
import { buildCostModel } from '../costs.js';
import { DEFAULT_SPEND_WINDOW_DAYS } from '../forecast.js';

export const setupRouter = Router();

setupRouter.get('/', async (req, res, next) => {
  try {
    const [counts, run, alerts, analyst, costs] = await Promise.all([
      query(`select
          (select count(*) from transactions t
             where t.is_transfer and t.transfer_confidence = 'auto'
               and t.id < t.transfer_pair_id)::int as transfers_waiting,
          (select count(*) from budget_flows
             where counts and category_id is null)::int as uncategorised,
          -- Decisions, not rows: 483 unfiled transactions are fifteen places.
          (select count(distinct coalesce(merchant_key, description)) from budget_flows
             where counts and category_id is null)::int as unfiled_places,
          -- The same test the one off list uses, counting only what is not
          -- yet marked either way. Kept in step with /api/spending/one-off-
          -- candidates: a queue that counts differently from the list it
          -- points at is two answers to one question.
          (with seen as (
             select merchant_key, count(distinct txn_date)::int as days_paid
               from budget_flows
              where counts and amount < 0 and txn_date > current_date - 400
              group by merchant_key
           )
           select count(*) from budget_flows t
             left join seen s on s.merchant_key = t.merchant_key
            where t.counts and t.amount < 0 and not t.one_off
              and t.txn_date > current_date - 400
              and -t.amount >= 400
              and coalesce(s.days_paid, 1) < 3
              and not exists (
                select 1 from commitments c
                 where c.active and c.cadence_days > 0 and c.match_key = t.merchant_key
              ))::int as one_off_candidates,
          (select count(*) from accounts where not is_liquid and role is null)::int as accounts_unset,
          (select count(*) from commitments where active and cadence_days > 0)::int as commitments,
          (select count(*) from rules)::int as rules,
          (select value from settings where key = 'forecast_discretionary_monthly') as allowance`),
      query(`select status, started_at, txns_inserted from sync_runs
              order by started_at desc limit 1`),
      getSettings(),
      query('select enabled, last_run_at from analyst_settings where id'),
      buildCostModel({ window: DEFAULT_SPEND_WINDOW_DAYS }),
    ]);

    const row = counts.rows[0];
    res.json({
      transfers_waiting: row.transfers_waiting,
      uncategorised: row.uncategorised,
      unfiled_places: row.unfiled_places,
      one_off_candidates: row.one_off_candidates,
      // Repeating costs the plan is treating as optional because nothing has
      // said otherwise. A default is not a finding, and these are the ones
      // waiting on a finding.
      unjudged: costs.unjudged_commitments.length,
      accounts_unset: row.accounts_unset,
      commitments: row.commitments,
      rules: row.rules,
      // Whether anybody has chosen one, not what it is. The allowance page
      // says what it is, and says it properly.
      allowance_chosen: row.allowance !== null && String(row.allowance).trim() !== '',
      last_sync: run.rows[0]
        ? {
            status: run.rows[0].status,
            at: run.rows[0].started_at,
            inserted: run.rows[0].txns_inserted,
          }
        : null,
      alerts_on: Boolean(alerts?.enabled),
      analysis_on: Boolean(analyst.rows[0]?.enabled),
    });
  } catch (err) {
    next(err);
  }
});
