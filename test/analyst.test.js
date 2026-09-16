// The Claude analysis path. No test calls the API: `messages` is injected, so
// the whole flow runs without spending anything.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getTestPool, resetDatabase, closeTestPool, makeAccount } from './helpers.js';
import {
  buildSnapshot,
  buildRequest,
  scrubLabel,
  analyse,
  planExpense,
  acceptProposal,
  runPeriodicAnalysis,
  updateAnalystSettings,
  anthropicConfig,
} from '../src/analyst.js';
import { setPayCycle, ensurePayPeriods } from '../src/buckets.js';
import { centsToNumeric, numericToCents } from '../src/money.js';
import { daysAgo, addDays, today } from '../src/dates.js';

beforeEach(async () => {
  const pool = await resetDatabase();
  await pool.query(
    'truncate analyses, alert_log, commitments, expected_income, assets, bucket_allocations, bucket_categories, buckets, pay_periods, pay_cycle, rules, provider_category_map, categories cascade',
  );
  await pool.query('update analyst_settings set enabled = false, last_run_at = null, cadence_days = 7');
  return pool;
});
after(closeTestPool);

// Stands in for client.messages, recording what it was asked.
function fakeMessages(result) {
  const calls = [];
  return {
    calls,
    async create(params) {
      calls.push(params);
      return {
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        stop_details: null,
        content: [{ type: 'text', text: JSON.stringify(result) }],
        usage: { input_tokens: 1234, output_tokens: 567 },
      };
    },
  };
}

const ANALYSIS = {
  headline: 'Spending is running ahead of income.',
  summary: 'Money out is about double money in.',
  observations: [{ title: 'Runway is short', detail: 'About 60 days.', severity: 'high' }],
  recommendations: [
    { action: 'Cut the subscriptions', why: 'They add up', estimated_monthly_impact: '180.00', effort: 'quick' },
  ],
  predicted_expenses: [
    {
      label: 'SmartRider top up',
      typical_amount: '50.00',
      cadence_days: 7,
      next_due: '2026-09-23',
      confidence: 'medium',
      reason: 'The household said they are setting one up next week.',
    },
  ],
  questions_for_you: ['Is the credit card balance still 6500?'],
};

async function addTxn(pool, accountId, { date, cents, description = 'TEST' }) {
  await pool.query(
    `insert into transactions (account_id, redbark_txn_id, status, txn_date, description, amount, raw)
     values ($1,$2,'posted',$3,$4,$5,'{}'::jsonb)`,
    [accountId, `txn_${Math.random().toString(36).slice(2, 14)}`, date, description, centsToNumeric(cents)],
  );
}

// --- what gets sent ------------------------------------------------------

test('account numbers are scrubbed out of descriptions', () => {
  assert.equal(
    scrubLabel('DIRECT DEBIT 000650 COMMONWEALTH BNK LN REPAY 572740194'),
    'DIRECT DEBIT #### COMMONWEALTH BNK LN REPAY ####',
  );
  assert.equal(scrubLabel('INTERNAL TRANSFER 923100 34239529'), 'INTERNAL TRANSFER #### ####');
  // Short numbers are store numbers and quantities, not identifiers, so they stay.
  assert.equal(scrubLabel('ALDI 123 MANDURAH'), 'ALDI 123 MANDURAH');
  assert.equal(scrubLabel(null), null);
});

test('the snapshot carries no account identifier, in any field or description', async () => {
  const pool = await getTestPool();
  const account = await makeAccount(pool, {
    masked_number: 'xxxx9529',
    name: 'Orange Everyday',
    is_liquid: true,
  });
  await addTxn(pool, account.id, {
    date: '2026-09-01',
    cents: -180000,
    description: 'DIRECT DEBIT 000650 COMMONWEALTH BNK LN REPAY 572740194',
  });
  await setPayCycle('monthly', '2026-09-28', '9800', pool);
  await ensurePayPeriods({ pool });

  const snapshot = await buildSnapshot(pool);
  const json = JSON.stringify(snapshot);

  for (const identifier of ['9529', '572740194', '000650', 'xxxx']) {
    assert.ok(!json.includes(identifier), `${identifier} must not be sent to the API`);
  }
  // The words that make a description meaningful do survive.
  assert.ok(json.includes('COMMONWEALTH'), 'the readable part of a description is kept');
});

test('the request is shaped the way the API expects', () => {
  const request = buildRequest({ snapshot: { as_of: '2026-09-16' }, question: 'How are we going?' });

  assert.equal(request.model, 'claude-opus-5');
  assert.deepEqual(request.thinking, { type: 'adaptive' });
  assert.equal(request.output_config.format.type, 'json_schema');
  assert.equal(request.output_config.effort, 'high');
  // The stable system prompt is the cache breakpoint, and the volatile snapshot
  // sits after it in the user message, or nothing would ever cache.
  assert.deepEqual(request.system[0].cache_control, { type: 'ephemeral' });
  assert.ok(!request.system[0].text.includes('2026-09-16'), 'nothing dated belongs in the cached prefix');
  assert.ok(request.messages[0].content.includes('2026-09-16'));
  assert.ok(request.messages[0].content.includes('How are we going?'));
});

test('the schema demands every field the UI renders', () => {
  const schema = buildRequest({ snapshot: {} }).output_config.format.schema;
  assert.deepEqual(schema.required, [
    'headline', 'summary', 'observations', 'recommendations', 'predicted_expenses', 'questions_for_you',
  ]);
  assert.equal(schema.additionalProperties, false);
});

// --- running it ----------------------------------------------------------

test('an analysis is stored with the snapshot it was given', async () => {
  const pool = await getTestPool();
  await makeAccount(pool, { is_liquid: true });
  const messages = fakeMessages(ANALYSIS);

  const stored = await analyse({ client: pool, messages, question: 'How are we going?' });

  assert.equal(stored.kind, 'question');
  assert.equal(stored.result.headline, ANALYSIS.headline);
  assert.equal(stored.input_tokens, 1234);
  assert.equal(stored.output_tokens, 567);
  assert.equal(messages.calls.length, 1);

  // The snapshot is kept so any claim can be checked against what it saw.
  const { rows } = await pool.query('select snapshot, question from analyses');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].question, 'How are we going?');
  assert.ok(rows[0].snapshot.as_of, 'the stored snapshot should carry its date');
});

test('a refusal is reported rather than stored as an answer', async () => {
  const pool = await getTestPool();
  await makeAccount(pool, { is_liquid: true });
  const messages = {
    async create() {
      return {
        model: 'claude-opus-5',
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'other', explanation: 'no thanks' },
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      };
    },
  };
  await assert.rejects(() => analyse({ client: pool, messages }), /declined/i);
  const { rows } = await pool.query('select count(*)::int as n from analyses');
  assert.equal(rows[0].n, 0);
});

test('a non JSON reply is an error, not a blank insight', async () => {
  const pool = await getTestPool();
  await makeAccount(pool, { is_liquid: true });
  const messages = {
    async create() {
      return {
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'sorry, here is some prose' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
  await assert.rejects(() => analyse({ client: pool, messages }), /not the expected JSON/);
});

// --- predicting an expense ----------------------------------------------

test('a plain English plan becomes a commitment the forecast understands', async () => {
  const pool = await getTestPool();
  await makeAccount(pool, { is_liquid: true });

  const messages = fakeMessages({
    understood: 'A SmartRider card from next week, about fifty dollars a week.',
    proposals: [
      {
        label: 'SmartRider top up',
        typical_amount: '50.00',
        cadence_days: 7,
        next_due: '2026-09-23',
        confidence: 'medium',
        reason: 'They said so, and fifty a week is typical for daily Perth commuting.',
      },
    ],
    effect: 'About 217 a month, which shortens the runway a little.',
    questions_for_you: [],
  });

  const analysis = await planExpense("Next week I'm getting a SmartRider card, probably $50 a week", {
    client: pool,
    messages,
  });
  assert.equal(analysis.kind, 'expense_plan');

  const commitment = await acceptProposal(analysis.result.proposals[0], pool);
  assert.equal(commitment.label, 'SmartRider top up');
  // Outgoings are negative everywhere in this app.
  assert.equal(numericToCents(commitment.typical_amount), -5000);
  assert.equal(commitment.cadence_days, 7);
  assert.equal(commitment.source, 'manual');
  assert.equal(commitment.active, true);
});

test('accepting the same proposal twice updates it rather than duplicating', async () => {
  const pool = await getTestPool();
  const proposal = { label: 'SmartRider top up', typical_amount: '50.00', cadence_days: 7, next_due: null };
  await acceptProposal(proposal, pool);
  await acceptProposal({ ...proposal, typical_amount: '60.00' }, pool);

  const { rows } = await pool.query('select typical_amount from commitments');
  assert.equal(rows.length, 1);
  assert.equal(numericToCents(rows[0].typical_amount), -6000);
});

test('a proposal without a usable amount or cadence is refused', async () => {
  const pool = await getTestPool();
  await assert.rejects(() => acceptProposal({ label: 'x', typical_amount: 'abc', cadence_days: 7 }, pool), /amount/);
  await assert.rejects(() => acceptProposal({ label: 'x', typical_amount: '10', cadence_days: 0 }, pool), /cadence/);
});

// --- when it runs --------------------------------------------------------

test('periodic analysis stays off until it is switched on', async () => {
  const pool = await getTestPool();
  await makeAccount(pool, { is_liquid: true });
  const messages = fakeMessages(ANALYSIS);

  const off = await runPeriodicAnalysis({ client: pool, messages });
  assert.equal(off.ran, false);
  assert.match(off.reason, /switched off/);

  await updateAnalystSettings({ enabled: true }, pool);
  const on = await runPeriodicAnalysis({ client: pool, messages });
  assert.equal(on.ran, true);
});

test('the cadence stops a twice daily sync becoming twice daily analysis', async () => {
  const pool = await getTestPool();
  await makeAccount(pool, { is_liquid: true });
  const messages = fakeMessages(ANALYSIS);
  await updateAnalystSettings({ enabled: true, cadence_days: 7 }, pool);

  assert.equal((await runPeriodicAnalysis({ client: pool, messages })).ran, true);
  const second = await runPeriodicAnalysis({ client: pool, messages });
  assert.equal(second.ran, false, 'a second run the same day must not call the API again');
  assert.match(second.reason, /not due/i);

  // Once the cadence has passed it runs again.
  await pool.query("update analyst_settings set last_run_at = now() - interval '8 days'");
  assert.equal((await runPeriodicAnalysis({ client: pool, messages })).ran, true);
  assert.equal(messages.calls.length, 2);
});

test('without a key, analysis declines rather than failing the sync', async () => {
  const pool = await getTestPool();
  await updateAnalystSettings({ enabled: true }, pool);
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.equal(anthropicConfig().configured, false);
    const result = await runPeriodicAnalysis({ client: pool });
    assert.equal(result.ran, false);
    assert.match(result.reason, /ANTHROPIC_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

// --- manual accounts -----------------------------------------------------

test('a manual debt account is held apart from spendable cash', async () => {
  const pool = await getTestPool();
  const everyday = await makeAccount(pool, { is_liquid: true });
  await pool.query(
    `insert into balances (account_id, balance_date, balance) values ($1, current_date, $2)`,
    [everyday.id, '1000.00'],
  );

  const { rows } = await pool.query(
    `insert into accounts (source, bank, name, type, role, is_liquid)
     values ('manual', 'Bendigo', 'Credit card', 'credit_card', 'credit_card', false)
     returning id`,
  );
  await pool.query(
    `insert into balances (account_id, balance_date, balance) values ($1, current_date, $2)`,
    [rows[0].id, '-6500.00'],
  );

  const snapshot = await buildSnapshot(pool);
  assert.equal(numericToCents(snapshot.position.spendable_cash), 100000, 'a debt is not spendable cash');
  const debt = snapshot.position.debts.find((d) => d.name === 'Credit card');
  assert.ok(debt, 'the debt should still appear in the picture');
  assert.equal(numericToCents(debt.balance), -650000);
  assert.equal(debt.source, 'manual');
});

test('a manual account survives a sync, which only ever touches Redbark ones', async () => {
  const pool = await getTestPool();
  const { upsertAccounts } = await import('../src/sync.js');
  await pool.query(
    `insert into accounts (source, bank, name, type, is_liquid)
     values ('manual', 'Bendigo', 'Credit card', 'credit_card', false)`,
  );
  await upsertAccounts(pool, [
    {
      id: 'acct_one', connection: 'conn_one', name: 'Everyday', type: 'transaction',
      account_number: 'xxxx9529', currency: 'aud', status: 'available', institution: { name: 'ING' },
    },
  ]);
  const { rows } = await pool.query("select count(*)::int as n from accounts where source = 'manual'");
  assert.equal(rows[0].n, 1);
});
