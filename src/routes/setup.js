// What each workshop page would say if you opened it.
//
// The Set up index listed eleven pages and every row looked identical whether
// 42 transfers were waiting on a decision or none were, whether the last sync
// read the banks this morning or failed three days ago. A list that cannot tell
// you which of eleven things needs you is a list you read top to bottom every
// time, so it counts what is waiting and each row says so.
//
// Counts only, and cheap ones. Nothing here computes a rate or builds a model:
// this loads on every visit to the index and must never be the slow part.
import { Router } from 'express';
import { query } from '../db.js';
import { getSettings } from '../alerts.js';

export const setupRouter = Router();

setupRouter.get('/', async (req, res, next) => {
  try {
    const [counts, run, alerts, analyst] = await Promise.all([
      query(`select
          (select count(*) from transactions t
             where t.is_transfer and t.transfer_confidence = 'auto'
               and t.id < t.transfer_pair_id)::int as transfers_waiting,
          (select count(*) from budget_flows
             where counts and category_id is null)::int as uncategorised,
          (select count(*) from accounts where not is_liquid and role is null)::int as accounts_unset,
          (select count(*) from commitments where active and cadence_days > 0)::int as commitments,
          (select count(*) from rules)::int as rules,
          (select value from settings where key = 'forecast_discretionary_monthly') as allowance`),
      query(`select status, started_at, txns_inserted from sync_runs
              order by started_at desc limit 1`),
      getSettings(),
      query('select enabled, last_run_at from analyst_settings where id'),
    ]);

    const row = counts.rows[0];
    res.json({
      transfers_waiting: row.transfers_waiting,
      uncategorised: row.uncategorised,
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
