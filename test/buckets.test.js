// Stage 3: pay periods, buckets, allocation and carry over.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getTestPool, resetDatabase, closeTestPool, makeAccount } from './helpers.js';
import {
  periodsBetween,
  setPayCycle,
  getPayCycle,
  ensurePayPeriods,
  periodState,
  allocate,
  applyTargets,
  periodForDate,
  suggestPayCycle,
} from '../src/buckets.js';
import { centsToNumeric, numericToCents } from '../src/money.js';

beforeEach(async () => {
  const pool = await resetDatabase();
  await pool.query('truncate bucket_allocations, bucket_categories, buckets, pay_periods, pay_cycle, rules, provider_category_map, categories cascade');
  return pool;
});
after(closeTestPool);

async function makeCategory(pool, name, kind = 'expense') {
  const { rows } = await pool.query('insert into categories (name, kind) values ($1, $2) returning *', [name, kind]);
  return rows[0];
}

async function makeBucket(pool, name, { target = 0, carryOver = true, categories = [] } = {}) {
  const { rows } = await pool.query(
    'insert into buckets (name, target, carry_over) values ($1, $2, $3) returning *',
    [name, centsToNumeric(target), carryOver],
  );
  for (const category of categories) {
    await pool.query('insert into bucket_categories (bucket_id, category_id) values ($1, $2)', [rows[0].id, category.id]);
  }
  return rows[0];
}

async function addTxn(pool, accountId, { date, cents, categoryId = null, isTransfer = false, pairId = null }) {
  const { rows } = await pool.query(
    `insert into transactions (account_id, redbark_txn_id, status, txn_date, description,
                               amount, category_id, is_transfer, transfer_pair_id, raw)
     values ($1,$2,'posted',$3,'TEST',$4,$5,$6,$7,'{}'::jsonb) returning id`,
    [accountId, `txn_${Math.random().toString(36).slice(2, 14)}`, date, centsToNumeric(cents), categoryId, isTransfer, pairId],
  );
  return rows[0].id;
}

test('fortnightly periods land on the same weekday every time', () => {
  const periods = periodsBetween('fortnightly', '2026-09-09', '2026-08-01', '2026-10-10');
  for (const period of periods) {
    assert.equal(new Date(`${period.starts_on}T00:00:00Z`).getUTCDay(), 3, 'every period should start on a Wednesday');
  }
  // Periods are contiguous with no gaps and no overlap.
  for (let i = 0; i < periods.length - 1; i++) {
    const dayAfterEnd = new Date(`${periods[i].ends_on}T00:00:00Z`);
    dayAfterEnd.setUTCDate(dayAfterEnd.getUTCDate() + 1);
    assert.equal(dayAfterEnd.toISOString().slice(0, 10), periods[i + 1].starts_on);
  }
});

test('monthly periods keep the pay day and clamp for short months', () => {
  const periods = periodsBetween('monthly', '2026-01-31', '2026-01-01', '2026-05-01');
  const starts = periods.map((p) => p.starts_on);
  assert.ok(starts.includes('2026-01-31'));
  assert.ok(starts.includes('2026-02-28'), 'February has no 31st, so it clamps');
  assert.ok(starts.includes('2026-03-31'));
});

test('monthly on the 28th, which is the real pay day here', () => {
  const periods = periodsBetween('monthly', '2026-09-28', '2026-09-01', '2026-12-05');
  const starts = periods.map((p) => p.starts_on);
  assert.deepEqual(starts, ['2026-08-28', '2026-09-28', '2026-10-28', '2026-11-28']);
});

test('pay periods are generated, and changing the cycle clears the old shape', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  await addTxn(pool, account.id, { date: '2026-06-01', cents: -1000 });

  await setPayCycle('fortnightly', '2026-09-09', null, pool);
  const first = await ensurePayPeriods({ pool });
  assert.ok(first.created > 10);

  const before = await pool.query('select count(*)::int as n from pay_periods where current_date between starts_on and ends_on');
  assert.equal(before.rows[0].n, 1);

  // Switching to monthly must not leave fortnightly periods behind, or two
  // periods contain today and the wrong one wins.
  await setPayCycle('monthly', '2026-09-28', null, pool);
  const second = await ensurePayPeriods({ pool });
  assert.ok(second.removed > 0, 'the old fortnightly periods should be removed');

  const after = await pool.query('select count(*)::int as n from pay_periods where current_date between starts_on and ends_on');
  assert.equal(after.rows[0].n, 1, 'exactly one period contains today');

  const cycle = await getPayCycle(pool);
  assert.equal(cycle.cadence, 'monthly');
});

test('income and spending land in the right period, and allocation maths is exact', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  const pay = await makeCategory(pool, 'Pay', 'income');
  const food = await makeCategory(pool, 'Food', 'expense');

  await setPayCycle('monthly', '2026-09-28', null, pool);
  await ensurePayPeriods({ pool });
  const period = await periodForDate('2026-09-30', pool);

  await addTxn(pool, account.id, { date: '2026-09-28', cents: 980000, categoryId: pay.id });
  await addTxn(pool, account.id, { date: '2026-09-30', cents: -12345, categoryId: food.id });
  // Outside the period, so it must not be counted.
  await addTxn(pool, account.id, { date: '2026-09-27', cents: -500000, categoryId: food.id });

  const bucket = await makeBucket(pool, 'Food', { target: 150000, categories: [food] });
  await allocate(bucket.id, period.id, centsToNumeric(150000), pool);

  const state = await periodState(period.id, pool);
  assert.equal(numericToCents(state.income), 980000);
  assert.equal(numericToCents(state.spent), 12345);
  assert.equal(numericToCents(state.total_allocated), 150000);
  assert.equal(numericToCents(state.to_allocate), 980000 - 150000);

  const [line] = state.buckets;
  assert.equal(numericToCents(line.spent), 12345);
  assert.equal(numericToCents(line.remaining), 150000 - 12345);
});

test('a mortgage repayment counts as spending even though it is a transfer', async () => {
  const pool = await getTestPool();
  const everyday = await makeAccount(pool, { masked_number: 'xxxx9529', is_liquid: true });
  const loan = await makeAccount(pool, { masked_number: 'xxxx0194', type: 'loan', is_liquid: false });
  const mortgage = await makeCategory(pool, 'Mortgage', 'expense');

  await setPayCycle('monthly', '2026-09-28', null, pool);
  await ensurePayPeriods({ pool });
  const period = await periodForDate('2026-10-10', pool);

  // The pair, as transfer detection would leave it.
  const out = await addTxn(pool, everyday.id, { date: '2026-10-10', cents: -180000, categoryId: mortgage.id, isTransfer: true });
  const into = await addTxn(pool, loan.id, { date: '2026-10-10', cents: 180000, categoryId: mortgage.id, isTransfer: true });
  await pool.query('update transactions set transfer_pair_id = $2 where id = $1', [out, into]);
  await pool.query('update transactions set transfer_pair_id = $2 where id = $1', [into, out]);

  const bucket = await makeBucket(pool, 'Mortgage', { target: 390000, categories: [mortgage] });
  await allocate(bucket.id, period.id, centsToNumeric(390000), pool);

  const state = await periodState(period.id, pool);
  const [line] = state.buckets;
  assert.equal(
    numericToCents(line.spent),
    180000,
    'money leaving a spendable account for the loan really does leave our cash',
  );
  assert.equal(numericToCents(line.remaining), 390000 - 180000);
});

test('a transfer between two spendable accounts is not spending', async () => {
  const pool = await getTestPool();
  const everyday = await makeAccount(pool, { masked_number: 'xxxx9529', is_liquid: true });
  const savings = await makeAccount(pool, { masked_number: 'xxxx4047', is_liquid: true });
  const moving = await makeCategory(pool, 'Internal', 'transfer');

  await setPayCycle('monthly', '2026-09-28', null, pool);
  await ensurePayPeriods({ pool });
  const period = await periodForDate('2026-10-10', pool);

  const out = await addTxn(pool, everyday.id, { date: '2026-10-10', cents: -50000, categoryId: moving.id, isTransfer: true });
  const into = await addTxn(pool, savings.id, { date: '2026-10-10', cents: 50000, categoryId: moving.id, isTransfer: true });
  await pool.query('update transactions set transfer_pair_id = $2 where id = $1', [out, into]);
  await pool.query('update transactions set transfer_pair_id = $2 where id = $1', [into, out]);

  const state = await periodState(period.id, pool);
  assert.equal(numericToCents(state.spent), 0, 'the money is still ours');
  assert.equal(numericToCents(state.income), 0);
});

test('leftover rolls into the next period only for buckets that carry over', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  const food = await makeCategory(pool, 'Food', 'expense');
  const fun = await makeCategory(pool, 'Fun', 'expense');

  await setPayCycle('monthly', '2026-09-28', null, pool);
  await ensurePayPeriods({ pool });
  const first = await periodForDate('2026-09-30', pool);
  const second = await periodForDate('2026-10-30', pool);

  const saver = await makeBucket(pool, 'Saver', { target: 100000, carryOver: true, categories: [food] });
  const spender = await makeBucket(pool, 'Spender', { target: 100000, carryOver: false, categories: [fun] });

  // Allocate 1000 to each in the first period, spend 400 from each.
  await allocate(saver.id, first.id, centsToNumeric(100000), pool);
  await allocate(spender.id, first.id, centsToNumeric(100000), pool);
  await addTxn(pool, account.id, { date: '2026-09-30', cents: -40000, categoryId: food.id });
  await addTxn(pool, account.id, { date: '2026-09-30', cents: -40000, categoryId: fun.id });

  await allocate(saver.id, second.id, centsToNumeric(100000), pool);
  await allocate(spender.id, second.id, centsToNumeric(100000), pool);

  const state = await periodState(second.id, pool);
  const byName = Object.fromEntries(state.buckets.map((b) => [b.name, b]));

  assert.equal(numericToCents(byName.Saver.carried_in), 60000, 'the unspent 600 rolls forward');
  assert.equal(numericToCents(byName.Saver.remaining), 160000);
  assert.equal(numericToCents(byName.Spender.carried_in), 0, 'this one resets each period');
  assert.equal(numericToCents(byName.Spender.remaining), 100000);
});

test('spending from before a bucket existed does not roll in as a huge debt', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  const food = await makeCategory(pool, 'Food', 'expense');

  await setPayCycle('monthly', '2026-09-28', null, pool);
  await ensurePayPeriods({ pool });

  // A year of history in this category, long before any budget existed.
  for (const date of ['2026-01-15', '2026-03-15', '2026-05-15', '2026-07-15']) {
    await addTxn(pool, account.id, { date, cents: -200000, categoryId: food.id });
  }

  const bucket = await makeBucket(pool, 'Food', { target: 50000, carryOver: true, categories: [food] });
  const period = await periodForDate('2026-09-30', pool);
  await allocate(bucket.id, period.id, centsToNumeric(50000), pool);

  const state = await periodState(period.id, pool);
  const [line] = state.buckets;
  assert.equal(numericToCents(line.carried_in), 0, 'there was no budget before this, so nothing carries in');
  assert.equal(numericToCents(line.remaining), 50000);
});

test('applying targets fills empty allocations and leaves edited ones alone', async () => {
  const pool = await getTestPool();
  const food = await makeCategory(pool, 'Food', 'expense');
  await setPayCycle('monthly', '2026-09-28', null, pool);
  await ensurePayPeriods({ pool });
  const period = await periodForDate('2026-09-30', pool);

  const a = await makeBucket(pool, 'A', { target: 50000, categories: [food] });
  const b = await makeBucket(pool, 'B', { target: 70000 });

  await allocate(a.id, period.id, centsToNumeric(12345), pool);
  const filled = await applyTargets(period.id, pool);
  assert.equal(filled, 1, 'only the bucket with no allocation is filled');

  const state = await periodState(period.id, pool);
  const byName = Object.fromEntries(state.buckets.map((x) => [x.name, x]));
  assert.equal(numericToCents(byName.A.allocated), 12345, 'a hand edited allocation is not overwritten');
  assert.equal(numericToCents(byName.B.allocated), 70000);
});

test('a category can only belong to one bucket, so spending is never double counted', async () => {
  const pool = await getTestPool();
  const food = await makeCategory(pool, 'Food', 'expense');
  await makeBucket(pool, 'First', { categories: [food] });
  await assert.rejects(
    () => makeBucket(pool, 'Second', { categories: [food] }),
    /unique|duplicate/i,
  );
});

test('the pay cycle is suggested from recurring income, not from one off credits', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  const pay = await makeCategory(pool, 'Pay', 'income');

  // Two fortnightly salaries a week apart, which is how money really arrived.
  for (let i = 0; i < 6; i++) {
    await pool.query(
      `insert into transactions (account_id, redbark_txn_id, status, txn_date, description, amount, category_id, raw)
       values ($1,$2,'posted',$3,'SALARY CREDIT FRANMARINE',$4,$5,'{}'::jsonb)`,
      [account.id, `a${i}`, isoDaysAgo(i * 14), centsToNumeric(461100), pay.id],
    );
    await pool.query(
      `insert into transactions (account_id, redbark_txn_id, status, txn_date, description, amount, category_id, raw)
       values ($1,$2,'posted',$3,'SALARY CREDIT EQU',$4,$5,'{}'::jsonb)`,
      [account.id, `b${i}`, isoDaysAgo(i * 14 + 7), centsToNumeric(349138), pay.id],
    );
  }
  // A one off refund, which must not be mistaken for a payday.
  await pool.query(
    `insert into transactions (account_id, redbark_txn_id, status, txn_date, description, amount, category_id, raw)
     values ($1,'refund','posted',$2,'SOME REFUND',$3,$4,'{}'::jsonb)`,
    [account.id, isoDaysAgo(3), centsToNumeric(4200), pay.id],
  );

  const suggestion = await suggestPayCycle(pool);
  assert.equal(suggestion.cadence, 'weekly', 'two fortnightly pays a week apart means money arrives weekly');
  assert.equal(suggestion.observed_gap_days, 7);
  assert.equal(suggestion.streams.length, 2, 'the refund is not a salary stream');
});

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
