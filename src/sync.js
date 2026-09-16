#!/usr/bin/env node
// The sync engine. Runs as `npm run sync` from the Render Cron Job, and is also
// triggered by the Sync now button in the UI.
//
// Running it twice in a row changes nothing the second time.
import { fileURLToPath } from 'node:url';
import { getPool, withTransaction, closePool } from './db.js';
import { createClient } from './redbark.js';
import { centsToNumeric, numericToCents, redbarkAmountToCents } from './money.js';
import { descriptionSimilarity, daysBetween, toDateOnly } from './matching.js';
import { detectTransfers, resolveInternalDestinations } from './transfers.js';
import { categoriseAll } from './categorise.js';
import { detectCommitments } from './commitments.js';
import { today, daysAgo } from './dates.js';
import { merchantKeyFor, backfillMerchantKeys, ensureMerchantRows } from './merchants.js';
import { runAlerts } from './alerts.js';
import { runPeriodicAnalysis } from './analyst.js';

// How far back to re-read on a routine run, so late posting and edited rows are
// caught.
const OVERLAP_DAYS = Number(process.env.SYNC_OVERLAP_DAYS || 21);
// Redbark serves about 7 years. Ask for a little less to stay clear of the
// from_too_old boundary.
const BACKFILL_YEARS = Number(process.env.SYNC_BACKFILL_YEARS || 6);
// A single read is capped at 5000 rows, so backfill in windows rather than
// asking for years at once.
const BACKFILL_CHUNK_DAYS = Number(process.env.SYNC_BACKFILL_CHUNK_DAYS || 180);
// A pending row Redbark stops returning for this long was cancelled or reversed.
const PENDING_EXPIRY_DAYS = Number(process.env.SYNC_PENDING_EXPIRY_DAYS || 10);
// Pending to posted matching tolerances.
const PENDING_MATCH_DAYS = 5;
const PENDING_MATCH_SIMILARITY = 0.6;

const isoDate = (date) => date.toISOString().slice(0, 10);

// Loans and mortgages are not spendable, so they default to not liquid.
function defaultIsLiquid(type) {
  return !['loan', 'mortgage', 'credit_card'].includes(String(type || '').toLowerCase());
}

export async function upsertAccounts(client, redbarkAccounts) {
  const ids = [];
  for (const account of redbarkAccounts) {
    // Two ways the same account can already be here.
    //
    // By its Redbark id, which is the ordinary case, and by its number at its
    // bank, which is what saves us when a connection is relinked. Relinking
    // reissues every account id behind that connection, and consent expires
    // yearly, so this is routine rather than exotic. Matching only on the
    // Redbark id would insert a second copy of an account we already have and
    // quietly orphan the original, along with its transactions, its balances,
    // and the is_liquid and role settings the forecast is built on.
    //
    // The same path adopts an account that was created by hand and is later
    // served by open banking: it keeps its id, so its balance, its role and
    // anything pointing at it all survive.
    const { rows: existing } = await client.query(
      `select id from accounts
        where redbark_account_id = $1
           or (masked_number is not null and masked_number = $2 and bank = $3)
        limit 1`,
      [account.id, account.account_number ?? null, account.institution?.name ?? 'Unknown'],
    );

    if (existing.length) {
      const { rows: updated } = await client.query(
        `update accounts set
           source                = 'redbark',
           redbark_connection_id = $2,
           redbark_account_id    = $3,
           bank                  = $4,
           name                  = case when source = 'manual' then name else $5 end,
           masked_number         = coalesce($6, masked_number),
           type                  = $7,
           currency              = $8,
           status                = $9,
           updated_at            = now()
         where id = $1
         returning id`,
        [
          existing[0].id,
          account.connection,
          account.id,
          account.institution?.name ?? 'Unknown',
          account.name,
          account.account_number,
          account.type,
          account.currency ?? 'aud',
          account.status,
        ],
      );
      ids.push({ accountId: updated[0].id, redbarkAccountId: account.id, name: account.name });
      continue;
    }

    const result = await client.query(
      `insert into accounts (
         source, redbark_connection_id, redbark_account_id, bank, name,
         masked_number, type, is_liquid, currency, status
       )
       values ('redbark', $1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (redbark_account_id) do update set
         redbark_connection_id = excluded.redbark_connection_id,
         bank          = excluded.bank,
         name          = excluded.name,
         masked_number = excluded.masked_number,
         type          = excluded.type,
         currency      = excluded.currency,
         status        = excluded.status,
         updated_at    = now()
       returning id`,
      [
        account.connection,
        account.id,
        account.institution?.name ?? 'Unknown',
        account.name,
        account.account_number,
        account.type,
        // Only set on insert. The do update block above deliberately leaves
        // is_liquid and role alone, because those are the user's to set.
        defaultIsLiquid(account.type),
        account.currency ?? 'aud',
        account.status,
      ],
    );
    ids.push({ accountId: result.rows[0].id, redbarkAccountId: account.id, name: account.name });
  }
  return ids;
}

// Maps a Redbark transaction onto our columns. One place to change if the API
// shape moves again.
export function mapTransaction(txn) {
  return {
    redbark_txn_id: txn.id,
    status: txn.status === 'pending' ? 'pending' : 'posted',
    txn_date: toDateOnly(txn.date),
    posted_date: toDateOnly(txn.post_date),
    description: (txn.description ?? '').trim(),
    amount_cents: redbarkAmountToCents(txn.amount, `transaction ${txn.id}`),
    direction: txn.direction ?? null,
    reference: txn.reference ?? null,
    extended_description: txn.extended_description ?? null,
    // Banks pad this field, for example "SHHPS P&C          ".
    merchant_name: txn.merchant_name ? txn.merchant_name.trim() : null,
    // Worked out here, at write time, so SQL never has to reproduce it.
    merchant_key: merchantKeyFor(txn.description, txn.merchant_name),
    provider_category: txn.provider_category ?? null,
    raw: txn,
  };
}

// Finds an existing pending row that this newly posted row is the settled
// version of. Redbark transaction ids are content hashes, so an id can change
// when a transaction posts and the row would otherwise be inserted twice.
export function findPendingMatch(posted, pendingRows) {
  const scored = pendingRows
    .filter((row) => row.amount_cents === posted.amount_cents)
    .map((row) => ({
      row,
      days: daysBetween(row.txn_date, posted.txn_date),
      similarity: descriptionSimilarity(row.description, posted.description),
    }))
    .filter((entry) => entry.days <= PENDING_MATCH_DAYS && entry.similarity >= PENDING_MATCH_SIMILARITY)
    .sort((x, y) => x.days - y.days || y.similarity - x.similarity);

  if (!scored.length) return null;
  // If two pending rows are equally good, resolving either could be wrong, so
  // resolve neither and let them be separate rows.
  if (
    scored.length > 1 &&
    scored[0].days === scored[1].days &&
    scored[0].similarity === scored[1].similarity
  ) {
    return null;
  }
  return scored[0].row;
}

// Writes one account's fetched window. Returns what changed.
export async function persistTransactions(client, accountId, redbarkTxns) {
  const counts = { inserted: 0, updated: 0, pendingResolved: 0, pendingExpired: 0 };

  // Backfill reads in windows, and a transaction can legitimately come back in
  // more than one of them. Collapse duplicates by id first, keeping the last
  // copy seen, so one batch never tries to insert the same row twice.
  const byRedbarkId = new Map();
  for (const txn of redbarkTxns) {
    const row = mapTransaction(txn);
    byRedbarkId.set(row.redbark_txn_id, row);
  }
  const mapped = [...byRedbarkId.values()];
  const seenIds = new Set(byRedbarkId.keys());

  // Which of these we already hold, in one query rather than one per row.
  const known = new Set(
    (
      await client.query(
        'select redbark_txn_id from transactions where account_id = $1 and redbark_txn_id = any($2::text[])',
        [accountId, [...seenIds]],
      )
    ).rows.map((row) => row.redbark_txn_id),
  );

  // Pending rows we already hold for this account, so a posted row can be
  // matched onto one instead of being inserted alongside it.
  const existingPending = (
    await client.query(
      `select id, redbark_txn_id, txn_date, description, (amount * 100)::bigint as amount_cents
         from transactions
        where account_id = $1 and status = 'pending'`,
      [accountId],
    )
  ).rows.map((row) => ({ ...row, txn_date: toDateOnly(row.txn_date) }));

  const claimedPendingIds = new Set();

  for (const txn of mapped) {
    if (known.has(txn.redbark_txn_id)) {
      const result = await client.query(
        `update transactions set
           status               = $3,
           txn_date             = $4,
           posted_date          = $5,
           description          = $6,
           amount               = $7,
           direction            = $8,
           reference            = $9,
           extended_description = $10,
           merchant_name        = $11,
           provider_category    = $12,
           raw                  = $13,
           merchant_key         = $14,
           last_seen_at         = now(),
           updated_at           = case
             when status is distinct from $3
               or txn_date is distinct from $4::date
               or posted_date is distinct from $5::date
               or description is distinct from $6
               or amount is distinct from $7::numeric
             then now() else updated_at end
         where account_id = $1 and redbark_txn_id = $2
         returning (updated_at = now()) as changed`,
        [
          accountId,
          txn.redbark_txn_id,
          txn.status,
          txn.txn_date,
          txn.posted_date,
          txn.description,
          centsToNumeric(txn.amount_cents),
          txn.direction,
          txn.reference,
          txn.extended_description,
          txn.merchant_name,
          txn.provider_category,
          JSON.stringify(txn.raw),
          txn.merchant_key,
        ],
      );
      if (result.rows[0]?.changed) counts.updated++;
      continue;
    }

    // Not seen before. If it is posted, it may be the settled form of a pending
    // row we already hold under a different id.
    if (txn.status === 'posted') {
      const available = existingPending.filter(
        (row) => !claimedPendingIds.has(row.id) && !seenIds.has(row.redbark_txn_id),
      );
      const match = findPendingMatch(txn, available);
      if (match) {
        // Update in place rather than delete and insert, so first_seen_at, any
        // transfer pairing and the Stage 2 category_id survive the transition.
        await client.query(
          `update transactions set
             redbark_txn_id       = $2,
             status               = 'posted',
             txn_date             = $3,
             posted_date          = $4,
             description          = $5,
             amount               = $6,
             direction            = $7,
             reference            = $8,
             extended_description = $9,
             merchant_name        = $10,
             provider_category    = $11,
             raw                  = $12,
             merchant_key         = $13,
             last_seen_at         = now(),
             updated_at           = now()
           where id = $1`,
          [
            match.id,
            txn.redbark_txn_id,
            txn.txn_date,
            txn.posted_date,
            txn.description,
            centsToNumeric(txn.amount_cents),
            txn.direction,
            txn.reference,
            txn.extended_description,
            txn.merchant_name,
            txn.provider_category,
            JSON.stringify(txn.raw),
            txn.merchant_key,
          ],
        );
        claimedPendingIds.add(match.id);
        counts.pendingResolved++;
        continue;
      }
    }

    await client.query(
      `insert into transactions (
         account_id, redbark_txn_id, status, txn_date, posted_date, description,
         amount, direction, reference, extended_description, merchant_name,
         provider_category, raw, merchant_key
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        accountId,
        txn.redbark_txn_id,
        txn.status,
        txn.txn_date,
        txn.posted_date,
        txn.description,
        centsToNumeric(txn.amount_cents),
        txn.direction,
        txn.reference,
        txn.extended_description,
        txn.merchant_name,
        txn.provider_category,
        JSON.stringify(txn.raw),
        txn.merchant_key,
      ],
    );
    counts.inserted++;
  }

  // A pending row Redbark has stopped returning for long enough was cancelled
  // or reversed, so it never happened and should not sit in our history.
  const expired = await client.query(
    `delete from transactions
      where account_id = $1
        and status = 'pending'
        and last_seen_at < now() - ($2::integer * interval '1 day')
      returning id`,
    [accountId, PENDING_EXPIRY_DAYS],
  );
  counts.pendingExpired = expired.rowCount;

  return counts;
}

export async function snapshotBalances(client, balances, accountIdByRedbarkId) {
  let written = 0;
  for (const balance of balances) {
    const accountId = accountIdByRedbarkId.get(balance.account);
    if (!accountId) continue;
    await client.query(
      `insert into balances (account_id, balance_date, balance, available_balance, observed_at, freshness)
       values ($1, current_date, $2, $3, $4, $5)
       on conflict (account_id, balance_date) do update set
         balance           = excluded.balance,
         available_balance = excluded.available_balance,
         observed_at       = excluded.observed_at,
         freshness         = excluded.freshness,
         captured_at       = now()`,
      [
        accountId,
        balance.current ? centsToNumeric(redbarkAmountToCents(balance.current, 'balance')) : null,
        balance.available ? centsToNumeric(redbarkAmountToCents(balance.available, 'available')) : null,
        balance.observed_at ?? null,
        balance.freshness ?? null,
      ],
    );
    written++;
  }
  return written;
}

// Works out what window to read for an account: everything on the first run,
// an overlapping window after that.
async function windowsFor(client, accountId) {
  const { rows } = await client.query(
    'select count(*)::int as count from transactions where account_id = $1',
    [accountId],
  );
  if (rows[0].count > 0) {
    return [{ from: daysAgo(OVERLAP_DAYS), to: today() }];
  }

  // First run: walk back in chunks so no single read hits the 5000 row cap.
  const windows = [];
  const earliest = new Date(Date.now() - BACKFILL_YEARS * 365 * 86_400_000);
  let to = new Date();
  while (to > earliest) {
    const from = new Date(Math.max(earliest.getTime(), to.getTime() - BACKFILL_CHUNK_DAYS * 86_400_000));
    windows.push({ from: isoDate(from), to: isoDate(to) });
    to = new Date(from.getTime() - 86_400_000);
  }
  return windows;
}

export async function runSync({ client: redbark, pool, log = console.log } = {}) {
  const dbPool = pool ?? getPool();
  const api = redbark ?? createClient();

  const runResult = await dbPool.query(
    "insert into sync_runs (status) values ('running') returning id",
  );
  const runId = runResult.rows[0].id;

  const totals = {
    accounts_synced: 0,
    txns_inserted: 0,
    txns_updated: 0,
    pending_resolved: 0,
    pending_expired: 0,
    transfers_detected: 0,
    txns_categorised: 0,
    commitments_found: 0,
    alerts_sent: 0,
    analysis_run: false,
  };
  const failures = [];

  try {
    const redbarkAccounts = await api.listAccounts();
    const accountRefs = await withTransaction((client) => upsertAccounts(client, redbarkAccounts), dbPool);
    const accountIdByRedbarkId = new Map(accountRefs.map((r) => [r.redbarkAccountId, r.accountId]));
    log(`accounts: ${accountRefs.length}`);

    for (const ref of accountRefs) {
      // A failure on one account must not stop the others.
      try {
        const windows = await windowsFor(dbPool, ref.accountId);
        if (windows.length > 1) log(`  ${ref.name}: first run, backfilling in ${windows.length} windows`);

        const fetched = [];
        for (const window of windows) {
          const { rows, truncated } = await api.listTransactions({
            accountId: ref.redbarkAccountId,
            from: window.from,
            to: window.to,
          });
          if (truncated) {
            failures.push(
              `${ref.name}: Redbark truncated ${window.from}..${window.to} at the 5000 row cap, narrow SYNC_BACKFILL_CHUNK_DAYS`,
            );
          }
          fetched.push(...rows);
        }

        const counts = await withTransaction(
          (client) => persistTransactions(client, ref.accountId, fetched),
          dbPool,
        );
        totals.txns_inserted += counts.inserted;
        totals.txns_updated += counts.updated;
        totals.pending_resolved += counts.pendingResolved;
        totals.pending_expired += counts.pendingExpired;
        totals.accounts_synced++;
        log(
          `  ${ref.name}: ${fetched.length} read, ${counts.inserted} new, ${counts.updated} updated, ` +
            `${counts.pendingResolved} pending resolved, ${counts.pendingExpired} pending expired`,
        );
      } catch (err) {
        failures.push(`${ref.name}: ${err.message}`);
        log(`  ${ref.name}: FAILED ${err.message}`);
      }
    }

    // Balances come back in one call for every account.
    try {
      const balances = await api.listBalances(accountRefs.map((r) => r.redbarkAccountId));
      const written = await withTransaction(
        (client) => snapshotBalances(client, balances, accountIdByRedbarkId),
        dbPool,
      );
      log(`balances: ${written} snapshotted`);
    } catch (err) {
      failures.push(`balances: ${err.message}`);
    }

    totals.transfers_detected = await detectTransfers({ pool: dbPool });
    // Transfers between our own accounts that never found a counterpart, read
    // out of the description instead. Runs after pairing so it only looks at
    // what pairing could not explain.
    totals.internal_transfers_resolved = await resolveInternalDestinations({ pool: dbPool });
    log(`transfers: ${totals.transfers_detected} auto paired`);

    // Categorising runs last, over everything that is not manually set.
    totals.txns_categorised = await categoriseAll({ pool: dbPool });
    log(`categories: ${totals.txns_categorised} transactions categorised`);

    // Anything without a merchant key yet, for example rows written before this
    // existed, and a merchants row for every key seen.
    await withTransaction(async (client) => {
      await backfillMerchantKeys(client);
      await ensureMerchantRows(client);
    }, dbPool);

    // Commitments feed the forecast, so they are refreshed once categories are
    // settled.
    totals.commitments_found = await detectCommitments({ pool: dbPool });
    log(`commitments: ${totals.commitments_found} recurring outgoings`);

    // Analysis before alerts, so an alert can mention a fresh finding. It only
    // actually calls out when it is switched on and the cadence has come round.
    try {
      const analysis = await runPeriodicAnalysis({ pool: dbPool });
      totals.analysis_run = analysis.ran;
      log(`analysis: ${analysis.ran ? 'ran' : `skipped, ${analysis.reason}`}`);
    } catch (err) {
      failures.push(`analysis: ${err.message}`);
    }

    // Alerts go last, so they see everything this run changed. A failure to
    // send must never fail the sync.
    try {
      const alerted = await runAlerts({ pool: dbPool });
      totals.alerts_sent = alerted.sent;
      log(`alerts: ${alerted.sent} sent of ${alerted.considered} considered`);
    } catch (err) {
      failures.push(`alerts: ${err.message}`);
    }

    const status = failures.length ? (totals.accounts_synced ? 'partial' : 'failed') : 'success';
    await dbPool.query(
      `update sync_runs set
         finished_at = now(), status = $2, accounts_synced = $3, txns_inserted = $4,
         txns_updated = $5, pending_resolved = $6, pending_expired = $7,
         transfers_detected = $8, txns_categorised = $9, commitments_found = $10,
         alerts_sent = $11, analysis_run = $12, error_message = $13
       where id = $1`,
      [
        runId,
        status,
        totals.accounts_synced,
        totals.txns_inserted,
        totals.txns_updated,
        totals.pending_resolved,
        totals.pending_expired,
        totals.transfers_detected,
        totals.txns_categorised,
        totals.commitments_found,
        totals.alerts_sent,
        totals.analysis_run,
        failures.length ? failures.join('\n') : null,
      ],
    );
    return { runId, status, ...totals, failures };
  } catch (err) {
    // A run that fails outright still leaves a record behind.
    await dbPool.query(
      `update sync_runs set finished_at = now(), status = 'failed', error_message = $2 where id = $1`,
      [runId, err.message],
    );
    throw err;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runSync();
    console.log(`\nsync ${result.status}: ${result.txns_inserted} new, ${result.txns_updated} updated`);
    if (result.failures.length) process.exitCode = 1;
  } catch (err) {
    console.error(`sync failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
