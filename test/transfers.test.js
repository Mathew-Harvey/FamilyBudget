// Transfer detection: the clean case, the mortgage across two banks, the
// ambiguous case that must be left alone, and the rejected pair.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getTestPool, resetDatabase, closeTestPool, makeAccount } from './helpers.js';
import { detectTransfers, listCandidates, rejectPair, linkPair, buildCandidates, resolvePairs } from '../src/transfers.js';
import { centsToNumeric } from '../src/money.js';

beforeEach(resetDatabase);
after(closeTestPool);

async function addTxn(pool, accountId, { date, cents, description, category = null, reference = null }) {
  const { rows } = await pool.query(
    `insert into transactions (account_id, redbark_txn_id, status, txn_date, description,
                               amount, provider_category, reference, raw)
     values ($1, $2, 'posted', $3, $4, $5, $6, $7, '{}'::jsonb)
     returning id`,
    [
      accountId,
      `txn_${Math.random().toString(36).slice(2, 14)}`,
      date,
      description,
      centsToNumeric(cents),
      category,
      reference,
    ],
  );
  return rows[0].id;
}

async function pairOf(pool, id) {
  const { rows } = await pool.query(
    'select is_transfer, transfer_pair_id, transfer_confidence from transactions where id = $1',
    [id],
  );
  return rows[0];
}

test('a clean pair on two accounts is detected and linked both ways', async () => {
  const pool = await getTestPool();
  const everyday = await makeAccount(pool, { name: 'Orange Everyday', masked_number: 'xxxx9529' });
  const savings = await makeAccount(pool, { name: 'Savings Maximiser', masked_number: 'xxxx4047' });

  const out = await addTxn(pool, everyday.id, {
    date: '2026-03-01',
    cents: -50000,
    description: 'INTERNAL TRANSFER TO LINKED ING ACCOUNT',
  });
  const income = await addTxn(pool, savings.id, {
    date: '2026-03-01',
    cents: 50000,
    description: 'INTERNAL TRANSFER 923100 34239529',
  });

  const detected = await detectTransfers({ pool });
  assert.equal(detected, 1);

  const a = await pairOf(pool, out);
  const b = await pairOf(pool, income);
  assert.equal(a.is_transfer, true);
  assert.equal(b.is_transfer, true);
  assert.equal(a.transfer_pair_id, income, 'each row points at the other');
  assert.equal(b.transfer_pair_id, out);
  assert.equal(a.transfer_confidence, 'auto');
});

test('a mortgage repayment pairs across ING and CBA despite the loan sign convention', async () => {
  const pool = await getTestPool();
  const ing = await makeAccount(pool, {
    bank: 'ING BANK (Australia) Ltd',
    name: 'Orange Everyday',
    masked_number: 'xxxx9529',
    type: 'transaction',
  });
  const loan = await makeAccount(pool, {
    bank: 'CommBank',
    name: 'Standard Variable Rate Home Loan',
    masked_number: 'xxxx0194',
    type: 'loan',
    is_liquid: false,
  });

  // Money leaves ING as negative. On the loan the repayment arrives positive,
  // because it reduces the debt. Equal and opposite still holds.
  const fromIng = await addTxn(pool, ing.id, {
    date: '2026-03-10',
    cents: -180000,
    description: 'DIRECT DEBIT 000650 COMMONWEALTH BNK LN REPAY',
    category: 'LOAN_PAYMENTS',
  });
  const toLoan = await addTxn(pool, loan.id, {
    date: '2026-03-10',
    cents: 180000,
    description: 'Repayment/Payment',
    category: 'TRANSFER_IN',
  });

  assert.equal(await detectTransfers({ pool }), 1);
  const a = await pairOf(pool, fromIng);
  assert.equal(a.transfer_pair_id, toLoan);
  assert.equal(a.is_transfer, true);
});

test('interest charged on the loan is not mistaken for a transfer', async () => {
  const pool = await getTestPool();
  const ing = await makeAccount(pool, { masked_number: 'xxxx9529' });
  const loan = await makeAccount(pool, { masked_number: 'xxxx0194', type: 'loan' });

  await addTxn(pool, loan.id, { date: '2026-03-03', cents: -319731, description: 'Interest charged' });
  await addTxn(pool, ing.id, { date: '2026-03-03', cents: -5000, description: 'CARD PURCHASE' });

  assert.equal(await detectTransfers({ pool }), 0, 'nothing is equal and opposite here');
});

test('several equally good candidates are left for a person to decide', async () => {
  const pool = await getTestPool();
  const everyday = await makeAccount(pool, { name: 'Everyday', masked_number: 'xxxx9529' });
  const savings = await makeAccount(pool, { name: 'Savings', masked_number: 'xxxx4047' });

  // One credit, two debits the same distance away, with nothing in the text to
  // tell them apart. Guessing would be wrong half the time.
  const credit = await addTxn(pool, everyday.id, {
    date: '2026-03-02',
    cents: 50000,
    description: 'INTERNAL TRANSFER',
  });
  const debitOne = await addTxn(pool, savings.id, {
    date: '2026-03-01',
    cents: -50000,
    description: 'INTERNAL TRANSFER',
  });
  const debitTwo = await addTxn(pool, savings.id, {
    date: '2026-03-03',
    cents: -50000,
    description: 'INTERNAL TRANSFER',
  });

  assert.equal(await detectTransfers({ pool }), 0, 'an ambiguous set must not be auto paired');
  for (const id of [credit, debitOne, debitTwo]) {
    assert.equal((await pairOf(pool, id)).is_transfer, false);
  }

  // They are still offered to the review screen.
  const candidates = await listCandidates({ client: pool });
  assert.ok(candidates.length >= 2, 'the ambiguous options should be offered for a manual decision');
});

test('the counterpart account number in the description breaks a tie', async () => {
  const pool = await getTestPool();
  const everyday = await makeAccount(pool, { name: 'Everyday', masked_number: 'xxxx9529' });
  const savings = await makeAccount(pool, { name: 'Savings', masked_number: 'xxxx4047' });
  const personal = await makeAccount(pool, { name: 'Personal', masked_number: 'xxxx4486' });

  // Same amount, same day, two possible counterparts. Only the account number
  // in the text says which is which. This is the real shape of the ING data.
  const credit = await addTxn(pool, everyday.id, {
    date: '2026-03-02',
    cents: 30000,
    description: 'INTERNAL TRANSFER 923100 30124486',
  });
  const fromSavings = await addTxn(pool, savings.id, {
    date: '2026-03-02',
    cents: -30000,
    description: 'INTERNAL TRANSFER TO LINKED ING ACCOUNT',
  });
  const fromPersonal = await addTxn(pool, personal.id, {
    date: '2026-03-02',
    cents: -30000,
    description: 'INTERNAL TRANSFER TO LINKED ING ACCOUNT',
  });

  assert.equal(await detectTransfers({ pool }), 1);
  assert.equal(
    (await pairOf(pool, credit)).transfer_pair_id,
    fromPersonal,
    'the 4486 in the description names the personal account',
  );
  assert.equal((await pairOf(pool, fromSavings)).is_transfer, false, 'the savings row stays free');
});

test('a rejected pair is never paired again automatically', async () => {
  const pool = await getTestPool();
  const everyday = await makeAccount(pool, { masked_number: 'xxxx9529' });
  const savings = await makeAccount(pool, { masked_number: 'xxxx4047' });

  const out = await addTxn(pool, everyday.id, { date: '2026-03-01', cents: -50000, description: 'TRANSFER' });
  const income = await addTxn(pool, savings.id, { date: '2026-03-01', cents: 50000, description: 'TRANSFER' });

  assert.equal(await detectTransfers({ pool }), 1);
  await rejectPair(pool, out, income);

  assert.equal((await pairOf(pool, out)).is_transfer, false);
  assert.equal(await detectTransfers({ pool }), 0, 'detection must not undo the rejection');
  assert.equal((await pairOf(pool, out)).transfer_pair_id, null);
});

test('a rejected row can still pair with the right counterpart', async () => {
  const pool = await getTestPool();
  const everyday = await makeAccount(pool, { masked_number: 'xxxx9529' });
  const savings = await makeAccount(pool, { masked_number: 'xxxx4047' });

  const credit = await addTxn(pool, everyday.id, { date: '2026-03-05', cents: 50000, description: 'TRANSFER' });
  const wrong = await addTxn(pool, savings.id, { date: '2026-03-05', cents: -50000, description: 'TRANSFER' });

  // Reject this pairing before anything is linked.
  await rejectPair(pool, credit, wrong);
  assert.equal(await detectTransfers({ pool }), 0);

  // The real counterpart turns up later. Rejection was about the pair, not the
  // row, so this must still pair.
  const right = await addTxn(pool, savings.id, {
    date: '2026-03-05',
    cents: -50000,
    description: 'INTERNAL TRANSFER 923100 34239529',
  });
  assert.equal(await detectTransfers({ pool }), 1);
  assert.equal((await pairOf(pool, credit)).transfer_pair_id, right);
});

test('a zero amount row is never paired', async () => {
  const pool = await getTestPool();
  const a = await makeAccount(pool, { masked_number: 'xxxx9529' });
  const b = await makeAccount(pool, { masked_number: 'xxxx4047' });

  // Real data has these: $0 card authorisations and bank notices. They satisfy
  // "equal and opposite" trivially and would pair with anything.
  const one = await addTxn(pool, a.id, { date: '2026-03-01', cents: 0, description: 'Visa Provisioning Service' });
  const two = await addTxn(pool, b.id, { date: '2026-03-01', cents: 0, description: 'ANTHROPIC' });

  assert.equal(await detectTransfers({ pool }), 0);
  assert.equal((await pairOf(pool, one)).is_transfer, false);
  assert.equal((await pairOf(pool, two)).is_transfer, false);
});

test('two rows on the same account never pair', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool);
  await addTxn(pool, account.id, { date: '2026-03-01', cents: -20000, description: 'REFUNDED PURCHASE' });
  await addTxn(pool, account.id, { date: '2026-03-02', cents: 20000, description: 'REFUND' });
  assert.equal(await detectTransfers({ pool }), 0);
});

test('rows more than 3 days apart do not pair', async () => {
  const pool = await getTestPool();
  const a = await makeAccount(pool, { masked_number: 'xxxx9529' });
  const b = await makeAccount(pool, { masked_number: 'xxxx4047' });
  await addTxn(pool, a.id, { date: '2026-03-01', cents: -50000, description: 'TRANSFER' });
  await addTxn(pool, b.id, { date: '2026-03-05', cents: 50000, description: 'TRANSFER' });
  assert.equal(await detectTransfers({ pool }), 0);
});

test('a repayment to a loan we do not hold is left unpaired', async () => {
  const pool = await getTestPool();
  const everyday = await makeAccount(pool, { masked_number: 'xxxx9529' });
  // The ING personal loan is not connected, so there is no counterpart row.
  const payment = await addTxn(pool, everyday.id, {
    date: '2026-03-01',
    cents: -45000,
    description: 'DIRECT DEBIT ING PERSONAL LOAN REPAYMENT',
    category: 'LOAN_PAYMENTS',
  });
  assert.equal(await detectTransfers({ pool }), 0);
  assert.equal((await pairOf(pool, payment)).is_transfer, false, 'later stages will treat this as a commitment');
});

test('detection is idempotent', async () => {
  const pool = await getTestPool();
  const a = await makeAccount(pool, { masked_number: 'xxxx9529' });
  const b = await makeAccount(pool, { masked_number: 'xxxx4047' });
  await addTxn(pool, a.id, { date: '2026-03-01', cents: -50000, description: 'TRANSFER' });
  await addTxn(pool, b.id, { date: '2026-03-01', cents: 50000, description: 'TRANSFER' });

  assert.equal(await detectTransfers({ pool }), 1);
  assert.equal(await detectTransfers({ pool }), 0, 'a second run must find nothing new');
  const { rows } = await pool.query('select count(*)::int as n from transactions where is_transfer');
  assert.equal(rows[0].n, 2);
});

test('a manually linked pair is marked confirmed and survives detection', async () => {
  const pool = await getTestPool();
  const a = await makeAccount(pool, { masked_number: 'xxxx9529' });
  const b = await makeAccount(pool, { masked_number: 'xxxx4047' });
  // Deliberately 2 days apart with nothing in common, so detection would not
  // find this on its own.
  const one = await addTxn(pool, a.id, { date: '2026-03-01', cents: -12345, description: 'SOMETHING ODD' });
  const two = await addTxn(pool, b.id, { date: '2026-03-03', cents: 12345, description: 'UNRELATED WORDING' });

  await linkPair(pool, one, two, 'confirmed');
  assert.equal((await pairOf(pool, one)).transfer_confidence, 'confirmed');

  await detectTransfers({ pool });
  const after = await pairOf(pool, one);
  assert.equal(after.transfer_pair_id, two, 'a confirmed pair is left alone');
  assert.equal(after.transfer_confidence, 'confirmed');
});

test('resolution prefers the closest date before looking at the text', () => {
  const accounts = new Map([
    ['acct-a', { id: 'acct-a', name: 'A', masked_number: 'xxxx1111' }],
    ['acct-b', { id: 'acct-b', name: 'B', masked_number: 'xxxx2222' }],
  ]);
  const rows = [
    { id: '1', account_id: 'acct-a', txn_date: '2026-03-02', amount_cents: 50000, description: 'TRANSFER' },
    { id: '2', account_id: 'acct-b', txn_date: '2026-03-02', amount_cents: -50000, description: 'PLAIN' },
    { id: '3', account_id: 'acct-b', txn_date: '2026-03-04', amount_cents: -50000, description: 'TRANSFER TRANSFER' },
  ];
  const { pairs } = resolvePairs(buildCandidates(rows, accounts));
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].b.id, '2', 'the same day match wins even though the other has stronger wording');
});
