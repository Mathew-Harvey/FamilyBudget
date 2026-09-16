// Stage 2: categories, rules and the precedence between them.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getTestPool, resetDatabase, closeTestPool, makeAccount } from './helpers.js';
import { categoriseAll, ruleMatches, firstMatchingRule, setCategoryManually } from '../src/categorise.js';
import { centsToNumeric } from '../src/money.js';

beforeEach(async () => {
  const pool = await resetDatabase();
  await pool.query('truncate rules, provider_category_map, categories cascade');
  return pool;
});
after(closeTestPool);

async function makeCategory(pool, name, { kind = 'expense', group = null } = {}) {
  const { rows } = await pool.query(
    'insert into categories (parent_id, name, kind) values ($1, $2, $3) returning *',
    [group, name, kind],
  );
  return rows[0];
}

async function makeRule(pool, overrides = {}) {
  const rule = {
    position: 10,
    name: 'A rule',
    match_field: 'any',
    match_type: 'contains',
    match_value: null,
    account_id: null,
    direction: null,
    min_amount: null,
    max_amount: null,
    category_id: null,
    rename_to: null,
    set_note: null,
    ...overrides,
  };
  const { rows } = await pool.query(
    `insert into rules (position, name, match_field, match_type, match_value, account_id,
                        direction, min_amount, max_amount, category_id, rename_to, set_note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [
      rule.position, rule.name, rule.match_field, rule.match_type, rule.match_value,
      rule.account_id, rule.direction, rule.min_amount, rule.max_amount,
      rule.category_id, rule.rename_to, rule.set_note,
    ],
  );
  return rows[0];
}

async function addTxn(pool, accountId, { date = '2026-03-01', cents = -5000, description = 'TEST', provider = null, merchant = null }) {
  const { rows } = await pool.query(
    `insert into transactions (account_id, redbark_txn_id, status, txn_date, description,
                               amount, provider_category, merchant_name, raw)
     values ($1,$2,'posted',$3,$4,$5,$6,$7,'{}'::jsonb) returning id`,
    [accountId, `txn_${Math.random().toString(36).slice(2, 14)}`, date, description, centsToNumeric(cents), provider, merchant],
  );
  return rows[0].id;
}

const categoryOf = async (pool, id) =>
  (await pool.query(
    `select c.name, t.category_source, t.display_description, t.note
       from transactions t left join categories c on c.id = t.category_id where t.id = $1`,
    [id],
  )).rows[0];

test('a matching rule sets the category', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  const groceries = await makeCategory(pool, 'Groceries');
  await makeRule(pool, { match_value: 'WOOLWORTHS', category_id: groceries.id });

  const hit = await addTxn(pool, account.id, { description: 'WOOLWORTHS 1234 PERTH' });
  const miss = await addTxn(pool, account.id, { description: 'BUNNINGS 5678' });

  assert.equal(await categoriseAll({ pool }), 1);
  assert.equal((await categoryOf(pool, hit)).name, 'Groceries');
  assert.equal((await categoryOf(pool, hit)).category_source, 'rule');
  assert.equal((await categoryOf(pool, miss)).name, null);
});

test('rules are evaluated top to bottom and the first match wins', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  const fuel = await makeCategory(pool, 'Fuel');
  const shopping = await makeCategory(pool, 'Shopping');

  await makeRule(pool, { position: 10, name: 'fuel first', match_value: 'COLES EXPRESS', category_id: fuel.id });
  await makeRule(pool, { position: 20, name: 'coles generally', match_value: 'COLES', category_id: shopping.id });

  const id = await addTxn(pool, account.id, { description: 'COLES EXPRESS 42' });
  await categoriseAll({ pool });
  assert.equal((await categoryOf(pool, id)).name, 'Fuel', 'the earlier rule should win');
});

test('a category set by hand is never overwritten by a rule', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  const groceries = await makeCategory(pool, 'Groceries');
  const gifts = await makeCategory(pool, 'Gifts');
  await makeRule(pool, { match_value: 'WOOLWORTHS', category_id: groceries.id });

  const id = await addTxn(pool, account.id, { description: 'WOOLWORTHS 1234' });
  await categoriseAll({ pool });
  assert.equal((await categoryOf(pool, id)).name, 'Groceries');

  await setCategoryManually(id, gifts.id, pool);
  assert.equal((await categoryOf(pool, id)).category_source, 'manual');

  await categoriseAll({ pool });
  const after = await categoryOf(pool, id);
  assert.equal(after.name, 'Gifts', 'the manual choice must survive recategorising');
  assert.equal(after.category_source, 'manual');
});

test('the provider category is the fallback when no rule matches', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  const food = await makeCategory(pool, 'Food');
  await pool.query('insert into provider_category_map (provider_category, category_id) values ($1, $2)', [
    'FOOD_AND_DRINK',
    food.id,
  ]);

  const id = await addTxn(pool, account.id, { description: 'SOME CAFE', provider: 'FOOD_AND_DRINK' });
  await categoriseAll({ pool });
  const result = await categoryOf(pool, id);
  assert.equal(result.name, 'Food');
  assert.equal(result.category_source, 'provider', 'the bank label is weaker than a rule');
});

test('a rule beats the provider category', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  const food = await makeCategory(pool, 'Food');
  const work = await makeCategory(pool, 'Work expenses');
  await pool.query('insert into provider_category_map (provider_category, category_id) values ($1, $2)', [
    'FOOD_AND_DRINK',
    food.id,
  ]);
  await makeRule(pool, { match_value: 'CATERING', category_id: work.id });

  const id = await addTxn(pool, account.id, { description: 'BIG CATERING CO', provider: 'FOOD_AND_DRINK' });
  await categoriseAll({ pool });
  assert.equal((await categoryOf(pool, id)).name, 'Work expenses');
});

test('categorising twice changes nothing the second time', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  const food = await makeCategory(pool, 'Food');
  await makeRule(pool, { match_value: 'CAFE', category_id: food.id, rename_to: 'Coffee' });
  await addTxn(pool, account.id, { description: 'THE CAFE' });
  await addTxn(pool, account.id, { description: 'SOMETHING ELSE' });

  assert.equal(await categoriseAll({ pool }), 1);
  assert.equal(await categoriseAll({ pool }), 0, 'a settled set must report no changes');
});

test('a rule can rename a transaction for display without touching the original', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  await makeRule(pool, { match_value: 'SQ *THE LITTLE', rename_to: 'The Little Bakery', set_note: 'weekly bread' });

  const id = await addTxn(pool, account.id, { description: 'SQ *THE LITTLE B 123456' });
  await categoriseAll({ pool });

  const result = await categoryOf(pool, id);
  assert.equal(result.display_description, 'The Little Bakery');
  assert.equal(result.note, 'weekly bread');

  const { rows } = await pool.query('select description from transactions where id = $1', [id]);
  assert.equal(rows[0].description, 'SQ *THE LITTLE B 123456', 'the bank description is left alone');
});

test('a disabled rule does nothing', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  const food = await makeCategory(pool, 'Food');
  await makeRule(pool, { match_value: 'CAFE', category_id: food.id });
  await pool.query('update rules set enabled = false');

  const id = await addTxn(pool, account.id, { description: 'THE CAFE' });
  await categoriseAll({ pool });
  assert.equal((await categoryOf(pool, id)).name, null);
});

test('conditions narrow a rule: account, direction and amount', () => {
  const base = {
    match_field: 'any',
    match_type: 'contains',
    match_value: null,
    account_id: null,
    direction: null,
    min_amount: null,
    max_amount: null,
  };
  const txn = { account_id: 'acct-a', amount_cents: -5000, description: 'SHOP' };

  assert.equal(ruleMatches({ ...base, account_id: 'acct-a' }, txn), true);
  assert.equal(ruleMatches({ ...base, account_id: 'acct-b' }, txn), false);

  assert.equal(ruleMatches({ ...base, direction: 'debit' }, txn), true);
  assert.equal(ruleMatches({ ...base, direction: 'credit' }, txn), false);

  // Bounds compare magnitudes, because people think in sizes not signs.
  assert.equal(ruleMatches({ ...base, min_amount: '10.00' }, txn), true);
  assert.equal(ruleMatches({ ...base, min_amount: '100.00' }, txn), false);
  assert.equal(ruleMatches({ ...base, max_amount: '100.00' }, txn), true);
  assert.equal(ruleMatches({ ...base, max_amount: '10.00' }, txn), false);
});

test('the match types behave as named', () => {
  const txn = { description: 'WOOLWORTHS METRO 1234', merchant_name: null, reference: null, extended_description: null };
  const rule = (over) => ({ match_field: 'description', match_type: 'contains', ...over });

  assert.equal(ruleMatches(rule({ match_value: 'METRO' }), txn), true);
  assert.equal(ruleMatches(rule({ match_type: 'equals', match_value: 'WOOLWORTHS METRO 1234' }), txn), true);
  assert.equal(ruleMatches(rule({ match_type: 'equals', match_value: 'WOOLWORTHS' }), txn), false);
  assert.equal(ruleMatches(rule({ match_type: 'starts_with', match_value: 'WOOLWORTHS' }), txn), true);
  assert.equal(ruleMatches(rule({ match_type: 'starts_with', match_value: 'METRO' }), txn), false);
  assert.equal(ruleMatches(rule({ match_type: 'regex', match_value: '^WOOL\\w+ METRO \\d+$' }), txn), true);
  assert.equal(ruleMatches(rule({ match_type: 'regex', match_value: '^NOPE' }), txn), false);
});

test('a broken pattern never matches and never throws', () => {
  const txn = { description: 'ANYTHING', merchant_name: null, reference: null, extended_description: null };
  assert.equal(ruleMatches({ match_field: 'any', match_type: 'regex', match_value: '([unclosed' }, txn), false);
});

test('matching on any field searches all of them', () => {
  const txn = {
    description: 'CARD PURCHASE',
    merchant_name: 'Bunnings Warehouse',
    reference: null,
    extended_description: null,
  };
  assert.equal(ruleMatches({ match_field: 'any', match_type: 'contains', match_value: 'BUNNINGS' }, txn), true);
  assert.equal(
    ruleMatches({ match_field: 'description', match_type: 'contains', match_value: 'BUNNINGS' }, txn),
    false,
    'narrowing to description should not see the merchant',
  );
});

test('clearing a category by hand unpins it so rules apply again', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  const food = await makeCategory(pool, 'Food');
  const other = await makeCategory(pool, 'Other');
  await makeRule(pool, { match_value: 'CAFE', category_id: food.id });

  const id = await addTxn(pool, account.id, { description: 'THE CAFE' });
  await setCategoryManually(id, other.id, pool);
  await categoriseAll({ pool });
  assert.equal((await categoryOf(pool, id)).name, 'Other');

  await setCategoryManually(id, null, pool);
  assert.equal((await categoryOf(pool, id)).category_source, null);
  await categoriseAll({ pool });
  assert.equal((await categoryOf(pool, id)).name, 'Food', 'the rule takes over again');
});

test('firstMatchingRule returns null when nothing matches', () => {
  const rules = [{ match_field: 'any', match_type: 'contains', match_value: 'NOPE' }];
  assert.equal(firstMatchingRule(rules, { description: 'SOMETHING' }), null);
});


test('the seeded taxonomy names fuel as fuel and gives public transport its own line', async () => {
  const pool = await getTestPool();
  const { readFile } = await import('node:fs/promises');
  const client = await pool.connect();
  try {
    // Replay the seed and the relabel inside a transaction that is rolled back,
    // so this checks the migrations as shipped without depending on suite order.
    await client.query('begin');
    await client.query(await readFile(new URL('../migrations/004_seed_taxonomy.sql', import.meta.url), 'utf8'));
    await client.query(await readFile(new URL('../migrations/014_transport_relabel.sql', import.meta.url), 'utf8'));

    const { rows } = await client.query(
      `select c.name from categories c join categories g on g.id = c.parent_id
        where g.name = 'Getting around' order by c.sort_order`,
    );
    assert.deepEqual(rows.map((r) => r.name), ['Fuel and car', 'Public transport', 'Travel and holidays']);
    const gone = await client.query("select count(*)::int as n from categories where name in ('Transport', 'Travel')");
    assert.equal(gone.rows[0].n, 0, 'the ambiguous names are gone');
    const rule = await client.query("select match_value from rules where name = 'SmartRider is public transport'");
    assert.equal(rule.rows[0].match_value, 'SMARTRIDER');
  } finally {
    await client.query('rollback');
    client.release();
  }
});
