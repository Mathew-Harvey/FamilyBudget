// Upsert, dedupe and pending to posted resolution, against a real database.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTestPool,
  resetDatabase,
  closeTestPool,
  makeAccount,
  redbarkTxn,
  fakeRedbark,
  loadFixture,
  assertSafeTestDatabase,
} from './helpers.js';
import { persistTransactions, upsertAccounts, runSync, mapTransaction, findPendingMatch } from '../src/sync.js';
import { numericToCents } from '../src/money.js';

beforeEach(resetDatabase);
after(closeTestPool);

test('the test database guard refuses to run against the live database', () => {
  const saved = { test: process.env.TEST_DATABASE_URL, live: process.env.DATABASE_URL };
  try {
    delete process.env.TEST_DATABASE_URL;
    assert.throws(() => assertSafeTestDatabase(), /TEST_DATABASE_URL is not set/);

    process.env.TEST_DATABASE_URL = 'postgresql://someone@host/samedb';
    process.env.DATABASE_URL = 'postgresql://someone@host/samedb';
    assert.throws(() => assertSafeTestDatabase(), /same as DATABASE_URL/);
  } finally {
    process.env.TEST_DATABASE_URL = saved.test;
    if (saved.live === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.live;
  }
});

test('the same payload synced twice produces no new rows', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  const payload = [
    redbarkTxn({ id: 'txn_fk_bank_tx_s_aaa', description: 'ONE', amount: { amount: -1000, currency: 'aud' } }),
    redbarkTxn({ id: 'txn_fk_bank_tx_s_bbb', description: 'TWO', amount: { amount: -2500, currency: 'aud' } }),
    redbarkTxn({ id: 'txn_fk_bank_tx_s_ccc', description: 'THREE', amount: { amount: 30000, currency: 'aud' } }),
  ];

  const first = await persistTransactions(pool, account.id, payload);
  assert.equal(first.inserted, 3);
  assert.equal(first.updated, 0);

  const second = await persistTransactions(pool, account.id, payload);
  assert.equal(second.inserted, 0, 'a second identical sync must insert nothing');
  assert.equal(second.updated, 0, 'a second identical sync must update nothing');

  const { rows } = await pool.query('select count(*)::int as n from transactions');
  assert.equal(rows[0].n, 3);
});

test('a changed field updates the existing row rather than adding one', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  const txn = redbarkTxn({ id: 'txn_fk_bank_tx_s_ddd', description: 'BEFORE' });

  await persistTransactions(pool, account.id, [txn]);
  const changed = { ...txn, description: 'AFTER' };
  const result = await persistTransactions(pool, account.id, [changed]);

  assert.equal(result.inserted, 0);
  assert.equal(result.updated, 1);
  const { rows } = await pool.query('select description, count(*) over ()::int as n from transactions');
  assert.equal(rows[0].description, 'AFTER');
  assert.equal(rows[0].n, 1);
});

test('amounts are stored as exact decimals', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  const awkward = [-676, -15970, 180000, 5, -1, 0, -60272035];
  await persistTransactions(
    pool,
    account.id,
    awkward.map((cents, i) =>
      redbarkTxn({ id: `txn_fk_bank_tx_s_amt${i}`, amount: { amount: cents, currency: 'aud' } }),
    ),
  );

  const { rows } = await pool.query('select amount from transactions order by amount');
  const stored = rows.map((row) => numericToCents(row.amount)).sort((a, b) => a - b);
  assert.deepEqual(stored, [...awkward].sort((a, b) => a - b));
  // Every value came back as a string, never a float.
  assert.ok(rows.every((row) => typeof row.amount === 'string'));
});

test('a pending transaction that posts under a new id replaces the pending row', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);

  const pending = redbarkTxn({
    id: 'txn_fk_bank_tx_s_pending1',
    status: 'pending',
    date: '2026-03-01',
    description: 'BUNNINGS HALLS HEAD 2707',
    amount: { amount: -18618, currency: 'aud' },
  });
  await persistTransactions(pool, account.id, [pending]);

  const before = await pool.query('select id, first_seen_at, status from transactions');
  assert.equal(before.rowCount, 1);
  assert.equal(before.rows[0].status, 'pending');
  const originalRowId = before.rows[0].id;

  // Redbark stops returning the pending row and returns a posted one whose id
  // is different, because the id is a hash of the content.
  const posted = redbarkTxn({
    id: 'txn_fk_bank_tx_s_posted1',
    status: 'posted',
    date: '2026-03-02',
    description: 'BUNNINGS HALLS HEAD 2707 4512',
    amount: { amount: -18618, currency: 'aud' },
  });
  const result = await persistTransactions(pool, account.id, [posted]);

  assert.equal(result.pendingResolved, 1, 'the posted row should resolve the pending one');
  assert.equal(result.inserted, 0, 'it must not be inserted as a second row');

  const after = await pool.query('select id, status, redbark_txn_id, first_seen_at from transactions');
  assert.equal(after.rowCount, 1, 'there must be exactly one row, not a duplicate');
  assert.equal(after.rows[0].status, 'posted');
  assert.equal(after.rows[0].redbark_txn_id, 'txn_fk_bank_tx_s_posted1');
  assert.equal(after.rows[0].id, originalRowId, 'the row is updated in place, so its id is unchanged');
  assert.deepEqual(
    after.rows[0].first_seen_at,
    before.rows[0].first_seen_at,
    'first_seen_at survives the transition',
  );
});

test('an in place pending resolution keeps the Stage 2 category and any transfer pairing', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  await persistTransactions(pool, account.id, [
    redbarkTxn({ id: 'txn_p', status: 'pending', description: 'TELSTRA', amount: { amount: -27463, currency: 'aud' } }),
  ]);

  // Stage 2 writes this, and it must survive the row being resolved.
  const { rows: made } = await pool.query(
    "insert into categories (name, kind) values ('Utilities for this test', 'expense') returning id",
  );
  const categoryId = made[0].id;
  await pool.query('update transactions set category_id = $1', [categoryId]);

  await persistTransactions(pool, account.id, [
    redbarkTxn({ id: 'txn_q', status: 'posted', description: 'TELSTRA SERVICES', amount: { amount: -27463, currency: 'aud' } }),
  ]);

  const { rows } = await pool.query('select category_id, status from transactions');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'posted');
  assert.equal(rows[0].category_id, categoryId, 'the category must not be lost when a pending row posts');
});

test('a pending row Redbark stops returning is removed once it is stale', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  await persistTransactions(pool, account.id, [
    redbarkTxn({ id: 'txn_cancelled', status: 'pending', description: 'CANCELLED AUTH', amount: { amount: -5000, currency: 'aud' } }),
  ]);

  // Still young: an empty read must not delete it, because it may just be
  // outside the window we asked for.
  const young = await persistTransactions(pool, account.id, []);
  assert.equal(young.pendingExpired, 0);
  assert.equal((await pool.query('select count(*)::int as n from transactions')).rows[0].n, 1);

  // Age it past the expiry window.
  await pool.query("update transactions set last_seen_at = now() - interval '11 days'");
  const stale = await persistTransactions(pool, account.id, []);
  assert.equal(stale.pendingExpired, 1, 'a pending row unseen for 10 days was cancelled or reversed');
  assert.equal((await pool.query('select count(*)::int as n from transactions')).rows[0].n, 0);
});

test('a posted row does not steal a pending row that is still being returned', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  const pending = redbarkTxn({
    id: 'txn_still_pending',
    status: 'pending',
    description: 'COLES 1234',
    amount: { amount: -5000, currency: 'aud' },
  });
  await persistTransactions(pool, account.id, [pending]);

  // A genuinely separate purchase of the same amount, while the pending one is
  // still in the feed. Both must survive.
  const posted = redbarkTxn({
    id: 'txn_separate',
    status: 'posted',
    date: '2026-03-03',
    description: 'COLES 1234',
    amount: { amount: -5000, currency: 'aud' },
  });
  const result = await persistTransactions(pool, account.id, [pending, posted]);

  assert.equal(result.pendingResolved, 0);
  assert.equal(result.inserted, 1);
  assert.equal((await pool.query('select count(*)::int as n from transactions')).rows[0].n, 2);
});

test('two equally good pending candidates resolve neither', () => {
  const posted = { amount_cents: -5000, txn_date: '2026-03-03', description: 'COLES 1234' };
  const candidates = [
    { id: 'a', amount_cents: -5000, txn_date: '2026-03-02', description: 'COLES 1234' },
    { id: 'b', amount_cents: -5000, txn_date: '2026-03-02', description: 'COLES 1234' },
  ];
  assert.equal(findPendingMatch(posted, candidates), null, 'a tie must not be guessed');
});

test('an unrelated transaction of the same amount is not treated as a posting', () => {
  const posted = { amount_cents: -5000, txn_date: '2026-03-03', description: 'WOOLWORTHS METRO' };
  const candidates = [{ id: 'a', amount_cents: -5000, txn_date: '2026-03-02', description: 'BP SERVICE STATION' }];
  assert.equal(findPendingMatch(posted, candidates), null);
});

test('mapping trims the padding banks put in merchant_name', () => {
  const mapped = mapTransaction(redbarkTxn({ merchant_name: 'SHHPS P&C                ' }));
  assert.equal(mapped.merchant_name, 'SHHPS P&C');
});

test('accounts upsert without overwriting the role and is_liquid a person set', async () => {
  const pool = await getTestPool();
  const payload = [
    {
      id: 'acct_one',
      connection: 'conn_one',
      name: 'Everyday',
      type: 'transaction',
      account_number: 'xxxx9529',
      currency: 'aud',
      status: 'available',
      institution: { name: 'ING' },
    },
  ];
  await upsertAccounts(pool, payload);
  await pool.query("update accounts set role = 'joint_everyday', is_liquid = false");

  // A later sync renames the account at the bank.
  await upsertAccounts(pool, [{ ...payload[0], name: 'Orange Everyday' }]);

  const { rows } = await pool.query('select name, role, is_liquid, count(*) over ()::int as n from accounts');
  assert.equal(rows[0].n, 1, 'the account must not be duplicated');
  assert.equal(rows[0].name, 'Orange Everyday', 'bank owned fields do update');
  assert.equal(rows[0].role, 'joint_everyday', 'the role a person set must survive a sync');
  assert.equal(rows[0].is_liquid, false, 'is_liquid must survive a sync');
});

test('a loan account defaults to not liquid', async () => {
  const pool = await getTestPool();
  await upsertAccounts(pool, [
    {
      id: 'acct_loan',
      connection: 'conn_cba',
      name: 'Home Loan',
      type: 'loan',
      account_number: 'xxxx0194',
      currency: 'aud',
      status: 'available',
      institution: { name: 'CommBank' },
    },
  ]);
  const { rows } = await pool.query('select is_liquid from accounts');
  assert.equal(rows[0].is_liquid, false);
});

test('a full run records a sync_runs row and survives one account failing', async () => {
  const pool = await getTestPool();
  const accounts = [
    { id: 'acct_ok', connection: 'c1', name: 'Good', type: 'transaction', account_number: 'xxxx1111', currency: 'aud', status: 'available', institution: { name: 'ING' } },
    { id: 'acct_bad', connection: 'c1', name: 'Bad', type: 'transaction', account_number: 'xxxx2222', currency: 'aud', status: 'available', institution: { name: 'ING' } },
  ];
  const api = fakeRedbark({
    accounts,
    transactionsByAccount: { acct_ok: [redbarkTxn({ id: 'txn_ok_1' })] },
  });
  // One account blows up, the other must still be synced.
  const original = api.listTransactions;
  api.listTransactions = async (args) => {
    if (args.accountId === 'acct_bad') throw new Error('bank unavailable');
    return original(args);
  };

  const result = await runSync({ client: api, pool, log: () => {} });

  assert.equal(result.status, 'partial');
  assert.equal(result.accounts_synced, 1);
  assert.equal(result.txns_inserted, 1);
  assert.match(result.failures.join(' '), /bank unavailable/);

  const { rows } = await pool.query('select status, error_message, txns_inserted from sync_runs');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'partial');
  assert.match(rows[0].error_message, /bank unavailable/);
});

test('the redacted fixtures parse and map cleanly', async () => {
  const pool = await getTestPool();
  const fixtures = await loadFixture('transactions.json');
  assert.ok(fixtures.length > 50, 'expected a useful number of fixture rows');

  const account = await makeAccount(pool);
  const forOneAccount = fixtures.filter((t) => t.account === fixtures[0].account);
  const first = await persistTransactions(pool, account.id, forOneAccount);
  assert.equal(first.inserted, forOneAccount.length);

  // The acceptance criterion, run over real shaped data.
  const second = await persistTransactions(pool, account.id, forOneAccount);
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 0);

  // Pending rows survived redaction, so the fixtures still exercise that path.
  assert.ok(fixtures.some((t) => t.status === 'pending'), 'fixtures must keep pending rows');
  assert.ok(fixtures.some((t) => t.amount.amount === 0), 'fixtures must keep a zero amount row');
});

test('relinking a connection repoints the account instead of duplicating it', async () => {
  const pool = await getTestPool();

  // The account as it arrived the first time, then set up the way a person
  // would: spendable, with a role, and carrying history.
  const before = [{
    id: 'acct_old', connection: 'conn_old', account_number: 'xxxx9529', type: 'transaction',
    name: 'ING Australia Orange Everyday', currency: 'aud', status: 'available',
    institution: { name: 'ING BANK (Australia) Ltd' },
  }];
  const [first] = await upsertAccounts(pool, before);
  await pool.query("update accounts set is_liquid = true, role = 'joint_everyday' where id = $1", [first.accountId]);

  // Consent is renewed, the connection is relinked, and every account behind it
  // comes back with an id we have never seen. Only the number is the same.
  const after = [{ ...before[0], id: 'acct_new', connection: 'conn_new' }];
  const [second] = await upsertAccounts(pool, after);

  assert.equal(second.accountId, first.accountId, 'it has to be the same account row');

  const { rows } = await pool.query(
    "select id, redbark_account_id, redbark_connection_id, is_liquid, role from accounts where masked_number = 'xxxx9529'",
  );
  assert.equal(rows.length, 1, 'one account, not two');
  assert.equal(rows[0].redbark_account_id, 'acct_new', 'pointed at the new id');
  assert.equal(rows[0].redbark_connection_id, 'conn_new');
  // The settings the whole forecast depends on. Losing these is how this fails
  // silently: spendable cash gets read off a new empty row and nothing errors.
  assert.equal(rows[0].is_liquid, true, 'is_liquid survives');
  assert.equal(rows[0].role, 'joint_everyday', 'and so does the role');
});

test('an account entered by hand is adopted when open banking starts serving it', async () => {
  const pool = await getTestPool();

  // A debt that open banking could not reach, entered by hand with a balance.
  const { rows: [manual] } = await pool.query(
    `insert into accounts (source, bank, name, masked_number, is_liquid, role)
     values ('manual', 'ING BANK (Australia) Ltd', 'ING personal loan', 'xxxx8937', false, 'personal_loan')
     returning id`,
  );
  await pool.query(
    `insert into balances (account_id, balance_date, balance) values ($1, current_date, '-11150.00')`,
    [manual.id],
  );

  const [adopted] = await upsertAccounts(pool, [{
    id: 'acct_loan', connection: 'conn_new', account_number: 'xxxx8937', type: 'loan',
    name: 'ING Australia Personal Loan', currency: 'aud', status: 'available',
    institution: { name: 'ING BANK (Australia) Ltd' },
  }]);

  assert.equal(adopted.accountId, manual.id, 'the same row, now connected');

  const { rows } = await pool.query(
    `select a.name, a.role, a.is_liquid, a.redbark_account_id, b.balance
       from accounts a
       left join balances b on b.account_id = a.id
      where a.masked_number = 'xxxx8937'`,
  );
  assert.equal(rows.length, 1, 'one account, not two');
  assert.equal(rows[0].redbark_account_id, 'acct_loan');
  assert.equal(rows[0].is_liquid, false, 'a loan is not spendable cash');
  assert.equal(rows[0].role, 'personal_loan', 'the role someone set is theirs');
  assert.equal(rows[0].name, 'ING personal loan', 'and so is the name they gave it');
  assert.equal(numericToCents(rows[0].balance), -1115000, 'the balance they entered survives');
});
