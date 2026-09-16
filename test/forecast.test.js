// Stages 4 and 5: commitments, the forecast and the runway, and alerts.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getTestPool, resetDatabase, closeTestPool, makeAccount } from './helpers.js';
import { assessSchedule, matchKeyFor, detectCommitments, median, medianCents } from '../src/commitments.js';
import { forecast, liquidBalance, everydaySpendRate } from '../src/forecast.js';
import { setPayCycle, ensurePayPeriods } from '../src/buckets.js';
import { evaluateAlerts, runAlerts, updateSettings } from '../src/alerts.js';
import { sendEmail } from '../src/email.js';
import { centsToNumeric, numericToCents } from '../src/money.js';
import { daysAgo, addDays, today } from '../src/dates.js';

beforeEach(async () => {
  const pool = await resetDatabase();
  await pool.query(
    'truncate alert_log, commitments, expected_income, assets, bucket_allocations, bucket_categories, buckets, pay_periods, pay_cycle, rules, provider_category_map, categories cascade',
  );
  await pool.query('update alert_settings set enabled = false, email_to = null');
  return pool;
});
after(closeTestPool);


async function addTxn(pool, accountId, { date, cents, description = 'TEST', categoryId = null }) {
  const { rows } = await pool.query(
    `insert into transactions (account_id, redbark_txn_id, status, txn_date, description, amount, category_id, raw)
     values ($1,$2,'posted',$3,$4,$5,$6,'{}'::jsonb) returning id`,
    [accountId, `txn_${Math.random().toString(36).slice(2, 14)}`, date, description, centsToNumeric(cents), categoryId],
  );
  return rows[0].id;
}

async function setBalance(pool, accountId, cents) {
  await pool.query(
    `insert into balances (account_id, balance_date, balance) values ($1, current_date, $2)
     on conflict (account_id, balance_date) do update set balance = excluded.balance`,
    [accountId, centsToNumeric(cents)],
  );
}

// --- commitments ---------------------------------------------------------

test('median is exact for odd and even counts', () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), 0);
});

test('a regular monthly bill is recognised', () => {
  const schedule = assessSchedule(['2026-01-05', '2026-02-04', '2026-03-06', '2026-04-05']);
  assert.ok(schedule);
  assert.ok(Math.abs(schedule.cadence_days - 30) <= 2);
  assert.equal(schedule.occurrences, 4);
  assert.equal(schedule.last_seen, '2026-04-05');
});

test('irregular shopping is not a commitment', () => {
  // Aldi forty times a year, at no particular spacing.
  const dates = ['2026-01-02', '2026-01-03', '2026-01-19', '2026-02-11', '2026-02-12', '2026-03-30'];
  assert.equal(assessSchedule(dates), null);
});

test('three occurrences at a long spacing are not a quarterly bill', () => {
  // Two petrol fills happening to be four months apart proves nothing.
  assert.equal(assessSchedule(['2026-01-10', '2026-05-10', '2026-09-08']), null);
  // Four of them, on the other hand, is a pattern.
  assert.ok(assessSchedule(['2026-01-10', '2026-04-10', '2026-07-10', '2026-10-09']));
});

test('too few occurrences are never a commitment', () => {
  assert.equal(assessSchedule(['2026-01-05', '2026-02-04']), null);
});

test('the match key is stable when the bank appends a reference', () => {
  assert.equal(matchKeyFor('SYNERGY 123456789'), matchKeyFor('SYNERGY 987654321'));
  assert.notEqual(matchKeyFor('SYNERGY RETAIL'), matchKeyFor('WATER CORPORATION WA'));
});

test('detection finds a bill and tracks a change in its amount', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);

  // Nine months of a bill that went up part way through.
  for (let i = 12; i >= 0; i--) {
    await addTxn(pool, account.id, {
      date: daysAgo(i * 30),
      cents: i >= 6 ? -16550 : -18000,
      description: 'DIRECT DEBIT 000650 COMMONWEALTH BNK LN REPAY',
    });
  }
  // Plus irregular shopping that must not be picked up.
  for (const day of [3, 4, 19, 44, 45, 90]) {
    await addTxn(pool, account.id, { date: daysAgo(day), cents: -4200, description: 'ALDI STORES 1234' });
  }

  const found = await detectCommitments({ pool });
  assert.ok(found >= 1);

  const { rows } = await pool.query('select label, typical_amount, cadence_days from commitments where active');
  assert.equal(rows.length, 1, 'the irregular shopping is not a commitment');
  assert.equal(
    numericToCents(rows[0].typical_amount),
    -18000,
    'the typical amount follows the recent figure, not a median of the whole year',
  );
});

test('a commitment that stopped happening is stood down', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  // A monthly bill that last appeared five months ago.
  for (let i = 0; i < 4; i++) {
    await addTxn(pool, account.id, { date: daysAgo(150 + i * 30), cents: -5000, description: 'OLD SUBSCRIPTION CO' });
  }
  await detectCommitments({ pool });
  const { rows } = await pool.query('select active from commitments');
  assert.equal(rows[0].active, false, 'two cycles past due means it has stopped');
});

test('detection leaves a hand entered commitment alone', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  await pool.query(
    `insert into commitments (match_key, label, typical_amount, cadence_days, next_due, source, regularity)
     values ('manual:school fees', 'School fees', -450.00, 90, current_date + 10, 'manual', 1)`,
  );
  for (let i = 0; i < 5; i++) {
    await addTxn(pool, account.id, { date: daysAgo(i * 30), cents: -5000, description: 'SOMETHING REGULAR' });
  }
  await detectCommitments({ pool });
  const { rows } = await pool.query("select label, typical_amount from commitments where source = 'manual'");
  assert.equal(rows.length, 1);
  assert.equal(numericToCents(rows[0].typical_amount), -45000);
});

// --- forecast ------------------------------------------------------------

test('only liquid accounts count towards spendable cash', async () => {
  const pool = await getTestPool();
  const everyday = await makeAccount(pool, { masked_number: 'xxxx9529', is_liquid: true });
  const savings = await makeAccount(pool, { masked_number: 'xxxx4047', is_liquid: true });
  const loan = await makeAccount(pool, { masked_number: 'xxxx0194', type: 'loan', is_liquid: false });

  await setBalance(pool, everyday.id, 97063);
  await setBalance(pool, savings.id, 1776882);
  // A big redraw available on the loan, which must not look like money we have.
  await setBalance(pool, loan.id, -60272035);

  const balance = await liquidBalance(pool);
  assert.equal(numericToCents(balance.total), 97063 + 1776882);
  assert.equal(balance.accounts.length, 2);
});

test('the everyday rate excludes what is already a tracked commitment', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);

  // A monthly bill, plus everyday spending.
  for (let i = 0; i < 3; i++) {
    await addTxn(pool, account.id, { date: daysAgo(i * 30), cents: -30000, description: 'SYNERGY RETAIL 123' });
  }
  for (let i = 0; i < 90; i += 3) {
    await addTxn(pool, account.id, { date: daysAgo(i), cents: -3000, description: `SHOP ${i}` });
  }

  await detectCommitments({ pool });
  const rate = await everydaySpendRate(90, pool);

  assert.ok(numericToCents(rate.committed) > 0, 'the bill should be recognised as committed');
  assert.equal(
    numericToCents(rate.total) - numericToCents(rate.committed),
    numericToCents(rate.everyday),
    'everyday is what is left once commitments are taken out',
  );
});

test('the runway is the day spendable cash first goes under', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 100000); // $1000

  // Spend $100 a day for the last 100 days, so the rate is a clean $100.
  for (let i = 1; i <= 100; i++) {
    await addTxn(pool, account.id, { date: daysAgo(i), cents: -10000, description: `DAY ${i}` });
  }
  // No income, so nothing tops it back up.
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });

  const projection = await forecast({ days: 30, client: pool });
  assert.ok(projection.runway_days !== null, 'it should run out inside the window');
  // $1000 at $100 a day is ten days.
  assert.ok(Math.abs(projection.runway_days - 10) <= 1, `expected about 10 days, got ${projection.runway_days}`);
  assert.equal(projection.series.length, 31);
  assert.equal(numericToCents(projection.opening_balance), 100000);
});

test('income on payday pushes the runway out', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 100000);
  for (let i = 1; i <= 100; i++) {
    await addTxn(pool, account.id, { date: daysAgo(i), cents: -10000, description: `DAY ${i}` });
  }

  await setPayCycle('weekly', daysAgo(7), '500', pool); // $500 a week
  await ensurePayPeriods({ pool });

  const projection = await forecast({ days: 60, client: pool });
  assert.ok(projection.paydays.length > 0, 'there should be paydays in the window');
  // Still short of $100 a day, but it lasts longer than the ten bare days.
  assert.ok(projection.runway_days > 10, `income should extend the runway, got ${projection.runway_days}`);
});

test('a buffer brings the runway forward', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 100000);
  for (let i = 1; i <= 100; i++) {
    await addTxn(pool, account.id, { date: daysAgo(i), cents: -10000, description: `DAY ${i}` });
  }
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });

  const bare = await forecast({ days: 30, client: pool });
  const buffered = await forecast({ days: 30, buffer: 500, client: pool });
  assert.ok(buffered.runway_days < bare.runway_days, 'keeping $500 back means running out sooner');
});

// --- alerts --------------------------------------------------------------

test('email refuses to send when it is not configured, and never throws', async () => {
  const result = await sendEmail(
    { to: 'someone@example.com', subject: 'x', text: 'y' },
    { config: { configured: false } },
  );
  assert.equal(result.status, 'skipped');
  assert.match(result.error, /not configured/);
});

test('a provider failure is reported without throwing', async () => {
  const result = await sendEmail(
    { to: 'someone@example.com', subject: 'x', text: 'y' },
    {
      config: { configured: true, apiKey: 'k', from: 'a@b.c', apiUrl: 'https://example.invalid' },
      fetch: async () => ({ ok: false, status: 502 }),
    },
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error, /502/);
});

test('a short runway raises an alert', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 50000);
  for (let i = 1; i <= 100; i++) {
    await addTxn(pool, account.id, { date: daysAgo(i), cents: -10000, description: `DAY ${i}` });
  }
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });

  const alerts = await evaluateAlerts({ client: pool });
  const runway = alerts.find((alert) => alert.kind === 'runway');
  assert.ok(runway, 'a five day runway should be reported');
  assert.match(runway.subject, /runs low/i);
});

test('a large transaction is flagged once, not on every run', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 500000);
  await addTxn(pool, account.id, { date: daysAgo(1), cents: -120000, description: 'BIG PURCHASE' });
  await updateSettings({ enabled: true, email_to: 'test@example.com' }, pool);

  const sent = [];
  const send = async (message) => {
    sent.push(message);
    return { status: 'sent', error: null };
  };

  const first = await runAlerts({ client: pool, send });
  assert.ok(first.sent >= 1);
  assert.ok(sent.some((message) => message.subject.includes('BIG PURCHASE')));

  // Nothing has changed, so a second run must stay quiet.
  const before = sent.length;
  const second = await runAlerts({ client: pool, send });
  assert.equal(second.sent, 0, 'the same alert must not be sent twice');
  assert.equal(sent.length, before);
});

test('alerts are recorded but suppressed while they are switched off', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 500000);
  await addTxn(pool, account.id, { date: daysAgo(1), cents: -120000, description: 'BIG PURCHASE' });
  await updateSettings({ enabled: false }, pool);

  const result = await runAlerts({ client: pool, send: async () => ({ status: 'sent', error: null }) });
  assert.equal(result.sent, 0);

  const { rows } = await pool.query('select status from alert_log');
  assert.ok(rows.length > 0, 'it is still recorded, so you can see what would have gone out');
  assert.ok(rows.every((row) => row.status === 'suppressed'));
});

test('a failed send is recorded as failed rather than lost', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 500000);
  await addTxn(pool, account.id, { date: daysAgo(1), cents: -120000, description: 'BIG PURCHASE' });
  await updateSettings({ enabled: true, email_to: 'test@example.com' }, pool);

  await runAlerts({ client: pool, send: async () => ({ status: 'failed', error: 'provider said no' }) });
  const { rows } = await pool.query("select status, error from alert_log where status = 'failed'");
  assert.ok(rows.length > 0);
  assert.match(rows[0].error, /provider said no/);
});

// --- what counts as spending --------------------------------------------

test('interest charged to the mortgage is not household spending', async () => {
  const pool = await getTestPool();
  const everyday = await makeAccount(pool, { masked_number: 'xxxx9529', is_liquid: true });
  const loan = await makeAccount(pool, { masked_number: 'xxxx0194', type: 'loan', is_liquid: false });

  // A real purchase from the everyday account, and interest charged to the
  // loan. Only the first is cash leaving the household.
  await addTxn(pool, everyday.id, { date: daysAgo(5), cents: -5000, description: 'SHOP' });
  await addTxn(pool, loan.id, { date: daysAgo(5), cents: -319731, description: 'Interest charged' });
  await addTxn(pool, loan.id, { date: daysAgo(6), cents: -39500, description: 'Package Fee' });

  const { rows } = await pool.query(
    'select coalesce(sum(-amount), 0) as spent from budget_flows where counts and amount < 0',
  );
  assert.equal(
    numericToCents(rows[0].spent),
    5000,
    'interest and fees charged to the loan change what is owed, they are not cash going out',
  );
});

test('a repayment into the loan is still counted, because that cash does leave', async () => {
  const pool = await getTestPool();
  const everyday = await makeAccount(pool, { masked_number: 'xxxx9529', is_liquid: true });
  const loan = await makeAccount(pool, { masked_number: 'xxxx0194', type: 'loan', is_liquid: false });

  const out = await addTxn(pool, everyday.id, { date: daysAgo(3), cents: -180000, description: 'LN REPAY' });
  const into = await addTxn(pool, loan.id, { date: daysAgo(3), cents: 180000, description: 'Repayment/Payment' });
  await pool.query('update transactions set is_transfer = true, transfer_pair_id = $2 where id = $1', [out, into]);
  await pool.query('update transactions set is_transfer = true, transfer_pair_id = $2 where id = $1', [into, out]);

  const { rows } = await pool.query(
    'select coalesce(sum(-amount), 0) as spent from budget_flows where counts and amount < 0',
  );
  assert.equal(numericToCents(rows[0].spent), 180000, 'only the side leaving the spendable account counts');
});

// --- levers the forecast can pull ----------------------------------------

test('expected income that has not started yet extends the runway', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 100000);
  for (let i = 1; i <= 100; i++) {
    await addTxn(pool, account.id, { date: daysAgo(i), cents: -10000, description: `DAY ${i}` });
  }
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });

  const bare = await forecast({ days: 120, client: pool });

  await pool.query(
    `insert into expected_income (label, amount, cadence_days, starts_on, confidence)
     values ('A job starting', 500, 7, current_date + 3, 'likely')`,
  );
  const withJob = await forecast({ days: 120, client: pool });
  assert.ok(
    withJob.runway_days > bare.runway_days,
    `income starting soon should extend the runway, ${bare.runway_days} to ${withJob.runway_days}`,
  );

  // The honest version, without the money that is only hoped for.
  const confirmedOnly = await forecast({ days: 120, client: pool, includeConfidence: ['confirmed'] });
  assert.equal(confirmedOnly.runway_days, bare.runway_days, 'a likely stream is excluded when only confirmed is asked for');
});

test('a one off purchase can be tested without storing anything', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 500000);
  for (let i = 1; i <= 100; i++) {
    await addTxn(pool, account.id, { date: daysAgo(i), cents: -10000, description: `DAY ${i}` });
  }
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });

  const before = await forecast({ days: 120, client: pool });
  const after = await forecast({
    days: 120,
    client: pool,
    extraEvents: [{ date: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10), label: 'Bike', amount: -2000 }],
  });

  assert.ok(after.runway_days < before.runway_days, 'spending $2000 should bring the runway forward');
  const { rows } = await pool.query('select count(*)::int as n from transactions');
  assert.equal(rows[0].n, 100, 'a scenario must not write anything');
});


// --- exactness and recency -----------------------------------------------

test('the typical amount is a real observed value in whole cents, never a half cent average', () => {
  assert.equal(medianCents([100, 300]), 100, 'an even count takes the lower middle, not 200 by averaging');
  assert.equal(medianCents([100, 200, 300]), 200);
  assert.equal(medianCents([-1800, -1655, -1800, -1800]), -1800);
  assert.equal(medianCents([]), 0);
});

test('the forecast refuses a float amount rather than rounding it', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 100000);
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });
  await assert.rejects(
    () => forecast({ days: 30, client: pool, extraEvents: [{ date: daysAgo(-3), label: 'x', amount: 12.345 }] }),
    /float/,
  );
});

test('spendable cash adds awkward cents exactly', async () => {
  const pool = await getTestPool();
  const a = await makeAccount(pool, { masked_number: 'xxxx1111', is_liquid: true });
  const b = await makeAccount(pool, { masked_number: 'xxxx2222', is_liquid: true });
  const c = await makeAccount(pool, { masked_number: 'xxxx3333', is_liquid: true });
  await setBalance(pool, a.id, 10);
  await setBalance(pool, b.id, 20);
  await setBalance(pool, c.id, 97063);
  const balance = await liquidBalance(pool);
  assert.equal(balance.total, '970.93');
});

test('the everyday rate follows the window, and recent is the default', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 1000000);
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });

  // Heavy spending two months ago, quiet lately. A long window blends the two,
  // the recent window sees the quiet month, which is the better guide.
  for (let i = 31; i <= 90; i++) await addTxn(pool, account.id, { date: daysAgo(i), cents: -30000, description: `OLD ${i}` });
  for (let i = 1; i <= 30; i++) await addTxn(pool, account.id, { date: daysAgo(i), cents: -5000, description: `NEW ${i}` });

  const recent = await everydaySpendRate(30, pool);
  const long = await everydaySpendRate(90, pool);
  assert.equal(numericToCents(recent.per_day), 5000);
  assert.ok(numericToCents(long.per_day) > 5000, 'ninety days still carries the old spending');

  const projection = await forecast({ days: 30, client: pool });
  assert.equal(projection.spend_window_days, 30, 'thirty days is the default');
  assert.equal(projection.rate_by_window[90].per_day, long.per_day, 'the other windows are reported alongside');
});

test('today is the household day, not the UTC day', () => {
  // At 20:00 UTC on the 27th it is already the 28th in Perth, which matters on
  // payday.
  const late = new Date('2026-09-27T20:00:00Z');
  assert.equal(today(late), '2026-09-28');
  const early = new Date('2026-09-27T10:00:00Z');
  assert.equal(today(early), '2026-09-27');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
});

test('the database clock agrees with the household clock', async () => {
  const pool = await getTestPool();
  const { rows } = await pool.query('select current_date::text as db_today');
  assert.equal(rows[0].db_today, today(), 'the connection is set to the household time zone');
});
