// Stage 5: email alerts.
//
// Runs at the end of every sync. Each check produces an alert with a dedupe key
// that only changes when the situation meaningfully changes, so a standing
// problem is reported once rather than twice a day, and a worsening one is
// reported again.
import { query, withTransaction } from './db.js';
import { forecast } from './forecast.js';
import { currentPeriod, periodState } from './buckets.js';
import { sendEmail } from './email.js';

// How long the same alert stays quiet once it has been sent.
const COOLDOWN_DAYS = 3;

export async function getSettings(client = { query }) {
  const { rows } = await client.query('select * from alert_settings where id');
  return rows[0] ?? null;
}

export async function updateSettings(patch, client = { query }) {
  const { rows } = await client.query(
    `update alert_settings set
       enabled                  = coalesce($1, enabled),
       email_to                 = coalesce($2, email_to),
       runway_days_threshold    = coalesce($3, runway_days_threshold),
       large_transaction_amount = coalesce($4, large_transaction_amount),
       notify_bucket_overspend  = coalesce($5, notify_bucket_overspend),
       notify_sync_failure      = coalesce($6, notify_sync_failure),
       notify_unreviewed        = coalesce($7, notify_unreviewed),
       updated_at               = now()
     where id
     returning *`,
    [
      patch.enabled ?? null,
      patch.email_to ?? null,
      patch.runway_days_threshold ?? null,
      patch.large_transaction_amount ?? null,
      patch.notify_bucket_overspend ?? null,
      patch.notify_sync_failure ?? null,
      patch.notify_unreviewed ?? null,
    ],
  );
  return rows[0];
}

const money = (value) => {
  const text = String(value ?? '0');
  const negative = text.startsWith('-');
  const [whole, fraction = '00'] = (negative ? text.slice(1) : text).split('.');
  return `${negative ? '-' : ''}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction.padEnd(2, '0')}`;
};

// Works out what is worth saying right now. Pure reporting, writes nothing.
export async function evaluateAlerts(options = {}) {
  const client = options.client ?? { query };
  const settings = options.settings ?? (await getSettings(client));
  if (!settings) return [];

  const alerts = [];

  // 1. Runway is getting short.
  const projection = await forecast({ days: 180, client });
  if (projection.runway_days !== null && projection.runway_days <= settings.runway_days_threshold) {
    alerts.push({
      kind: 'runway',
      // Bucketed into weeks, so a slowly worsening runway re-alerts but a
      // steady one does not nag every day.
      dedupe_key: `week:${Math.floor(projection.runway_days / 7)}`,
      subject: `Cash runs low in ${projection.runway_days} days`,
      body: [
        `Spendable cash today is ${money(projection.opening_balance)}.`,
        `At the current rate it reaches zero on ${projection.runway_date}, in ${projection.runway_days} days.`,
        '',
        `Income expected: ${money(projection.expected_income.amount)} each ${projection.cycle?.cadence ?? 'period'}.`,
        `Everyday spending: ${money(projection.everyday_rate.per_day)} a day.`,
        `Committed outgoings over the last ${projection.everyday_rate.days} days: ${money(projection.everyday_rate.committed)}.`,
        '',
        `Lowest point in the next 180 days: ${money(projection.lowest_balance)} on ${projection.lowest_date}.`,
      ].join('\n'),
    });
  }

  // 2. A bucket has gone over for this period.
  if (settings.notify_bucket_overspend) {
    const period = await currentPeriod(client);
    if (period) {
      const state = await periodState(period.id, client);
      const over = (state?.buckets ?? []).filter((bucket) => Number(bucket.remaining) < 0);
      if (over.length) {
        alerts.push({
          kind: 'bucket_overspend',
          // Keyed on the period and which buckets, so a new bucket going over
          // is a fresh alert.
          dedupe_key: `${period.id}:${over.map((b) => b.name).sort().join(',')}`,
          subject: over.length === 1 ? `${over[0].name} is over budget` : `${over.length} buckets are over budget`,
          body: [
            `For the period ${state.period.starts_on} to ${state.period.ends_on}:`,
            '',
            ...over.map((bucket) => `  ${bucket.name}: ${money(bucket.remaining)} (allocated ${money(bucket.allocated)}, spent ${money(bucket.spent)})`),
            '',
            `Still to allocate this period: ${money(state.to_allocate)}.`,
          ].join('\n'),
        });
      }
    }
  }

  // 3. A transaction larger than usual landed.
  const { rows: large } = await client.query(
    `select t.id, t.txn_date, coalesce(t.display_description, t.description) as label, t.amount,
            a.bank, a.masked_number
       from budget_flows t
       join accounts a on a.id = t.account_id
      where t.counts and t.amount < 0
        and -t.amount >= $1
        and t.txn_date >= current_date - 3
      order by t.amount
      limit 10`,
    [settings.large_transaction_amount],
  );
  for (const txn of large) {
    alerts.push({
      kind: 'large_transaction',
      dedupe_key: txn.id,
      subject: `${money(txn.amount)} at ${txn.label}`.slice(0, 120),
      body: [
        `${txn.txn_date}: ${txn.label}`,
        `${money(txn.amount)} from ${txn.bank} ${txn.masked_number ?? ''}`.trim(),
        '',
        `This is at or above your ${money(settings.large_transaction_amount)} threshold.`,
      ].join('\n'),
    });
  }

  // 4. The last sync did not go well.
  if (settings.notify_sync_failure) {
    const { rows } = await client.query(
      `select id, status, error_message, started_at from sync_runs
        where status in ('failed', 'partial')
        order by started_at desc limit 1`,
    );
    const run = rows[0];
    if (run) {
      const recent = await client.query(
        `select count(*)::int as n from sync_runs
          where status = 'success' and started_at > $1`,
        [run.started_at],
      );
      // Only complain while it is still broken.
      if (recent.rows[0].n === 0) {
        alerts.push({
          kind: 'sync_failure',
          dedupe_key: run.id,
          subject: `Bank sync ${run.status}`,
          body: [`The sync that started at ${run.started_at.toISOString()} finished as ${run.status}.`, '', run.error_message ?? ''].join('\n'),
        });
      }
    }
  }

  // 5. Things are waiting to be reviewed.
  if (settings.notify_unreviewed) {
    const { rows } = await client.query(`
      select
        (select count(*) from transactions where is_transfer and transfer_confidence = 'auto')::int as transfers,
        (select count(*) from transactions where category_id is null and not is_transfer)::int as uncategorised
    `);
    const { transfers, uncategorised } = rows[0];
    if (transfers >= 10 || uncategorised >= 25) {
      alerts.push({
        kind: 'needs_review',
        // Bucketed in tens, so it re-alerts as the pile grows.
        dedupe_key: `t${Math.floor(transfers / 10)}:u${Math.floor(uncategorised / 25)}`,
        subject: 'Some transactions are waiting for you',
        body: [
          `${transfers} auto detected transfers have not been confirmed.`,
          `${uncategorised} transactions have no category.`,
          '',
          'Both are on the app, under Transfers and Transactions.',
        ].join('\n'),
      });
    }
  }

  return alerts;
}

// Has this exact alert gone out recently?
async function recentlySent(client, kind, dedupeKey) {
  const { rows } = await client.query(
    `select 1 from alert_log
      where kind = $1 and dedupe_key = $2 and status = 'sent'
        and created_at > now() - ($3::integer * interval '1 day')
      limit 1`,
    [kind, dedupeKey, COOLDOWN_DAYS],
  );
  return rows.length > 0;
}

// Evaluates, then sends what is new. Returns how many went out.
export async function runAlerts(options = {}) {
  const run = async (client) => {
    const settings = await getSettings(client);
    if (!settings) return { sent: 0, considered: 0 };

    const alerts = await evaluateAlerts({ client, settings });
    let sent = 0;

    for (const alert of alerts) {
      if (await recentlySent(client, alert.kind, alert.dedupe_key)) continue;

      let status = 'suppressed';
      let error = 'Alerts are switched off.';
      if (settings.enabled) {
        const result = await (options.send ?? sendEmail)(
          { to: settings.email_to, subject: alert.subject, text: alert.body },
          options,
        );
        status = result.status;
        error = result.error;
      }

      await client.query(
        `insert into alert_log (kind, dedupe_key, subject, body, status, error, sent_at)
         values ($1,$2,$3,$4,$5,$6, case when $5 = 'sent' then now() else null end)`,
        [alert.kind, alert.dedupe_key, alert.subject, alert.body, status, error],
      );
      if (status === 'sent') sent++;
    }

    return { sent, considered: alerts.length };
  };

  if (options.client) return run(options.client);
  return withTransaction(run, options.pool);
}
