// The survival plan. Most of these test a specific way the plan could lie.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getTestPool, resetDatabase, closeTestPool, makeAccount } from './helpers.js';
import { leanPlan, assetLevers } from '../src/lean.js';
import { forecast } from '../src/forecast.js';
import { position } from '../src/behaviour.js';
import { setPayCycle, ensurePayPeriods } from '../src/buckets.js';
import { centsToNumeric, numericToCents } from '../src/money.js';
import { daysAgo, today } from '../src/dates.js';

beforeEach(async () => {
  const pool = await resetDatabase();
  await pool.query('update alert_settings set enabled = false, email_to = null');
  return pool;
});
after(closeTestPool);

async function addTxn(pool, accountId, { date, cents, description = 'TEST', merchantKey = null, categoryId = null }) {
  const { rows } = await pool.query(
    `insert into transactions (account_id, redbark_txn_id, status, txn_date, description, amount, merchant_key, category_id, raw)
     values ($1,$2,'posted',$3,$4,$5,$6,$7,'{}'::jsonb) returning id`,
    [accountId, `txn_${Math.random().toString(36).slice(2, 14)}`, date, description, centsToNumeric(cents), merchantKey, categoryId],
  );
  return rows[0].id;
}

// A household spending well past its income, with one cuttable subscription,
// some discretionary shopping, and a mortgage it cannot stop.
async function overspendingHousehold(pool) {
  const everyday = await makeAccount(pool, { masked_number: 'xxxx1111', is_liquid: true });
  const loan = await makeAccount(pool, { masked_number: null, is_liquid: false, name: 'Home loan' });
  await pool.query(
    "insert into balances (account_id, balance_date, balance) values ($1, current_date, '9000.00')",
    [everyday.id],
  );
  await setPayCycle('monthly', daysAgo(400), '1000.00', pool);
  await ensurePayPeriods({ pool });

  await pool.query(
    "insert into merchants (match_key, display_name, source, pays_account_id) values ('BANK LOAN','Bank loan','manual',$1)",
    [loan.id],
  );
  await pool.query("insert into merchants (match_key, display_name, source, lean_tier) values ('A SUBSCRIPTION','A subscription','manual','cut')");
  await pool.query("insert into merchants (match_key, display_name, source, lean_tier) values ('A SHOP','A shop','manual','cut')");
  await pool.query(
    "insert into settings (key, value) values ('forecast_discretionary_monthly', '800.00')",
  );
  await pool.query(
    `insert into commitments
       (match_key, label, typical_amount, cadence_days, next_due, occurrences, regularity, source)
     values ('A SUBSCRIPTION MONTHLY', 'A subscription', '-100.00', 30,
             current_date + 20, 4, 1, 'detected')`,
  );

  for (let i = 0; i <= 110; i += 30) {
    await addTxn(pool, everyday.id, { date: daysAgo(i), cents: -200000, description: 'BANK LOAN REPAY', merchantKey: 'BANK LOAN' });
    await addTxn(pool, everyday.id, { date: daysAgo(i), cents: -10000, description: 'A SUBSCRIPTION MONTHLY', merchantKey: 'A SUBSCRIPTION' });
  }
  for (let i = 0; i <= 110; i += 5) {
    await addTxn(pool, everyday.id, { date: daysAgo(i), cents: -8000, description: `A SHOP ${i}`, merchantKey: 'A SHOP' });
  }
  return { everyday, loan };
}

test('a step that does not close the gap says so, and by how much', async () => {
  const pool = await getTestPool();
  await overspendingHousehold(pool);

  const plan = await leanPlan({ client: pool });
  const first = plan.steps[0];

  assert.equal(first.lasts, false, 'one subscription does not close a gap this size');
  assert.ok(numericToCents(first.still_short_per_month) > 0, 'and it says how short it still is');
  // The failure this guards: "lasts" once meant "the 400 day projection did not
  // reach zero", so saving less than the gap could report that nothing runs out.
  if (first.beyond_horizon) {
    assert.ok(numericToCents(first.still_short_per_month) > 0, 'past the horizon is not the same as solved');
  }
});

test('Today, Forecast and Lasting start from the same household plan', async () => {
  const pool = await getTestPool();
  await overspendingHousehold(pool);

  const projection = await forecast({ days: 400, client: pool });
  const here = await position({ client: pool });
  const plan = await leanPlan({ client: pool });

  assert.equal(here.runway_date, projection.runway_date);
  assert.equal(plan.now.runway_date, projection.runway_date);
  assert.equal(
    numericToCents(plan.steps[0].saves_per_month),
    90147,
    'the step removes the saved allowance and optional commitment, not historical shopping already outside the plan',
  );
});

test('a debt repayment is never proposed for cutting', async () => {
  const pool = await getTestPool();
  await overspendingHousehold(pool);

  const plan = await leanPlan({ client: pool });
  const proposed = plan.steps.flatMap((step) => step.removes.map((row) => row.what));
  assert.ok(
    !proposed.some((what) => /bank loan/i.test(what)),
    'the mortgage is not a subscription, whatever the category default says',
  );
  // Debt servicing is listed by the account it pays down, which is the name
  // someone recognises, not the payee string on the statement.
  assert.ok(
    plan.kept.some((row) => /home loan/i.test(row.what)),
    'and it is shown as something the plan does not touch',
  );
});

test('the floor reports the shortfall rather than implying cutting is enough', async () => {
  const pool = await getTestPool();
  await overspendingHousehold(pool);

  const plan = await leanPlan({ client: pool });
  // This household cannot cut its way out: the loan alone is most of the gap.
  assert.equal(plan.floor.lasts, false);
  assert.ok(numericToCents(plan.floor.still_short_per_month) > 0);
  assert.ok(
    numericToCents(plan.floor.saves_per_month) < numericToCents(plan.now.gap_per_month),
    'saving less than the gap has to read as not enough',
  );
});

test('every step saves at least as much as the one before it', async () => {
  const pool = await getTestPool();
  await overspendingHousehold(pool);
  const plan = await leanPlan({ client: pool });
  for (let i = 1; i < plan.steps.length; i++) {
    assert.ok(
      numericToCents(plan.steps[i].saves_per_month) >= numericToCents(plan.steps[i - 1].saves_per_month),
      'the steps are cumulative, so the savings cannot go backwards',
    );
  }
});

test('a hypothetical dated today still counts', async () => {
  const pool = await getTestPool();
  const { everyday } = await overspendingHousehold(pool);
  await pool.query(
    "insert into assets (name, estimated_value, sellable) values ('A motorbike', '10000.00', true)",
  );

  const levers = await assetLevers({ client: pool });
  assert.equal(levers.length, 1);
  assert.ok(levers[0].days_gained > 0, 'selling ten thousand dollars of motorbike has to buy time');

  // The bug underneath: forecast() skips day zero because today's balance
  // already holds what really happened today. A hypothetical has not happened,
  // so it cannot be in the balance, and skipping it made selling everything
  // buy exactly zero days, silently.
  const base = await forecast({ days: 200, client: pool });
  const sold = await forecast({
    days: 200,
    client: pool,
    extraEvents: [{ date: today(), kind: 'scenario', label: 'Sold it', amount: '10000.00' }],
  });
  assert.ok(
    numericToCents(sold.series[0].balance) > numericToCents(base.series[0].balance),
    'it applies on the day it is dated, including today',
  );
  assert.ok(everyday.id);
});
