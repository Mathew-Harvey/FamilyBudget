// The Today page: the numbers behind it, and the mistakes it is built to avoid.
//
// Most of these test a specific wrong answer this page gave at some point, and
// which would have cost it its credibility. See docs/behaviour.md.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getTestPool, resetDatabase, closeTestPool, makeAccount } from './helpers.js';
import { priceIn, friendlyDate, didItStick, movers, position, tradeOff, whatToStop, debts, thisPeriod } from '../src/behaviour.js';
import { setPayCycle, ensurePayPeriods } from '../src/buckets.js';
import { forecast } from '../src/forecast.js';
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

test('a date is rendered as something a person can picture', () => {
  // This year needs no year on it, and a runway date reads better without one.
  assert.equal(friendlyDate('2026-11-23', '2026-09-16'), '23 November');
  // Another year does need it. A debt clearing in 2029 written as "26 August"
  // is not merely terse, it is wrong by three years.
  assert.equal(friendlyDate('2027-01-07', '2026-09-16'), '7 January 2027');
  assert.equal(friendlyDate('2029-08-26', '2026-09-16'), '26 August 2029');
  assert.equal(friendlyDate(null), null);
});

test('what a cost buys back is not linear, and several together beat their sum', () => {
  // A thousand a day going out, ten thousand in the bank: ten days left.
  const gap = { dailyGapCents: 100_000, balanceCents: 1_000_000 };

  // Roughly 300 a day saved. Alone each buys about four days.
  const one = priceIn({ monthlyCents: Math.round(300_00 * 30.44 / 100) * 100, ...gap });
  const three = priceIn({ monthlyCents: 3 * Math.round(300_00 * 30.44 / 100) * 100, ...gap });

  assert.ok(one.runway_days > 0);
  // Three of them buy far more than three times as much, because the saving
  // comes off the denominator. This is the number the first version got wrong:
  // it divided instead, and made a 300 dollar a month cost look like nothing.
  assert.ok(three.runway_days > one.runway_days * 3, `${three.runway_days} should beat ${one.runway_days * 3}`);
});

test('a saving that covers the whole gap is a sentence, not a very large number', () => {
  const answer = priceIn({ monthlyCents: 500_000, dailyGapCents: 10_000, balanceCents: 1_000_000 });
  assert.equal(answer.clears_the_gap, true);
  assert.equal(answer.runway_days, null);
});

test('nothing being burned means a cost buys savings, not time', () => {
  const answer = priceIn({ monthlyCents: 10_000, dailyGapCents: 0, balanceCents: 1_000_000 });
  assert.equal(answer.runway_days, null);
  assert.equal(answer.clears_the_gap, false);
  assert.equal(answer.per_year, '1200.00');
});

test('a temporary first pay moves the cash curve but not ongoing monthly income', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await pool.query(
    "insert into balances (account_id, balance_date, balance) values ($1, current_date, '1000.00')",
    [account.id],
  );
  await setPayCycle('monthly', daysAgo(400), '1000.00', pool);
  const partialPayday = addDays(today(), 12);
  await pool.query(
    `insert into expected_income
       (label, amount, cadence_days, starts_on, ends_on, confidence)
     values ('Partial first pay', '250.00', 1, $1, $1, 'confirmed')`,
    [partialPayday],
  );

  const here = await position({ client: pool });
  assert.equal(here.in_per_month, '1000.00');
});

test('a wage that has not started yet is on the curve but not in monthly income', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await pool.query(
    "insert into balances (account_id, balance_date, balance) values ($1, current_date, '1000.00')",
    [account.id],
  );
  await setPayCycle('monthly', daysAgo(400), '1000.00', pool);
  // Ongoing, confirmed, no end date: the only thing keeping it out of today's
  // income is that it has not begun. Without that check the front page told a
  // household four months from a second wage that it already had it.
  await pool.query(
    `insert into expected_income
       (label, amount, cadence_days, starts_on, confidence)
     values ('Second wage', '2000.00', 14, $1, 'likely')`,
    [addDays(today(), 110)],
  );

  const here = await position({ client: pool });
  assert.equal(here.in_per_month, '1000.00');

  // And it still reaches the curve, on the day it starts and not before.
  const projection = await forecast({ days: 200, client: pool });
  const paydays = projection.series
    .flatMap((point) => point.events.filter((event) => event.kind === 'expected_income')
      .map(() => point.date));
  assert.ok(paydays.length > 0, 'the wage should still be projected');
  assert.equal(paydays[0], addDays(today(), 110));
});

test('a fortnightly commitment does not look like a rise just because the windows differ', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });

  // An unchanging fortnightly mortgage, right across the change point.
  for (let i = 0; i <= 200; i += 14) {
    await addTxn(pool, account.id, { date: daysAgo(i), cents: -180000, description: 'DIRECT DEBIT HOME LOAN REPAY' });
  }
  await pool.query(
    `insert into commitments (match_key, label, typical_amount, cadence_days, next_due, occurrences, regularity, source)
     values ('DIRECT DEBIT HOME', 'Home loan', '-1800.00', 14, current_date, 15, 1, 'detected')`,
  );

  const answer = await didItStick({ since: daysAgo(56), client: pool, before: 180 });
  // Nothing changed, so nothing should be reported as having changed. Before
  // commitments were excluded this reported the mortgage rising by over a
  // thousand a month, purely because 56 days holds a different number of
  // fortnights per day than 180 does.
  assert.equal(answer.cuts.length, 0, 'no cuts');
  assert.equal(answer.rises.length, 0, 'and no rises');
});

test('one annual bill landing in the window is not a change of habit', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });

  // Groceries every few days, unchanged, plus one insurance premium.
  for (let i = 0; i <= 180; i += 3) {
    await addTxn(pool, account.id, { date: daysAgo(i), cents: -6000, description: 'ALDI STORES', merchantKey: 'ALDI' });
  }
  await addTxn(pool, account.id, { date: daysAgo(20), cents: -90000, description: 'SUNCORP INSURANCE', merchantKey: 'SUNCORP INSURANCE' });

  const moved = await movers({ since: daysAgo(56), client: pool, before: 180 });
  const names = moved.up.map((row) => row.place);
  assert.ok(!names.some((name) => /SUNCORP/i.test(name)), 'a single payment has no rate to compare');
  assert.ok(
    moved.irregular.some((row) => /SUNCORP/i.test(row.place)),
    'and it is listed as left out rather than silently dropped',
  );
});

test('the cut is reported whichever way it went, and credited when it is real', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });
  const { rows: [cat] } = await pool.query(
    "insert into categories (name, kind) values ('Takeaway','expense') returning id",
  );

  // Heavy before the change point, light after it.
  for (let i = 57; i <= 180; i += 2) {
    await addTxn(pool, account.id, { date: daysAgo(i), cents: -10000, description: `TAKEAWAY ${i}`, categoryId: cat.id, merchantKey: 'TAKEAWAY' });
  }
  for (let i = 0; i <= 56; i += 8) {
    await addTxn(pool, account.id, { date: daysAgo(i), cents: -10000, description: `TAKEAWAY ${i}`, categoryId: cat.id, merchantKey: 'TAKEAWAY' });
  }

  const answer = await didItStick({ since: daysAgo(56), client: pool, before: 124 });
  assert.equal(answer.stuck, true, 'spending a quarter as often is a cut');
  assert.ok(numericToCents(answer.cut) > 0, 'and it is credited');
  assert.ok(answer.cuts.length >= 1);
});

test('ticking something off moves the date, and the move is real', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await pool.query(
    `insert into balances (account_id, balance_date, balance) values ($1, current_date, '10000.00')`,
    [account.id],
  );
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });
  for (let i = 0; i <= 120; i++) {
    await addTxn(pool, account.id, { date: daysAgo(i), cents: -10000, description: `DAY ${i}` });
  }
  await classifyTestSpendingAsEssential(pool);

  const base = await position({ client: pool });
  assert.ok(base.going_backwards, 'nothing coming in means going backwards');

  const moved = await tradeOff({ monthlyCents: 100_000, client: pool });
  assert.ok(moved.days_gained > 0, 'spending a thousand a month less has to buy time');
  assert.notEqual(moved.to, moved.from);
});

test('several charges on one day are one event, not a monthly habit', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });

  // Ordinary shopping either side of the change point, unchanged.
  for (let i = 0; i <= 180; i += 3) {
    await addTxn(pool, account.id, { date: daysAgo(i), cents: -6000, description: 'ALDI STORES', merchantKey: 'ALDI' });
  }
  // A builder paid three times in one afternoon. Counting rows let this through
  // the "seen at least twice" gate and put it on the page as a recurring rise.
  for (const cents of [-141900, -84595, -70000]) {
    await addTxn(pool, account.id, { date: daysAgo(20), cents, description: 'RIJA ENTERPRISES PTY', merchantKey: 'RIJA ENTERPRISES' });
  }

  const moved = await movers({ since: daysAgo(56), client: pool, before: 180 });
  assert.ok(
    !moved.up.some((row) => /RIJA/i.test(row.place)),
    'one day of spending has no monthly rate, however many charges it took',
  );
  assert.ok(
    moved.irregular.some((row) => /RIJA/i.test(row.place)),
    'and it is reported as left out rather than dropped',
  );
});

test('a debt payment is not offered as something to cancel', async () => {
  const pool = await getTestPool();
  const everyday = await makeAccount(pool, { masked_number: 'xxxx1111', is_liquid: true });
  const card = await makeAccount(pool, { masked_number: null, is_liquid: false, name: 'A credit card' });
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });

  // A hand entered debt has no counterpart row to pair with, so the only link
  // is the payee. Asking "is it a transfer" missed it entirely and the page
  // offered servicing a credit card as a subscription to cancel.
  await pool.query(
    "insert into merchants (match_key, display_name, source, pays_account_id) values ('CARD CO','Card Co','manual',$1)",
    [card.id],
  );
  for (let i = 0; i <= 90; i += 30) {
    await addTxn(pool, everyday.id, { date: daysAgo(i), cents: -40000, description: 'CARD CO PAYMENT', merchantKey: 'CARD CO' });
  }
  await pool.query(
    `insert into commitments (match_key, label, typical_amount, cadence_days, next_due, occurrences, regularity, source)
     values ('CARD CO PAYMENT', 'Card Co payment', '-400.00', 30, current_date, 4, 1, 'detected')`,
  );

  const stop = await whatToStop({ client: pool });
  const row = stop.items.find((item) => /card co/i.test(item.label));
  assert.ok(row, 'it is still listed, because the cost is worth knowing');
  assert.equal(row.fixed, true, 'but it cannot simply be stopped');
});

test('the debts card adds up to the headline debt figure', async () => {
  const pool = await getTestPool();
  const everyday = await makeAccount(pool, { masked_number: 'xxxx1111', is_liquid: true });
  const loan = await makeAccount(pool, { masked_number: null, is_liquid: false, name: 'A loan' });
  await pool.query(
    `insert into balances (account_id, balance_date, balance) values ($1, current_date, '5000.00')`,
    [everyday.id],
  );
  await pool.query(
    `insert into balances (account_id, balance_date, balance) values ($1, current_date, '-9000.00')`,
    [loan.id],
  );
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });
  await pool.query(
    "insert into merchants (match_key, display_name, source, pays_account_id) values ('LOAN CO','Loan Co','manual',$1)",
    [loan.id],
  );
  for (let i = 0; i <= 110; i += 10) {
    await addTxn(pool, everyday.id, { date: daysAgo(i), cents: -30000, description: 'LOAN CO', merchantKey: 'LOAN CO' });
    await addTxn(pool, everyday.id, { date: daysAgo(i), cents: -5000, description: `SHOP ${i}`, merchantKey: `SHOP${i}` });
  }

  const here = await position({ client: pool });
  const owed = await debts({ client: pool });
  const rows = owed.reduce((total, row) => total + Number(row.per_month), 0);

  // Two independent measurements of one quantity land a few percent apart and
  // then visibly fail to add up on the page, which reads as a bug.
  assert.ok(
    Math.abs(Number(here.debt_per_month) - rows) < Number(here.debt_per_month) * 0.05,
    `headline ${here.debt_per_month} should match the rows ${rows.toFixed(2)}`,
  );
});

test('a monthly debt is rated over the window, not over the payments the window caught', async () => {
  // The denominator used to be the days since the FIRST PAYMENT INSIDE the
  // window. For anything monthly that lands about a cadence after the window
  // opens, so a 120 day window became 106 days and every established debt was
  // reported 13 percent high: the mortgage read 2,814 a month against a real
  // 2,450, and the debts card stopped adding up to the headline above it.
  const pool = await getTestPool();
  const everyday = await makeAccount(pool, { masked_number: 'xxxx1111', is_liquid: true });
  const loan = await makeAccount(pool, { masked_number: null, is_liquid: false, name: 'A mortgage' });
  await pool.query(
    "insert into balances (account_id, balance_date, balance) values ($1, current_date, '-400000.00')",
    [loan.id],
  );
  await pool.query(
    "insert into merchants (match_key, display_name, source, pays_account_id) values ('HOME LOAN','Home Loan','manual',$1)",
    [loan.id],
  );
  // Fourteen months of a 2,450 repayment, every 30 days. Four of them fall
  // inside a 120 day window, the earliest of them 106 days ago.
  for (let i = 0; i < 14; i++) {
    await addTxn(pool, everyday.id, {
      date: daysAgo(16 + i * 30), cents: -245000, description: 'HOME LOAN', merchantKey: 'HOME LOAN',
    });
  }

  const [row] = await debts({ client: pool, window: 120 });
  // Four payments in 120 days is 9,800, which over 30.44 day months is 2,485.93.
  // Anything near 2,814 means the span is being measured from inside the window
  // again.
  assert.equal(row.per_month, '2485.93');
  assert.equal(row.per_year, '29400.00');
});

// A household with optional spending and nothing else configured about it.
async function householdWithOptionalSpending(pool) {
  const everyday = await makeAccount(pool, { masked_number: 'xxxx1111', is_liquid: true });
  await pool.query(
    "insert into balances (account_id, balance_date, balance) values ($1, current_date, '5000.00')",
    [everyday.id],
  );
  await setPayCycle('monthly', daysAgo(400), '0', pool);
  await ensurePayPeriods({ pool });
  // Uncategorised spending falls to the 'cut' tier, which is what the allowance
  // replaces.
  for (let i = 0; i < 60; i += 2) {
    await addTxn(pool, everyday.id, { date: daysAgo(i), cents: -10000, description: `CAFE ${i}`, merchantKey: `CAFE${i}` });
  }
  return everyday;
}

test('an allowance nobody has chosen is what the household actually spends', async () => {
  // The setting used to be seeded at 0.00, so every household started out
  // forecast as buying nothing it did not have to. Nobody chose that, and the
  // plan built on it described a household nobody lives in: on the real one it
  // hid 3,825 a month and reported the resulting surplus as money.
  const pool = await getTestPool();
  await householdWithOptionalSpending(pool);

  const here = await position({ client: pool });
  assert.ok(
    Number(here.optional_history_per_month) > 0,
    'the optional spending the plan set aside has to be reported somewhere',
  );
  assert.equal(here.discretionary_per_month, here.optional_history_per_month);
  // Nothing to warn about: the plan and the household agree.
  assert.equal(here.optional_history_excluded, '0.00');
});

test('the position says what the plan leaves out, not just what it includes', async () => {
  // "Out" is the household plan: recurring essentials, the allowance and the
  // commitments, so optional spending enters it only through the allowance.
  // Someone who sets a figure below what they are spending is stating an
  // intention, and a headline that reports the plan's "out" without saying how
  // far it sits from the spending is not one anybody can check.
  const pool = await getTestPool();
  await householdWithOptionalSpending(pool);
  await pool.query(
    "insert into settings (key, value) values ('forecast_discretionary_monthly', '100.00')",
  );

  const here = await position({ client: pool });
  assert.equal(here.discretionary_per_month, '100.00');
  assert.equal(
    numericToCents(here.optional_history_excluded),
    numericToCents(here.optional_history_per_month) - 10000,
  );
});

test('an allowance somebody set to zero stays zero', async () => {
  // Following the spending is the answer to "nobody has said", not an override.
  // A household that means zero says so, and the row saying so is the whole
  // difference between a decision and a default.
  const pool = await getTestPool();
  await householdWithOptionalSpending(pool);
  await pool.query(
    "insert into settings (key, value) values ('forecast_discretionary_monthly', '0.00')",
  );

  const here = await position({ client: pool });
  assert.equal(here.discretionary_per_month, '0.00');
  assert.equal(here.optional_history_excluded, here.optional_history_per_month);
});

test('this pay period is measured, not a month divided by two', async () => {
  // Every other figure on the page is monthly and nobody lives a month. The
  // pay lands every fortnight and has to last until the next lot, which is the
  // unit the decisions are actually taken in. Converting the monthly rate would
  // give a fortnight sized number describing no particular fortnight, so this
  // reads what really came in and went out since the last payday.
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await pool.query(
    "insert into balances (account_id, balance_date, balance) values ($1, current_date, '5000.00')",
    [account.id],
  );
  const { rows: [income] } = await pool.query(
    "insert into categories (name, kind) values ('Pay', 'income') returning id",
  );
  // A fortnight that started six days ago, so today is day seven of fourteen.
  await setPayCycle('fortnightly', daysAgo(6), '2000.00', pool);
  await ensurePayPeriods({ pool });

  await addTxn(pool, account.id, { date: daysAgo(6), cents: 200000, description: 'PAY', categoryId: income.id });
  await addTxn(pool, account.id, { date: daysAgo(3), cents: -30000, description: 'SHOP' });
  // Before this period started, so it belongs to the fortnight before.
  await addTxn(pool, account.id, { date: daysAgo(9), cents: -50000, description: 'EARLIER' });

  const here = await thisPeriod({ client: pool });
  assert.equal(here.unit, 'fortnight');
  assert.equal(here.days_total, 14);
  assert.equal(here.days_elapsed, 7);
  assert.equal(here.days_left, 7);
  assert.equal(here.in_so_far, '2000.00');
  assert.equal(here.out_so_far, '300.00', 'the earlier shop belongs to the fortnight before');
  assert.equal(here.net_so_far, '1700.00');
  // Half the period gone, so an even spend would have reached half the pay.
  assert.equal(here.pace, '1000.00');
  assert.equal(here.ahead, true);
  assert.equal(here.has_income, true);
});

test('a period with no pay in it yet is not measured against an even spend', async () => {
  // Pace is this period's own income spread across the days that have passed.
  // With no income the line sits at zero, so every dollar is "past" it, and
  // saying so would be arithmetic dressed up as a warning.
  const pool = await getTestPool();
  const account = await makeAccount(pool, { is_liquid: true });
  await setPayCycle('weekly', daysAgo(3), '0', pool);
  await ensurePayPeriods({ pool });
  await addTxn(pool, account.id, { date: daysAgo(1), cents: -4000, description: 'SHOP' });

  const here = await thisPeriod({ client: pool });
  assert.equal(here.unit, 'week', 'the word follows the configured cycle');
  assert.equal(here.has_income, false);
  assert.equal(here.in_so_far, '0.00');
  assert.equal(here.out_so_far, '40.00');
  assert.equal(here.net_so_far, '-40.00');
});

test('there is no period card before a pay cycle is configured', async () => {
  const pool = await getTestPool();
  await makeAccount(pool, { is_liquid: true });
  assert.equal(await thisPeriod({ client: pool }), null);
});
