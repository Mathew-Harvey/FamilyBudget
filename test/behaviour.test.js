// The Today page: the numbers behind it, and the mistakes it is built to avoid.
//
// Most of these test a specific wrong answer this page gave at some point, and
// which would have cost it its credibility. See docs/behaviour.md.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getTestPool, resetDatabase, closeTestPool, makeAccount } from './helpers.js';
import { priceIn, friendlyDate, didItStick, movers, position, tradeOff } from '../src/behaviour.js';
import { setPayCycle, ensurePayPeriods } from '../src/buckets.js';
import { centsToNumeric, numericToCents } from '../src/money.js';
import { daysAgo } from '../src/dates.js';

beforeEach(async () => {
  const pool = await resetDatabase();
  await pool.query(
    'truncate alert_log, commitments, expected_income, assets, bucket_allocations, bucket_categories, buckets, pay_periods, pay_cycle, rules, provider_category_map, intentions, goals, settings, categories cascade',
  );
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

test('a date is rendered as something a person can picture', () => {
  assert.equal(friendlyDate('2026-11-23'), '23 November');
  assert.equal(friendlyDate('2027-01-07'), '7 January');
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

  const base = await position({ client: pool });
  assert.ok(base.going_backwards, 'nothing coming in means going backwards');

  const moved = await tradeOff({ monthlyCents: 100_000, client: pool });
  assert.ok(moved.days_gained > 0, 'spending a thousand a month less has to buy time');
  assert.notEqual(moved.to, moved.from);
});
