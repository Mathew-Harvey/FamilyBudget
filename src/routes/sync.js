// Sync history, and the Sync now button.
import { Router } from 'express';
import { query, getPool } from '../db.js';
import { runSync } from '../sync.js';

export const syncRouter = Router();

// One sync at a time. The cron job and a button press must not overlap.
let inFlight = null;

syncRouter.get('/runs', async (req, res, next) => {
  try {
    const { rows } = await query(
      `select id, started_at, finished_at, status, accounts_synced, txns_inserted,
              txns_updated, pending_resolved, pending_expired, transfers_detected,
              error_message
         from sync_runs
        order by started_at desc
        limit 20`,
    );
    res.json({ runs: rows, running: inFlight !== null });
  } catch (err) {
    next(err);
  }
});

syncRouter.post('/run', async (req, res, next) => {
  if (inFlight) return res.status(409).json({ error: 'A sync is already running' });
  try {
    // Kick it off and answer straight away. The UI polls /runs for the result,
    // because a first backfill takes minutes and would time out the request.
    inFlight = runSync({ pool: getPool(), log: () => {} })
      .catch((err) => {
        console.error(`sync failed: ${err.message}`);
      })
      .finally(() => {
        inFlight = null;
      });
    res.status(202).json({ started: true });
  } catch (err) {
    inFlight = null;
    next(err);
  }
});
