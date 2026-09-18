// What the allowance is made of.
//
// "Everything else optional, day to day" is the largest optional figure in the
// app and it is a residue rather than a category anybody chose. Most of these
// test a specific way a breakdown of it could mislead: rows that do not add up
// to the head above them, a default drawn as a judgement, or something counted
// here that is already counted somewhere else.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getTestPool, resetDatabase, closeTestPool, makeAccount } from './helpers.js';
import { buildCostModel, optionalBreakdown } from '../src/costs.js';
import { centsToNumeric, numericToCents } from '../src/money.js';
import { daysAgo } from '../src/dates.js';

beforeEach(resetDatabase);
after(closeTestPool);

const cents = (value) => numericToCents(value);

let counter = 0;
async function spend(pool, accountId, { day, amount, description, merchant, categoryId = null, oneOff = false }) {
  await pool.query(
    `insert into transactions (account_id, redbark_txn_id, status, txn_date, description,
                               amount, merchant_key, category_id, one_off, raw)
     values ($1,$2,'posted',$3,$4,$5,$6,$7,$8,'{}'::jsonb)`,
    [accountId, `txn_c_${counter++}`, daysAgo(day), description,
     centsToNumeric(-amount), merchant, categoryId, oneOff],
  );
}

// A household where some optional places have been judged and some never have.
// Everything here is paid on at least three separate days, so nothing drops out
// on the gate that decides what is a rate.
async function household(pool) {
  const everyday = await makeAccount(pool, { masked_number: 'xxxx1111', is_liquid: true });
  await pool.query(
    "insert into balances (account_id, balance_date, balance) values ($1, current_date, '9000.00')",
    [everyday.id],
  );
  const { rows: [groceries] } = await pool.query(
    "insert into categories (name, kind, lean_tier) values ('Groceries','expense','trim') returning id",
  );
  await pool.query(
    "insert into merchants (match_key, display_name, source, lean_tier) values ('A CAFE','A cafe','manual','cut')",
  );
  await pool.query(
    "insert into merchants (match_key, display_name, source, lean_tier) values ('A SUPERMARKET','A supermarket','manual','trim')",
  );
  // No tier on this one and no category either: it lands in the allowance by
  // default rather than by anybody's decision.
  await pool.query(
    "insert into merchants (match_key, display_name, source) values ('A WAREHOUSE','A warehouse','manual')",
  );

  for (let day = 1; day <= 90; day += 3) {
    await spend(pool, everyday.id, { day, amount: 3000, description: 'A CAFE PERTH', merchant: 'A CAFE' });
  }
  for (let day = 2; day <= 90; day += 6) {
    await spend(pool, everyday.id, {
      day, amount: 20000, description: 'A SUPERMARKET 12', merchant: 'A SUPERMARKET', categoryId: groceries.id,
    });
  }
  for (let day = 4; day <= 90; day += 9) {
    await spend(pool, everyday.id, { day, amount: 15000, description: 'A WAREHOUSE 55', merchant: 'A WAREHOUSE' });
  }
  return everyday;
}

test('the places add up to the figure they are a breakdown of, exactly', async () => {
  const pool = await getTestPool();
  await household(pool);
  const costs = await buildCostModel({ window: 120, client: pool });
  const view = optionalBreakdown(costs);

  // Every place, including the tail the list stops naming. A breakdown that
  // rounds each row against a separately rounded total is a card that
  // disagrees with itself, which is the one thing it exists not to do.
  const named = view.places.reduce((total, row) => total + row.per_month_cents, 0);
  const tail = view.rest ? cents(view.rest.per_month) : 0;
  assert.equal(named + tail, view.per_month_cents);
  assert.equal(view.per_month_cents, costs.historical_discretionary_per_month_cents);
  assert.equal(cents(view.per_month), view.per_month_cents);

  // And the split is the same total seen another way.
  assert.equal(
    cents(view.judged.per_month) + cents(view.unjudged.per_month),
    view.per_month_cents,
  );
});

test('a default is not a judgement, and the breakdown says which is which', async () => {
  const pool = await getTestPool();
  await household(pool);
  const view = optionalBreakdown(await buildCostModel({ window: 120, client: pool }));

  const cafe = view.places.find((row) => row.name === 'A cafe');
  const warehouse = view.places.find((row) => row.name === 'A warehouse');
  assert.ok(cafe, 'the judged place is in the breakdown');
  assert.ok(warehouse, 'the unjudged place is in the breakdown');
  assert.equal(cafe.judged, true);
  assert.equal(warehouse.judged, false);
  assert.equal(view.judged.places, 1);
  assert.equal(view.unjudged.places, 1);
  assert.equal(cents(view.judged.per_month), cafe.per_month_cents);
  assert.equal(cents(view.unjudged.per_month), warehouse.per_month_cents);

  // The supermarket is could trim, so it is not optional and not in here at all.
  assert.equal(view.places.find((row) => row.name === 'A supermarket'), undefined);
});

test('judging a place moves it out of the never looked at pile without changing the total', async () => {
  const pool = await getTestPool();
  await household(pool);
  const before = optionalBreakdown(await buildCostModel({ window: 120, client: pool }));
  assert.ok(cents(before.unjudged.per_month) > 0);

  // Somebody says the warehouse really is optional. The figure does not move,
  // because the projection already counted it that way: what changes is that
  // the page can now say so honestly.
  await pool.query("update merchants set lean_tier = 'cut' where match_key = 'A WAREHOUSE'");
  const after = optionalBreakdown(await buildCostModel({ window: 120, client: pool }));
  assert.equal(after.per_month_cents, before.per_month_cents);
  assert.equal(after.unjudged.places, 0);
  assert.equal(cents(after.unjudged.per_month), 0);
  assert.equal(cents(after.judged.per_month), after.per_month_cents);

  // And saying it must be paid takes it out of the allowance entirely.
  await pool.query("update merchants set lean_tier = 'keep' where match_key = 'A WAREHOUSE'");
  const kept = optionalBreakdown(await buildCostModel({ window: 120, client: pool }));
  assert.ok(kept.per_month_cents < before.per_month_cents);
  assert.equal(kept.places.find((row) => row.name === 'A warehouse'), undefined);
});

test('nothing counted somewhere else is counted here', async () => {
  const pool = await getTestPool();
  const everyday = await household(pool);

  // A one off. It happened and every total shows it; it is not a guide to next
  // month, so it must not be inside a monthly rate.
  await pool.query(
    "insert into merchants (match_key, display_name, source) values ('A ROOFER','A roofer','manual')",
  );
  await spend(pool, everyday.id, {
    day: 10, amount: 3_000_000, description: 'A ROOFER', merchant: 'A ROOFER', oneOff: true,
  });

  // A repeating cost. It is projected on its own due dates, so counting it in
  // the allowance as well would charge the household twice for it.
  await pool.query(
    "insert into merchants (match_key, display_name, source) values ('A SUBSCRIPTION','A subscription','manual')",
  );
  for (let day = 5; day <= 90; day += 30) {
    await spend(pool, everyday.id, { day, amount: 4000, description: 'A SUBSCRIPTION', merchant: 'A SUBSCRIPTION' });
  }
  await pool.query(
    `insert into commitments (match_key, label, typical_amount, cadence_days, next_due,
                              occurrences, regularity, source)
     values ('SUBSCRIPTION', 'A SUBSCRIPTION', '-40.00', 30, current_date + 5, 3, 1, 'detected')`,
  );

  const view = optionalBreakdown(await buildCostModel({ window: 120, client: pool }));
  assert.equal(view.places.find((row) => row.name === 'A roofer'), undefined);
  assert.equal(view.places.find((row) => row.name === 'A subscription'), undefined);
});

test('a chosen figure and the life behind it are two claims, and both are reported', async () => {
  const pool = await getTestPool();
  await household(pool);

  const following = optionalBreakdown(await buildCostModel({ window: 120, client: pool }));
  assert.equal(following.chosen, false);
  assert.equal(following.in_force_per_month, following.per_month);
  assert.equal(cents(following.not_in_the_plan_per_month), 0);
  assert.equal(cents(following.above_history_per_month), 0);

  // Somebody chooses a figure well under what has actually been going out. The
  // breakdown still describes the spending, and names what the plan is not
  // carrying rather than quietly presenting its own total as the allowance.
  await pool.query("insert into settings (key, value) values ('forecast_discretionary_monthly', '100.00')");
  const chosen = optionalBreakdown(await buildCostModel({ window: 120, client: pool }));
  assert.equal(chosen.chosen, true);
  assert.equal(chosen.in_force_per_month, '100.00');
  assert.equal(chosen.per_month, following.per_month);
  assert.equal(
    cents(chosen.not_in_the_plan_per_month),
    chosen.per_month_cents - 10000,
  );
  assert.equal(cents(chosen.above_history_per_month), 0);

  // And the other way round, so no page has to read a minus sign.
  await pool.query("update settings set value = '99999.00' where key = 'forecast_discretionary_monthly'");
  const generous = optionalBreakdown(await buildCostModel({ window: 120, client: pool }));
  assert.equal(cents(generous.not_in_the_plan_per_month), 0);
  assert.equal(cents(generous.above_history_per_month), 9_999_900 - generous.per_month_cents);
});

test('a household with nothing optional gets an empty breakdown rather than a wrong one', async () => {
  const pool = await getTestPool();
  const everyday = await makeAccount(pool, { masked_number: 'xxxx1111', is_liquid: true });
  await pool.query(
    "insert into merchants (match_key, display_name, source, lean_tier) values ('A SUPERMARKET','A supermarket','manual','keep')",
  );
  for (let day = 1; day <= 30; day += 3) {
    await spend(pool, everyday.id, { day, amount: 12000, description: 'A SUPERMARKET 12', merchant: 'A SUPERMARKET' });
  }
  const view = optionalBreakdown(await buildCostModel({ window: 120, client: pool }));
  assert.equal(view.places.length, 0);
  assert.equal(view.rest, null);
  assert.equal(view.per_month, '0.00');
  assert.equal(view.judged.places, 0);
  assert.equal(view.unjudged.places, 0);
});
