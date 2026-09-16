#!/usr/bin/env node
// Discovery tool. Calls Redbark for connections, accounts, balances and a
// window of transactions per account, then prints a structural summary: field
// names, types, example shapes and the answers to the questions that decide
// how the parsers are written.
//
//   npm run discover                 summary only
//   npm run discover -- --fixtures   also write redacted samples to test/fixtures
//   npm run discover -- --days 90    widen the transaction window
//
// With --fixtures the output is redacted: descriptions become generic text,
// amounts become dummy values, account numbers and names are masked. Structure,
// field names, id formats, sign conventions and pending flags are preserved
// exactly, because those are what the tests need to exercise.
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createClient } from '../src/redbark.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

function parseArgs(argv) {
  const args = { fixtures: false, days: 45 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fixtures') args.fixtures = true;
    else if (argv[i] === '--days') args.days = Number(argv[++i]);
  }
  return args;
}

const isoDate = (d) => d.toISOString().slice(0, 10);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// Describes the fields of a set of objects: which keys appear, what types they
// take, and how often a key is null. That is what tells us whether a field can
// be relied on.
function describeShape(rows, label) {
  const lines = [`${label}: ${rows.length} row(s)`];
  if (!rows.length) return lines;
  const fields = new Map();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!fields.has(key)) fields.set(key, { types: new Set(), nulls: 0, example: undefined });
      const f = fields.get(key);
      f.types.add(typeOf(value));
      if (value === null) f.nulls++;
      else if (f.example === undefined) f.example = value;
    }
  }
  for (const [key, f] of fields) {
    const types = [...f.types].join('|');
    const nullNote = f.nulls ? `, null in ${f.nulls}/${rows.length}` : '';
    let example = JSON.stringify(f.example);
    if (example && example.length > 60) example = `${example.slice(0, 57)}...`;
    lines.push(`   ${key.padEnd(22)} ${types.padEnd(18)}${nullNote.padEnd(20)} eg ${example}`);
  }
  return lines;
}

function tally(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = typeof key === 'function' ? key(row) : row[key];
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------------------
// Redaction. Structure in, structure out, with every real detail replaced.
// ---------------------------------------------------------------------------

const GENERIC_DESCRIPTIONS = [
  'CARD PURCHASE MERCHANT ONE',
  'DIRECT DEBIT BILLER TWO',
  'INTERNAL TRANSFER 000000 00000000',
  'INTERNAL TRANSFER TO LINKED ACCOUNT',
  'SALARY EMPLOYER',
  'CARD PURCHASE MERCHANT THREE',
];

// Dates are shifted by one constant number of days across every fixture, so no
// real date is published while every relationship between dates, the gap
// between a transaction and its posting, the ordering, the pending window, is
// preserved exactly. Anchored so the newest row lands on a fixed day.
const FIXTURE_ANCHOR_DATE = Date.parse('2026-01-15T00:00:00.000Z');
let dateShiftMs = 0;

export function setDateShiftFromNewest(rows) {
  const newest = rows
    .map((r) => Date.parse(r.date))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a)[0];
  dateShiftMs = Number.isFinite(newest) ? FIXTURE_ANCHOR_DATE - newest : 0;
}

// Shifts "2026-09-15" and "2026-09-15T14:00:00.000Z" alike, keeping the format.
function shiftMoment(value) {
  if (typeof value !== 'string') return value;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  const shifted = new Date(parsed + dateShiftMs).toISOString();
  return dateOnly ? shifted.slice(0, 10) : shifted;
}

const MOMENT_FIELDS = [
  'date', 'datetime', 'post_date', 'post_datetime', 'value_date', 'value_datetime',
  'created', 'updated', 'last_updated_at', 'last_refreshed_at', 'ready_at',
  'expires_at', 'withdrawn_at', 'observed_at',
];

function shiftMoments(object) {
  const out = { ...object };
  for (const field of MOMENT_FIELDS) {
    if (field in out) out[field] = shiftMoment(out[field]);
  }
  return out;
}

// A stable, non reversible short code, so the same real value maps to the same
// fake value across a fixture set and the relationships stay intact.
function codeFor(seed, value) {
  let hash = 2166136261;
  const text = `${seed}:${value ?? ''}`;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function redactId(id) {
  if (typeof id !== 'string') return id;
  // Keep the prefix, which is the part parsers care about, replace the rest.
  const match = /^([a-z]+(?:_[a-z]+)*)_([0-9A-Za-z-]+)$/.exec(id);
  if (!match) return id;
  const [, prefix, tail] = match;
  const fake = codeFor('id', id).repeat(Math.ceil(tail.length / 8)).slice(0, tail.length);
  return `${prefix}_${fake}`;
}

function redactAccount(account, index) {
  return {
    ...shiftMoments(account),
    id: redactId(account.id),
    connection: redactId(account.connection),
    name: `Test Account ${index + 1}`,
    account_number: `xxxx${String(1000 + index).slice(-4)}`,
    institution: account.institution
      ? { ...account.institution, id: `inst_test_${index + 1}`, name: `Test Bank ${index + 1}`, logo: null }
      : account.institution,
  };
}

function redactConnection(connection, index) {
  return {
    ...shiftMoments(connection),
    id: redactId(connection.id),
    institution: connection.institution
      ? { ...connection.institution, id: `inst_test_${index + 1}`, name: `Test Bank ${index + 1}`, logo: null }
      : connection.institution,
    consent: connection.consent
      ? { ...shiftMoments(connection.consent), id: redactId(connection.consent.id) }
      : connection.consent,
  };
}

// Amounts become dummy values, but the sign is preserved because the sign is
// the convention we are recording, and zero stays zero because a zero amount
// transaction is an edge case the tests need.
function redactAmountCents(cents, seed) {
  if (cents === 0) return 0;
  const sign = Math.sign(cents);
  const magnitude = 500 + (parseInt(codeFor('amt', seed).slice(0, 4), 16) % 20_000);
  return sign * magnitude;
}

function redactTransaction(txn, index) {
  const description = GENERIC_DESCRIPTIONS[index % GENERIC_DESCRIPTIONS.length];
  return {
    ...shiftMoments(txn),
    id: redactId(txn.id),
    account: redactId(txn.account),
    description,
    reference: txn.reference === null ? null : codeFor('ref', txn.reference).slice(0, 6),
    extended_description: txn.extended_description === null ? null : 'generic extended description',
    merchant_name: txn.merchant_name === null ? null : `Merchant ${(index % 5) + 1}`,
    amount: { ...txn.amount, amount: redactAmountCents(txn.amount.amount, txn.id) },
    category: txn.category === null ? null : redactId(txn.category),
    merchant_category_code: txn.merchant_category_code === null ? null : '0000',
  };
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = createClient();
  const out = [];
  const say = (line = '') => {
    out.push(line);
    console.log(line);
  };

  say('='.repeat(78));
  say(`Redbark discovery  base=${client.baseUrl}  version=${client.apiVersion}`);
  say('='.repeat(78));

  const me = await client.getAccountInfo();
  say('');
  say(`Plan: ${me.plan} (${me.status}).  Timezone: ${me.timezone}.  API access: ${me.entitlements?.api_access}`);
  say(`Key scopes: ${me.key?.scopes?.join(', ')}`);
  say(`API version echoed: ${me.api_version}`);

  const connections = await client.listConnections();
  say('');
  say('-'.repeat(78));
  say(...describeShape(connections, 'CONNECTIONS'));
  for (const c of connections) {
    say(`   -> ${c.institution?.name}  status=${c.status}  accounts=${c.account_count}  consent expires ${c.consent?.expires_at}`);
  }

  const accounts = await client.listAccounts();
  say('');
  say('-'.repeat(78));
  say(...describeShape(accounts, 'ACCOUNTS'));
  for (const a of accounts) {
    say(`   -> ${a.name}  ${a.account_number}  type=${a.type}  status=${a.status}  currency=${a.currency}`);
  }

  const balances = await client.listBalances(accounts.map((a) => a.id));
  say('');
  say('-'.repeat(78));
  say(...describeShape(balances, 'BALANCES'));
  for (const b of balances) {
    say(`   -> ${b.account}  current=${b.current?.amount}  available=${b.available?.amount}  freshness=${b.freshness}`);
  }

  const to = isoDate(new Date());
  const from = isoDate(new Date(Date.now() - args.days * 86_400_000));
  const perAccount = new Map();
  say('');
  say('-'.repeat(78));
  say(`TRANSACTIONS  window ${from} .. ${to}  include_pending=true`);
  for (const account of accounts) {
    const { rows, truncated } = await client.listTransactions({ accountId: account.id, from, to });
    perAccount.set(account.id, rows);
    say(`   ${account.name} (${account.account_number}): ${rows.length} rows${truncated ? '  TRUNCATED' : ''}`);
  }

  const allTxns = [...perAccount.values()].flat();
  say('');
  say(...describeShape(allTxns, 'TRANSACTION FIELDS (all accounts)'));

  // The answers that decide how the parsers are written.
  say('');
  say('='.repeat(78));
  say('FINDINGS');
  say('='.repeat(78));

  say(`status values:            ${tally(allTxns, 'status').map(([v, n]) => `${v}=${n}`).join('  ')}`);
  say(`direction values:         ${tally(allTxns, 'direction').map(([v, n]) => `${v}=${n}`).join('  ')}`);
  say(`id prefixes:              ${tally(allTxns, (t) => t.id.replace(/_[0-9a-f]{8,}$/, '')).map(([v, n]) => `${v}=${n}`).join('  ')}`);
  say(`id tail lengths:          ${tally(allTxns, (t) => String(t.id.split('_').pop().length)).map(([v, n]) => `${v} chars=${n}`).join('  ')}`);

  const negatives = allTxns.filter((t) => t.amount.amount < 0).length;
  const positives = allTxns.filter((t) => t.amount.amount > 0).length;
  const zeros = allTxns.filter((t) => t.amount.amount === 0);
  say(`sign convention:          ${negatives} negative, ${positives} positive, ${zeros.length} zero`);
  say(`                          debit rows negative: ${allTxns.filter((t) => t.direction === 'debit' && t.amount.amount < 0).length}/${allTxns.filter((t) => t.direction === 'debit').length}`);
  if (zeros.length) {
    say(`zero amount rows:         ${zeros.length}  (excluded from transfer pairing, they would cross pair)`);
  }

  const pending = allTxns.filter((t) => t.status === 'pending');
  say(`pending rows:             ${pending.length}`);
  for (const p of pending.slice(0, 8)) {
    say(`   date=${p.date} post_date=${p.post_date} amount=${p.amount.amount} id=...${p.id.slice(-12)}`);
  }

  // Does a pending row already have a posted twin? If it does, the id changed
  // when it posted and the fuzzy matcher is doing real work.
  let twins = 0;
  for (const p of pending) {
    const rows = perAccount.get(p.account) ?? [];
    const match = rows.find(
      (q) =>
        q.status === 'posted' &&
        q.amount.amount === p.amount.amount &&
        Math.abs((Date.parse(q.date) - Date.parse(p.date)) / 86_400_000) <= 5,
    );
    if (match) twins++;
  }
  say(`pending rows with a posted twin already present: ${twins}`);
  say(`   (a twin means the id changes on posting, so the row must be matched and replaced, not inserted)`);

  const withReference = allTxns.filter((t) => t.reference !== null).length;
  const withExtended = allTxns.filter((t) => t.extended_description !== null).length;
  const withMerchant = allTxns.filter((t) => t.merchant_name !== null).length;
  say(`reference present:        ${withReference}/${allTxns.length}`);
  say(`extended_description:     ${withExtended}/${allTxns.length}`);
  say(`merchant_name present:    ${withMerchant}/${allTxns.length}`);
  const untrimmed = allTxns.filter((t) => t.merchant_name && t.merchant_name !== t.merchant_name.trim()).length;
  say(`merchant_name needing trim: ${untrimmed}`);

  say(`provider_category top:    ${tally(allTxns, 'provider_category').slice(0, 6).map(([v, n]) => `${v}=${n}`).join('  ')}`);

  const earliest = allTxns.map((t) => t.date).sort()[0];
  say(`earliest date in window:  ${earliest}`);

  if (args.fixtures) {
    await mkdir(FIXTURES_DIR, { recursive: true });
    setDateShiftFromNewest(allTxns);
    const redactedAccounts = accounts.map(redactAccount);
    const accountIdMap = new Map(accounts.map((a, i) => [a.id, redactedAccounts[i].id]));

    let txnIndex = 0;
    const redactedTxns = [];
    for (const [accountId, rows] of perAccount) {
      for (const t of rows) {
        const r = redactTransaction(t, txnIndex++);
        r.account = accountIdMap.get(accountId) ?? r.account;
        redactedTxns.push(r);
      }
    }

    const files = {
      'connections.json': connections.map(redactConnection),
      'accounts.json': redactedAccounts,
      'balances.json': balances.map((b) => ({
        ...shiftMoments(b),
        account: accountIdMap.get(b.account) ?? redactId(b.account),
        current: b.current ? { ...b.current, amount: redactAmountCents(b.current.amount, b.account) } : b.current,
        available: b.available ? { ...b.available, amount: redactAmountCents(b.available.amount, `a${b.account}`) } : b.available,
      })),
      'transactions.json': redactedTxns,
    };

    for (const [name, data] of Object.entries(files)) {
      await writeFile(path.join(FIXTURES_DIR, name), `${JSON.stringify(data, null, 2)}\n`);
      say(`wrote test/fixtures/${name} (${Array.isArray(data) ? data.length : 0} rows, redacted)`);
    }
  }

  say('');
  say('Done.');
}

main().catch((err) => {
  console.error(`\nDiscovery failed: ${err.message}`);
  process.exitCode = 1;
});
