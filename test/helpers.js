// Test support. The first thing this does is refuse to run against anything
// that is not a dedicated test database.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPool } from '../src/db.js';
import { runMigrations } from '../scripts/migrate.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// This app holds our entire financial history. A test run must never be able to
// touch it, so the guard is unconditional and runs before any pool is opened.
export function assertSafeTestDatabase() {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Tests need their own database, and will not fall back to DATABASE_URL.',
    );
  }
  if (process.env.DATABASE_URL && testUrl === process.env.DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL is the same as DATABASE_URL. Point it at a separate database.');
  }
  return testUrl;
}

let pool;

export async function getTestPool() {
  if (pool) return pool;
  const url = assertSafeTestDatabase();

  // Defence in depth. The guard above has already proven these are different
  // databases, so pointing DATABASE_URL at the test one now means any code path
  // that quietly falls back to the shared pool still cannot reach live data.
  process.env.DATABASE_URL = url;

  pool = createPool(url);
  await runMigrations(pool, { log: () => {} });
  return pool;
}

// Everything a test can write to, in one list.
//
// Six files kept their own copy of this and they had drifted: forecast.test.js
// was missing settings, so inserting the discretionary allowance collided with
// the row migration 027 seeds and the file could not be run on its own. One
// list, for the same reason there is one matchKeyFor.
const DOMAIN_TABLES = [
  'analyses', 'alert_log', 'intentions', 'goals', 'settings',
  'commitments', 'expected_income', 'assets',
  'bucket_allocations', 'bucket_categories', 'buckets',
  'pay_periods', 'pay_cycle',
  'rules', 'provider_category_map', 'merchants', 'categories',
  'transfer_rejections', 'balances', 'transactions', 'accounts',
  'sync_runs', 'users',
];

export async function resetDatabase() {
  const p = await getTestPool();
  // Order matters only for readability, cascade does the work.
  await p.query(`truncate ${DOMAIN_TABLES.join(', ')} cascade`);
  return p;
}

export async function closeTestPool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function loadFixture(name) {
  return JSON.parse(await readFile(path.join(FIXTURES_DIR, name), 'utf8'));
}

// Inserts an account and returns its row.
export async function makeAccount(client, overrides = {}) {
  const account = {
    source: 'redbark',
    redbark_connection_id: 'conn_test',
    redbark_account_id: `acct_${Math.random().toString(36).slice(2, 12)}`,
    bank: 'Test Bank',
    name: 'Test Account',
    masked_number: 'xxxx1111',
    type: 'transaction',
    is_liquid: true,
    ...overrides,
  };
  const { rows } = await client.query(
    `insert into accounts (source, redbark_connection_id, redbark_account_id, bank, name,
                           masked_number, type, is_liquid, role)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning *`,
    [
      account.source,
      account.redbark_connection_id,
      account.redbark_account_id,
      account.bank,
      account.name,
      account.masked_number,
      account.type,
      account.is_liquid,
      account.role ?? null,
    ],
  );
  return rows[0];
}

// Builds a Redbark shaped transaction. Amounts are integer cents, as the API
// sends them.
export function redbarkTxn(overrides = {}) {
  const id = overrides.id ?? `txn_fk_bank_tx_s_${Math.random().toString(16).slice(2).padEnd(64, '0').slice(0, 64)}`;
  return {
    id,
    object: 'transaction',
    account: overrides.account ?? 'acct_test',
    status: 'posted',
    date: '2026-03-01',
    datetime: '2026-03-01T14:00:00.000Z',
    post_date: '2026-03-02',
    post_datetime: '2026-03-02T01:00:00.000Z',
    value_date: null,
    value_datetime: null,
    description: 'TEST TRANSACTION',
    reference: null,
    extended_description: null,
    amount: { amount: -1000, currency: 'aud' },
    direction: 'debit',
    provider_category: 'SERVICES',
    category: null,
    merchant_name: null,
    merchant_category_code: null,
    livemode: true,
    ...overrides,
  };
}

// A fake Redbark client, so no test ever reaches the network.
export function fakeRedbark({ accounts = [], transactionsByAccount = {}, balances = [] } = {}) {
  const calls = { listAccounts: 0, listTransactions: [], listBalances: 0 };
  return {
    calls,
    async listAccounts() {
      calls.listAccounts++;
      return accounts;
    },
    async listTransactions({ accountId, from, to }) {
      calls.listTransactions.push({ accountId, from, to });
      return { rows: transactionsByAccount[accountId] ?? [], truncated: false };
    },
    async listBalances() {
      calls.listBalances++;
      return balances;
    },
  };
}
