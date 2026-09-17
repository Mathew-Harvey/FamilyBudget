// Stages 4 and 5: commitments, the forecast and the runway, and alerts.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getTestPool, resetDatabase, closeTestPool, makeAccount } from './helpers.js';
import { assessSchedule, matchKeyFor, detectCommitments, median, medianCents, scheduleCommitments } from '../src/commitments.js';
import { forecast, liquidBalance, everydaySpendRate } from '../src/forecast.js';
import { setPayCycle, ensurePayPeriods } from '../src/buckets.js';
import { coveredDays, effectiveWindowDays, buildCostModel, optionalByMonth } from '../src/costs.js';
import { evaluateAlerts, runAlerts, updateSettings } from '../src/alerts.js';
import { sendEmail } from '../src/email.js';
import { centsToNumeric, numericToCents } from '../src/money.js';
import { daysAgo, addDays, today } from '../src/dates.js';

beforeEach(async () => {
  const pool = await resetDatabase();
  await pool.query('update alert_settings set enabled = false, email_to = null');
  return pool;
});
after(closeTestPool);


async function addTxn(pool, accountId, { date, cents, description = 'TEST', categoryId = null, merchantKey = null }) {
  const { rows } = await pool.query(
    `insert into transactions (account_id, redbark_txn_id, status, txn_date, description, amount, category_id, merchant_key, raw)
     values ($1,$2,'posted',$3,$4,$5,$6,$7,'{}'::jsonb) returning id`,
    [accountId, `txn_${Math.random().toString(36).slice(2, 14)}`, date, description, centsToNumeric(cents), categoryId, merchantKey],
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

async function classifyTestSpendingAsEssential(pool) {
  const { rows: [category] } = await pool.query(
    `insert into categories (name, kind, lean_tier)
     values ('Test essentials', 'expense', 'trim')
     returning id`,
  );
  await pool.query(
    `update transactions
        set category_id = $1, merchant_key = coalesce(merchant_key, 'TEST ESSENTIAL')
      where amount < 0 and category_id is null`,
    [category.id],
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
     values ('SCHOOL FEES', 'School fees', -450.00, 90, current_date + 10, 'manual', 1)`,
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
  await classifyTestSpendingAsEssential(pool);
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
  await classifyTestSpendingAsEssential(pool);

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
  await classifyTestSpendingAsEssential(pool);
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
  await classifyTestSpendingAsEssential(pool);
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
  await classifyTestSpendingAsEssential(pool);
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
  await classifyTestSpendingAsEssential(pool);
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

  // A renovation sized burst six months back, ordinary spending since. The
  // long window drags it in, the default window does not, which is the whole
  // point of the default.
  for (let i = 150; i <= 200; i++) await addTxn(pool, account.id, { date: daysAgo(i), cents: -30000, description: `RENO ${i}` });
  // Spending from today back, so the window has a full set of days to divide
  // by. The window is the last N days counting today, the same span the
  // Spending page uses, so a fixture that starts yesterday leaves one day empty
  // and the rate is honestly a day's worth lower.
  for (let i = 0; i <= 130; i++) await addTxn(pool, account.id, { date: daysAgo(i), cents: -5000, description: `NORMAL ${i}` });
  await classifyTestSpendingAsEssential(pool);

  const recent = await everydaySpendRate(120, pool);
  const long = await everydaySpendRate(365, pool);
  assert.equal(numericToCents(recent.per_day), 5000, 'the default window sees only the ordinary spending');
  assert.ok(numericToCents(long.per_day) > 5000, 'a year still carries the renovation');

  const projection = await forecast({ days: 30, client: pool });
  assert.equal(projection.spend_window_days, 120, 'four months is the default, and scripts/backtest.js says why');
  assert.equal(numericToCents(projection.everyday_rate.per_day), 5000);
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

// --- prediction accuracy fixes -------------------------------------------

test('a one off is left out of the rate but kept in the totals', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 1000000);
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });

  for (let i = 0; i <= 59; i++) await addTxn(pool, account.id, { date: daysAgo(i), cents: -5000, description: `NORMAL ${i}` });
  const reno = await addTxn(pool, account.id, { date: daysAgo(10), cents: -3000000, description: 'BIG RENO' });

  const before = await everydaySpendRate(60, pool);
  assert.ok(numericToCents(before.per_day) > 5000, 'while it counts, one purchase sets the rate');

  await pool.query('update transactions set one_off = true where id = $1', [reno]);
  const after = await everydaySpendRate(60, pool);
  assert.equal(numericToCents(after.per_day), 5000, 'marked as a one off, it stops setting the rate');
  assert.equal(numericToCents(after.not_expected_again), 3000000, 'and it is still reported, not hidden');

  // It is still spending: every total and the Spending page must still show it.
  const { rows } = await pool.query(
    'select coalesce(sum(-amount),0) as spent from budget_flows where counts and amount < 0',
  );
  assert.equal(numericToCents(rows[0].spent), 3000000 + 60 * 5000);
});

test('the rate divides by the days we have history for, not the days asked for', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 100000);
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });

  // Thirty days of history, asked for over a hundred and twenty.
  for (let i = 0; i <= 29; i++) await addTxn(pool, account.id, { date: daysAgo(i), cents: -10000, description: `DAY ${i}` });

  const rate = await everydaySpendRate(120, pool);
  assert.equal(rate.effective_days, 30, 'only thirty days could have been observed');
  assert.equal(numericToCents(rate.per_day), 10000, 'so the rate is a hundred a day, not a quarter of it');
});

test('a household already under its buffer has no runway left, not an unlimited one', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 50000); // $500
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });
  for (let i = 0; i <= 59; i++) await addTxn(pool, account.id, { date: daysAgo(i), cents: -1000, description: `DAY ${i}` });

  const projection = await forecast({ days: 30, buffer: '1000.00', client: pool });
  assert.equal(projection.runway_days, 0, 'it is already below the buffer today');
  assert.equal(projection.runway_date, today());
});

test('a pay period that brought in nothing counts as a zero, not as missing', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 100000);
  const { rows: [income] } = await pool.query(
    "insert into categories (name, kind) values ('Salary','income') returning id",
  );
  await setPayCycle('monthly', daysAgo(120), null, pool);
  await ensurePayPeriods({ pool });

  // Paid in the oldest period only, then the income stopped. Two of the three
  // completed periods brought in nothing, so the median has to be nothing.
  // Before the fix the empty periods were dropped from the set entirely and the
  // only survivor was the one that got paid, so a lost job read as full pay.
  await addTxn(pool, account.id, { date: daysAgo(100), cents: 400000, description: 'PAY', categoryId: income.id });

  const projection = await forecast({ days: 30, client: pool });
  assert.equal(
    numericToCents(projection.expected_income.amount), 0,
    'the empty periods have to count, or losing an income is invisible',
  );
});

test('a stale opening balance is reported rather than quietly trusted', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await pool.query(
    `insert into balances (account_id, balance_date, balance) values ($1, current_date - 9, '500.00')`,
    [account.id],
  );
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });
  const projection = await forecast({ days: 30, client: pool });
  assert.ok(
    projection.warnings.some((warning) => warning.kind === 'stale_balance'),
    'nine days old is old enough to say so',
  );
});

test('a merchant finished with leaves the rate but stays in the history', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 1000000);
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });

  for (let i = 0; i <= 59; i++) {
    await addTxn(pool, account.id, { date: daysAgo(i), cents: -5000, description: `NORMAL ${i}` });
  }
  // An insurer paid monthly, then changed.
  for (const i of [5, 35, 55]) {
    await addTxn(pool, account.id, { date: daysAgo(i), cents: -60000, description: 'OLD INSURER', merchantKey: 'OLD INSURER' });
  }
  await pool.query("insert into merchants (match_key, display_name, source) values ('OLD INSURER','Old insurer','auto')");

  const before = await everydaySpendRate(60, pool);
  assert.ok(numericToCents(before.per_day) > 5000, 'while it runs, it sets the rate');

  await pool.query("update merchants set ended_on = current_date where match_key = 'OLD INSURER'");
  const after = await everydaySpendRate(60, pool);
  assert.equal(numericToCents(after.per_day), 5000, 'cancelled, it stops being a guide to next month');
  assert.equal(numericToCents(after.not_expected_again), 180000, 'and it is reported, not hidden');

  // It really happened, so every total still has it.
  const { rows } = await pool.query(
    'select coalesce(sum(-amount),0) as spent from budget_flows where counts and amount < 0',
  );
  assert.equal(numericToCents(rows[0].spent), 180000 + 60 * 5000);
});

test('detection does not resurrect a merchant that was finished with', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  for (const i of [5, 35, 65, 95]) {
    await addTxn(pool, account.id, { date: daysAgo(i), cents: -60000, description: 'OLD INSURER MONTHLY', merchantKey: 'OLD INSURER' });
  }
  await pool.query("insert into merchants (match_key, display_name, source) values ('OLD INSURER','Old insurer','auto')");

  await detectCommitments({ client: pool });
  const { rows: found } = await pool.query("select active from commitments where match_key = $1", [matchKeyFor('OLD INSURER MONTHLY')]);
  assert.equal(found.length, 1, 'a monthly bill is detected');

  // Cancelled, then the next sync runs. Without the guard, the premiums still
  // in the lookback would make it a live commitment again every time.
  await pool.query("update merchants set ended_on = current_date where match_key = 'OLD INSURER'");
  await pool.query('update commitments set active = false');
  await detectCommitments({ client: pool });
  const { rows: after } = await pool.query("select active from commitments where match_key = $1", [matchKeyFor('OLD INSURER MONTHLY')]);
  assert.equal(after[0].active, false, 'it stays cancelled');
});

test('a detected commitment whose key no longer matches anything is stood down', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  for (const i of [5, 35, 65]) {
    await addTxn(pool, account.id, { date: daysAgo(i), cents: -20000, description: 'REAL BILL MONTHLY' });
  }
  // A leftover from before the key definition changed. Its last_seen is recent,
  // so the two cycles of grace never expires it, and it is projected forward
  // while the same spending is also counted as everyday: double counted.
  await pool.query(
    `insert into commitments (match_key, label, typical_amount, cadence_days, next_due,
                              occurrences, regularity, source, active)
     values ('KEY FROM AN OLDER DEFINITION', 'Stale', '-43.71', 30, current_date, 5, 1, 'detected', true)`,
  );
  await detectCommitments({ client: pool });

  const { rows } = await pool.query(
    "select active from commitments where match_key = 'KEY FROM AN OLDER DEFINITION'",
  );
  assert.equal(rows[0].active, false, 'nothing matches it, so it is stale rather than late');

  // And a manual one is left alone: it may be a future expense someone accepted.
  await pool.query(
    `insert into commitments (match_key, label, typical_amount, cadence_days, next_due,
                              occurrences, regularity, source, active)
     values ('NOT YET HAPPENED', 'A planned expense', '-100.00', 30, current_date + 30, 1, 1, 'manual', true)`,
  );
  await detectCommitments({ client: pool });
  const { rows: manual } = await pool.query("select active from commitments where match_key = 'NOT YET HAPPENED'");
  assert.equal(manual[0].active, true, 'a manual commitment is theirs, not detection to overrule');
});

test('the forecast can use necessities plus a chosen discretionary allowance', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 1000000);
  await setPayCycle('monthly', daysAgo(400), '0', pool);

  const { rows: [essential] } = await pool.query(
    "insert into categories (name, kind, lean_tier) values ('Groceries','expense','trim') returning id",
  );
  const { rows: [luxury] } = await pool.query(
    "insert into categories (name, kind, lean_tier) values ('Hobbies','expense','cut') returning id",
  );
  await pool.query(
    "insert into merchants (match_key, display_name, source, lean_tier) values ('PET SHOP','Pet shop','manual','trim')",
  );
  for (let i = 0; i < 30; i++) {
    await addTxn(pool, account.id, {
      date: daysAgo(i), cents: -1000, description: `GROCERIES ${i}`,
      categoryId: essential.id, merchantKey: 'GROCERIES',
    });
    await addTxn(pool, account.id, {
      date: daysAgo(i), cents: -2000, description: `HOBBY ${i}`,
      categoryId: luxury.id, merchantKey: 'HOBBY',
    });
    await addTxn(pool, account.id, {
      date: daysAgo(i), cents: -500, description: `PET FOOD ${i}`,
      categoryId: luxury.id, merchantKey: 'PET SHOP',
    });
  }
  await addTxn(pool, account.id, {
    date: daysAgo(5), cents: -30000, description: 'ONE MEDICAL VISIT',
    categoryId: essential.id, merchantKey: 'ONE MEDICAL VISIT',
  });

  const rate = await everydaySpendRate(30, pool);
  assert.equal(rate.essential_per_day_cents, 2500);
  assert.equal(rate.recurring_essential_per_day_cents, 1500, 'a pet merchant can override its broad category');
  assert.equal(rate.irregular_essential, '300.00', 'one medical visit is reported, not turned into a rate');
  assert.equal(rate.discretionary_per_day_cents, 2000);
  assert.equal(rate.per_day_cents, 4500, 'the current-real-life rate still contains all actual spending');

  const essentialsOnly = await forecast({
    days: 30, window: 30, client: pool, discretionaryCentsPerMonth: 0,
  });
  assert.equal(essentialsOnly.projected_everyday_rate.per_day_cents, 1500);

  const withAllowance = await forecast({
    days: 30, window: 30, client: pool, discretionaryCentsPerMonth: 30440,
  });
  assert.equal(withAllowance.projected_everyday_rate.per_day_cents, 2500);

  await pool.query(
    "insert into settings (key, value) values ('forecast_discretionary_monthly', '304.40')",
  );
  const householdPlan = await forecast({ days: 30, window: 30, client: pool });
  assert.equal(householdPlan.projected_everyday_rate.per_day_cents, 2500);
});

test('a debt repayment remains essential even when its category is unknown', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  const loan = await makeAccount(pool, {
    masked_number: 'xxxx2222', type: 'loan', is_liquid: false,
  });
  await setBalance(pool, account.id, 1000000);
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await pool.query(
    `insert into merchants (match_key, display_name, source, lean_tier, pays_account_id)
     values ('LOAN PAYMENT','Loan payment','manual','cut',$1)`,
    [loan.id],
  );
  for (const day of [2, 15, 29]) {
    await addTxn(pool, account.id, {
      date: daysAgo(day), cents: -10000, description: 'LOAN PAYMENT',
      merchantKey: 'LOAN PAYMENT',
    });
  }

  const rate = await everydaySpendRate(30, pool);
  assert.equal(rate.recurring_essential_per_day_cents, 1000);
  assert.equal(rate.discretionary_per_day_cents, 0);
});

test('a future pay anchor starts full pay there, with a partial pay modeled once', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 100000);

  const fullPayday = addDays(today(), 42);
  const partialPayday = addDays(today(), 12);
  await setPayCycle('monthly', fullPayday, '1000.00', pool);
  await pool.query(
    `insert into expected_income
       (label, amount, cadence_days, starts_on, ends_on, confidence)
     values ('Partial first pay', '250.00', 1, $1, $1, 'confirmed')`,
    [partialPayday],
  );

  const projection = await forecast({ days: 90, client: pool });
  assert.equal(projection.paydays[0], fullPayday);
  assert.ok(projection.paydays.every((date) => date >= fullPayday));
  const partialEvents = projection.series
    .flatMap((point) => point.events)
    .filter((event) => event.kind === 'expected_income');
  assert.equal(partialEvents.length, 1);
  assert.equal(partialEvents[0].amount, '250.00');
});

test('a rate divides by the days there is history for, not the days asked for', async () => {
  // The Spending page divided by the window it asked for while the cost model
  // divided by the days covered, so on a database younger than the window the
  // two pages reported the same spending nearly twice apart: 4,007 a month
  // against 7,873. coveredDays is the one definition both now use.
  assert.equal(coveredDays(daysAgo(74), 120), 75);
  assert.equal(coveredDays(daysAgo(400), 120), 120);
  // Nothing recorded yet: there is no evidence either way, so the window stands.
  assert.equal(coveredDays(null, 120), 120);
  assert.equal(coveredDays(today(), 30), 1);

  const pool = await getTestPool();
  const everyday = await makeAccount(pool, { masked_number: 'xxxx1111', is_liquid: true });
  for (let i = 0; i < 60; i += 2) {
    await addTxn(pool, everyday.id, { date: daysAgo(i), cents: -10000, description: `SHOP ${i}` });
  }
  // 59 days of history read through a 120 day window.
  assert.equal(await effectiveWindowDays(120, pool), 59);
  const rate = await everydaySpendRate(120, pool);
  assert.equal(rate.effective_days, 59);
});

test('a commitment that steps backwards is refused rather than scheduled', async () => {
  // A cadence is how many days forward to the next occurrence. Zero or less
  // walks the scheduling loop backwards instead of ending it: a cadence of -30
  // produced three million events before a Date ran out of range, and every
  // projection filters on cadence_days > 0, so the row was invisible to the
  // forecast while the page went on listing it as active.
  const events = scheduleCommitments(
    [{ id: 'x', label: 'backwards', typical_amount: '-10.00', cadence_days: -30, next_due: addDays(today(), 14) }],
    today(),
    addDays(today(), 90),
  );
  assert.deepEqual(events, []);
  assert.deepEqual(
    scheduleCommitments(
      [{ id: 'x', label: 'nowhere', typical_amount: '-10.00', cadence_days: 0, next_due: today() }],
      today(),
      addDays(today(), 90),
    ),
    [],
  );
});

test('the cadence is how often something happens, not the gap that happens most', async () => {
  // The rate divides by the cadence, so the cadence has to answer "how often",
  // and that is the mean. Gaps are right skewed, nothing can be early by more
  // than the gap and anything can be late, so the median sits below the mean
  // and everything irregular projected high. A fuel stop with these gaps read
  // 446 a month against 237 actually spent.
  const dates = ['2026-01-04', '2026-01-11', '2026-01-18', '2026-02-08',
    '2026-02-15', '2026-03-01', '2026-03-08', '2026-03-15', '2026-04-05'];
  const schedule = assessSchedule(dates);
  // Median gap is 7. The nine charges actually span 91 days over 8 gaps.
  assert.equal(schedule.cadence_days, 11);
  assert.equal(schedule.next_due, '2026-04-16');

  // A bill that really is monthly is unchanged, because for anything regular
  // the two statistics agree.
  const monthly = assessSchedule(['2026-01-08', '2026-02-08', '2026-03-08', '2026-04-08', '2026-05-08']);
  assert.equal(monthly.cadence_days, 30);
  assert.equal(monthly.regularity, 1);

  // Still a gate, not a rate: clustered charges either side of a long silence
  // must not project as something annual.
  assert.equal(assessSchedule(['2026-01-01', '2026-01-02', '2026-01-03']), null);
});

test('a hand entered commitment leaves its own spending out of the everyday rate', async () => {
  // It used to be keyed "manual:<label>" so it could never collide with a
  // detected one. costs.js subtracts a commitment's spending by looking up
  // matchKeyFor(description), which cannot produce a key in that namespace, so
  // a manual commitment for a merchant with real history was projected AND left
  // in the rate. CLAUDE.md's own worked example, entering Suncorp by hand after
  // standing Youi down, has three payments behind it and hit exactly this.
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 500000);
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });
  for (let i = 0; i < 8; i++) {
    await addTxn(pool, account.id, { date: daysAgo(i * 14), cents: -6000, description: 'SUNCORP INSURANCE' });
  }
  await classifyTestSpendingAsEssential(pool);

  const before = await everydaySpendRate(120, pool);
  await pool.query(
    `insert into commitments (match_key, label, typical_amount, cadence_days, next_due, source, regularity)
     values ($1, 'SUNCORP INSURANCE', -60.00, 14, current_date + 7, 'manual', 1)`,
    [matchKeyFor('SUNCORP INSURANCE')],
  );
  const after = await everydaySpendRate(120, pool);

  // The 480 dollars of Suncorp charges move out of everyday and into committed.
  assert.equal(numericToCents(before.committed), 0);
  assert.equal(numericToCents(after.committed), 48000);
  assert.equal(
    numericToCents(before.everyday) - numericToCents(after.everyday), 48000,
    'the everyday rate has to shed exactly what the commitment took on',
  );
  // And the total is untouched, because nothing about the spending changed.
  assert.equal(before.total, after.total);
});

// A date this many whole months back, on the first of that month, so the test
// does not depend on which day of the month it runs.
function firstOfMonthsAgo(back) {
  const [year, month] = today().slice(0, 7).split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 - back, 1));
  return shifted.toISOString().slice(0, 10);
}

test('optional spending is reported month by month, with the running one marked', async () => {
  // The allowance is one number, and one number cannot say whether it is every
  // month or the average of a quiet one and a bad one. Nor can it be compared
  // against a month that is only half over: the current month is always low and
  // holding it up as evidence of a quiet one is how a budget gets set to a
  // figure nobody has ever lived on.
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 500000);

  // Three whole months, and something in this one.
  await addTxn(pool, account.id, { date: firstOfMonthsAgo(3), cents: -10000, description: 'SHOP A' });
  await addTxn(pool, account.id, { date: firstOfMonthsAgo(2), cents: -25000, description: 'SHOP B' });
  await addTxn(pool, account.id, { date: today(), cents: -3000, description: 'SHOP C' });

  const costs = await buildCostModel({ window: 120, client: pool });
  const months = await optionalByMonth(costs, { months: 4, client: pool });

  assert.equal(months.length, 4, 'every month in the span, including the empty one');
  assert.deepEqual(months.map((row) => row.spent), ['100.00', '250.00', '0.00', '30.00']);
  // The first is partial too: history starts inside it, so it is low for a
  // reason that has nothing to do with what the household spent.
  assert.deepEqual(months.map((row) => row.complete), [false, true, true, false]);
  assert.equal(months.at(-1).month, today().slice(0, 7));
});

test('a month is only whole when there was a whole month of history behind it', async () => {
  // The earliest month is whenever the bank's history happens to start, so it
  // is low for a reason that has nothing to do with the household. Offering it
  // as "the quietest month" would be offering a gap in the data as an example
  // to live up to.
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 500000);
  await addTxn(pool, account.id, { date: firstOfMonthsAgo(2), cents: -4000, description: 'SHOP A' });
  await addTxn(pool, account.id, { date: firstOfMonthsAgo(1), cents: -30000, description: 'SHOP B' });

  const costs = await buildCostModel({ window: 120, client: pool });
  const months = await optionalByMonth(costs, { months: 3, client: pool });

  assert.equal(months[0].complete, false, 'the month the history starts in is a partial month');
  assert.equal(months[1].complete, true);
  assert.equal(months[2].complete, false, 'and so is the one still running');
});

test('a commitment is not counted again as optional month by month', async () => {
  // Same exclusion as the rate, and it has to be the same one: a chart of
  // "optional spending" that included the subscriptions sitting in the plan
  // would sit under a headline figure that did not, and the two would disagree
  // by exactly the subscriptions.
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setBalance(pool, account.id, 500000);
  for (let i = 0; i < 3; i++) {
    await addTxn(pool, account.id, { date: firstOfMonthsAgo(i + 1), cents: -2000, description: 'NETFLIX' });
    await addTxn(pool, account.id, { date: firstOfMonthsAgo(i + 1), cents: -5000, description: `SHOP ${i}` });
  }

  const before = await optionalByMonth(
    await buildCostModel({ window: 120, client: pool }), { months: 4, client: pool },
  );
  await pool.query(
    `insert into commitments (match_key, label, typical_amount, cadence_days, next_due, source, regularity)
     values ($1, 'NETFLIX', -20.00, 30, current_date + 7, 'manual', 1)`,
    [matchKeyFor('NETFLIX')],
  );
  const after = await optionalByMonth(
    await buildCostModel({ window: 120, client: pool }), { months: 4, client: pool },
  );

  assert.deepEqual(before.map((row) => row.spent), ['70.00', '70.00', '70.00', '0.00']);
  assert.deepEqual(after.map((row) => row.spent), ['50.00', '50.00', '50.00', '0.00']);
});
