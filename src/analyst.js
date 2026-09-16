// Periodic analysis and predictive budgeting, through the Claude API.
//
// This is the one place that talks to Anthropic. It gathers a snapshot of where
// the household stands, asks Claude to read it, and stores a structured answer.
//
// Two things it is careful about:
//   - Account numbers are never sent. Names, balances and descriptions are,
//     because that is what makes the analysis useful, but nothing that
//     identifies an account at a bank.
//   - It is off until someone turns it on, and the exact snapshot that was sent
//     is stored with every answer, so any claim can be checked against the
//     figures it was given.
import Anthropic from '@anthropic-ai/sdk';
import { query, withTransaction } from './db.js';
import { forecast } from './forecast.js';
import { getPayCycle, currentPeriod, periodState } from './buckets.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';

// The shape every answer comes back in. Constraining the response means the UI
// can render it without guessing, and a missing field is a validation error
// rather than something that silently renders blank.
const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    headline: {
      type: 'string',
      description: 'One sentence on where the household stands right now.',
    },
    summary: {
      type: 'string',
      description: 'A short plain English paragraph. No jargon, no hedging.',
    },
    observations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['title', 'detail', 'severity'],
        additionalProperties: false,
      },
    },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'What to do, concretely.' },
          why: { type: 'string' },
          estimated_monthly_impact: {
            type: ['string', 'null'],
            description: 'Dollars a month this would free up or cost, as a plain number string, or null if it cannot be estimated.',
          },
          effort: { type: 'string', enum: ['quick', 'moderate', 'significant'] },
        },
        required: ['action', 'why', 'estimated_monthly_impact', 'effort'],
        additionalProperties: false,
      },
    },
    predicted_expenses: {
      type: 'array',
      description:
        'Costs that look likely to land soon and are not yet tracked as commitments. Only include ones with a real basis in the data or in what the user said.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          typical_amount: { type: 'string', description: 'A positive dollar amount, as a plain number string.' },
          cadence_days: { type: 'integer' },
          next_due: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null if unknown.' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          reason: { type: 'string' },
        },
        required: ['label', 'typical_amount', 'cadence_days', 'next_due', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
    questions_for_you: {
      type: 'array',
      description: 'Things that would sharpen the picture, that only the household can answer. Leave empty if there are none.',
      items: { type: 'string' },
    },
  },
  required: ['headline', 'summary', 'observations', 'recommendations', 'predicted_expenses', 'questions_for_you'],
  additionalProperties: false,
};

// Stable across every request, so it caches. Nothing dated or per request goes
// in here, or the cache would never hit.
const SYSTEM_PROMPT = `You are the analyst for a two person household budgeting app in Perth, Western Australia. The household is Mat and Skye. Currency is Australian dollars.

You are given a snapshot of their finances and asked to read it honestly.

How the data works:
- Amounts are negative for money out and positive for money in.
- On a loan account the sign inverts in meaning: a repayment arrives positive because it reduces the debt, and interest charged is negative.
- Transfers between accounts they own are not spending, with one exception: money leaving a spendable account for the mortgage or a loan really does leave their cash, and is counted.
- "Liquid" means spendable. The mortgage redraw is deliberately excluded, because it is money they would have to borrow back.
- "Commitments" are outgoings that recur at a regular interval, found automatically from history.
- "Buckets" are a zero based budget: each pay period, income is divided between them.
- The runway is the projected date spendable cash reaches zero, given expected income, commitments and the everyday spend rate.

How to answer:
- Be direct and specific. Use their real numbers. If something is going wrong, say so plainly in the first sentence rather than burying it.
- Prefer a few things that matter over a long list. Three good observations beat ten weak ones.
- Ground every claim in the snapshot. Do not invent figures, and do not guess at things the snapshot cannot tell you: say what you would need instead.
- When the arithmetic matters, show it briefly, for example "$9,800 in against $20,100 out is $10,300 a month short".
- For predicted expenses, only propose something with a real basis: a pattern in the data, a bill that looks due, or something the household has told you is coming. Say which in the reason. Do not pad the list.
- Australian context is assumed: Synergy and Water Corporation are utilities, a SmartRider is the Perth public transport card, BPAY is a bill payment method, and the financial year ends on 30 June.
- Never use em dashes or en dashes. Use commas, colons or full stops.`;

export function anthropicConfig(env = process.env) {
  return {
    apiKey: env.ANTHROPIC_API_KEY || null,
    model: env.ANTHROPIC_MODEL || MODEL,
    configured: Boolean(env.ANTHROPIC_API_KEY),
  };
}

export async function getAnalystSettings(client = { query }) {
  const { rows } = await client.query('select * from analyst_settings where id');
  return rows[0] ?? null;
}

export async function updateAnalystSettings(patch, client = { query }) {
  const { rows } = await client.query(
    `update analyst_settings set
       enabled      = coalesce($1, enabled),
       cadence_days = coalesce($2, cadence_days),
       effort       = coalesce($3, effort),
       updated_at   = now()
     where id
     returning *`,
    [patch.enabled ?? null, patch.cadence_days ?? null, patch.effort ?? null],
  );
  return rows[0];
}

// Bank descriptions carry account and BSB numbers inside the text itself, for
// example "DIRECT DEBIT 000650 COMMONWEALTH BNK LN REPAY 572740194". The words
// are what make a label useful to read, the digits are not, so any run of four
// or more digits is replaced before anything leaves this machine. Shorter
// numbers stay: they are store numbers and quantities, not identifiers.
export function scrubLabel(text) {
  if (text === null || text === undefined) return text;
  return String(text).replace(/\d{4,}/g, '####').replace(/\s{2,}/g, ' ').trim();
}

// Everything Claude is given. Account numbers never are, neither as a field nor
// buried inside a description.

export async function buildSnapshot(client = { query }) {
  const cycle = await getPayCycle(client);
  const projection = await forecast({ days: 180, client });

  const accounts = (
    await client.query(`
      select a.bank, a.name, a.type, a.role, a.is_liquid, a.source, a.notes,
             b.balance, b.balance_date
        from accounts a
        left join lateral (
          select balance, balance_date from balances
           where account_id = a.id order by balance_date desc limit 1
        ) b on true
       order by a.is_liquid desc, a.bank, a.name
    `)
  ).rows;

  const commitments = (
    await client.query(
      `select label, typical_amount, cadence_days, next_due, occurrences, source
         from commitments where active order by typical_amount limit 60`,
    )
  ).rows;

  const period = await currentPeriod(client);
  const buckets = period ? await periodState(period.id, client) : null;

  // Spending by category over the last three months, so trends are visible.
  const categorySpend = (
    await client.query(`
      select g.name as group_name, c.name as category,
             to_char(date_trunc('month', t.txn_date), 'YYYY-MM') as month,
             sum(-t.amount) as spent
        from budget_flows t
        join categories c on c.id = t.category_id
        left join categories g on g.id = c.parent_id
       where t.counts and t.amount < 0 and c.kind = 'expense'
         and t.txn_date >= date_trunc('month', current_date) - interval '3 months'
       -- Group by the expression, not by position: the positional form counted
       -- the category column, not the month.
       group by g.name, c.name, date_trunc('month', t.txn_date)
       order by date_trunc('month', t.txn_date) desc, sum(-t.amount) desc
    `)
  ).rows;

  const incomeStreams = (
    await client.query(`
      select coalesce(t.display_description, t.description) as label,
             count(*)::int as times,
             to_char(max(t.txn_date), 'YYYY-MM-DD') as last_seen,
             percentile_cont(0.5) within group (order by t.amount) as typical
        from budget_flows t
        join categories c on c.id = t.category_id
       where c.kind = 'income' and t.counts and t.amount > 0
         and t.txn_date >= current_date - 180
       group by 1 having count(*) >= 2
       order by 4 desc limit 15
    `)
  ).rows;

  const largest = (
    await client.query(`
      select to_char(t.txn_date, 'YYYY-MM-DD') as date,
             coalesce(t.display_description, t.description) as label, t.amount
        from budget_flows t
       where t.counts and t.amount < 0 and t.txn_date >= current_date - 60
       order by t.amount limit 15
    `)
  ).rows;

  const uncategorised = (
    await client.query(
      `select count(*)::int as n, coalesce(sum(-amount), 0) as total
         from budget_flows where counts and category_id is null and amount < 0
           and txn_date >= current_date - 90`,
    )
  ).rows[0];

  return {
    as_of: new Date().toISOString().slice(0, 10),
    pay_cycle: cycle,
    position: {
      spendable_cash: projection.opening_balance,
      // Debts are separate from spendable cash: they are what is owed, not a
      // buffer to draw on.
      debts: accounts
        .filter((account) => !account.is_liquid && Number(account.balance) < 0)
        .map((account) => ({ name: scrubLabel(account.name), balance: account.balance, source: account.source })),
      runway_days: projection.runway_days,
      runway_date: projection.runway_date,
      lowest_projected_balance: projection.lowest_balance,
      lowest_on: projection.lowest_date,
    },
    rates: {
      expected_income_per_period: projection.expected_income.amount,
      expected_income_source: projection.expected_income.source,
      everyday_spend_per_day: projection.everyday_rate.per_day,
      committed_last_90_days: projection.everyday_rate.committed,
      total_out_last_90_days: projection.everyday_rate.total,
    },
    accounts: accounts.map((account) => ({
      bank: account.bank,
      name: scrubLabel(account.name),
      type: account.type,
      role: account.role,
      spendable: account.is_liquid,
      tracked_by: account.source,
      balance: account.balance,
      balance_date: account.balance_date,
      notes: account.notes,
    })),
    income_streams: incomeStreams.map((stream) => ({ ...stream, label: scrubLabel(stream.label) })),
    commitments: commitments.map((commitment) => ({ ...commitment, label: scrubLabel(commitment.label) })),
    current_period: buckets
      ? {
          starts_on: buckets.period.starts_on,
          ends_on: buckets.period.ends_on,
          income_so_far: buckets.income,
          allocated: buckets.total_allocated,
          left_to_allocate: buckets.to_allocate,
          spent: buckets.spent,
          spending_no_bucket_covers: buckets.unbucketed_spend,
          buckets: buckets.buckets.map((bucket) => ({
            name: bucket.name,
            target: bucket.target,
            allocated: bucket.allocated,
            spent: bucket.spent,
            remaining: bucket.remaining,
            rolls_over: bucket.carry_over,
          })),
        }
      : null,
    spending_by_category_recent_months: categorySpend,
    largest_recent_outgoings: largest.map((row) => ({ ...row, label: scrubLabel(row.label) })),
    uncategorised_last_90_days: uncategorised,
  };
}

function firstText(message) {
  for (const block of message.content) {
    if (block.type === 'text') return block.text;
  }
  return '';
}

// Builds the exact request. Separated from sending it so the shape can be
// asserted in tests without spending anything.
export function buildRequest({ snapshot, question, effort, schema = ANALYSIS_SCHEMA, instruction, model }) {
  const parts = [instruction ?? 'Read this snapshot and tell me what matters.'];
  if (question) parts.push(`\nWhat they asked:\n${question}`);
  parts.push(`\nSnapshot:\n${JSON.stringify(snapshot, null, 2)}`);

  return {
    model: model ?? anthropicConfig().model,
    max_tokens: 16000,
    // Adaptive thinking, because working out what a runway means for a
    // household is exactly the kind of thing worth thinking about.
    thinking: { type: 'adaptive' },
    output_config: {
      effort: effort ?? 'high',
      format: { type: 'json_schema', schema },
    },
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        // The system prompt never changes, so it caches. The snapshot goes in
        // the user message, after the breakpoint, because it changes every run.
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: parts.join('\n') }],
  };
}

// One call. Returns the parsed result plus what it cost.
// `messages` is injectable so tests can exercise the whole path without
// calling the API.
async function ask({ snapshot, question, kind, effort, schema = ANALYSIS_SCHEMA, instruction, messages }) {
  const config = anthropicConfig();
  if (!messages && !config.configured) {
    throw new Error('ANTHROPIC_API_KEY is not set, so analysis cannot run.');
  }
  const send = messages ?? new Anthropic({ apiKey: config.apiKey }).messages;

  const response = await send.create(
    buildRequest({ snapshot, question, effort, schema, instruction, model: config.model }),
  );

  if (response.stop_reason === 'refusal') {
    throw new Error(`Claude declined to answer: ${response.stop_details?.explanation ?? 'no reason given'}`);
  }

  const text = firstText(response);
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error('Claude returned something that was not the expected JSON.');
  }

  return {
    result,
    model: response.model,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    kind,
    question: question ?? null,
    snapshot,
  };
}

async function store(record, client = { query }) {
  const { rows } = await client.query(
    `insert into analyses (kind, question, snapshot, result, model, input_tokens, output_tokens)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning id, kind, question, result, model, input_tokens, output_tokens, created_at`,
    [
      record.kind,
      record.question,
      JSON.stringify(record.snapshot),
      JSON.stringify(record.result),
      record.model,
      record.input_tokens,
      record.output_tokens,
    ],
  );
  return rows[0];
}

// The main entry point: look at everything and say what matters.
export async function analyse({ question = null, kind = 'on_demand', client = { query }, messages } = {}) {
  const settings = await getAnalystSettings(client);
  const snapshot = await buildSnapshot(client);
  const record = await ask({
    snapshot,
    question,
    kind: question ? 'question' : kind,
    effort: settings?.effort ?? 'high',
    messages,
  });
  const stored = await store(record, client);

  if (kind === 'periodic') {
    await client.query('update analyst_settings set last_run_at = now() where id');
  }
  return stored;
}

// Turning "I am getting a SmartRider card next week, probably fifty dollars a
// week" into something the forecast can use.
const EXPENSE_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    understood: { type: 'string', description: 'What you took the request to mean, in one sentence.' },
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          typical_amount: { type: 'string', description: 'A positive dollar amount, as a plain number string.' },
          cadence_days: { type: 'integer', description: 'Days between occurrences. Weekly is 7, fortnightly 14, monthly 30, quarterly 91.' },
          next_due: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null if the household did not say.' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          reason: { type: 'string', description: 'Where the amount and timing came from, including any assumption you made.' },
        },
        required: ['label', 'typical_amount', 'cadence_days', 'next_due', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
    effect: { type: 'string', description: 'What adding these would do to the runway and to the budget, in one or two sentences.' },
    questions_for_you: { type: 'array', items: { type: 'string' } },
  },
  required: ['understood', 'proposals', 'effect', 'questions_for_you'],
  additionalProperties: false,
};

export async function planExpense(description, { client = { query }, messages } = {}) {
  const settings = await getAnalystSettings(client);
  const snapshot = await buildSnapshot(client);
  const record = await ask({
    snapshot,
    question: description,
    kind: 'expense_plan',
    effort: settings?.effort ?? 'high',
    messages,
    schema: EXPENSE_PLAN_SCHEMA,
    instruction: [
      'The household is telling you about a cost that is coming up, which is not yet in their data.',
      'Turn it into one or more concrete recurring expenses the forecast can use.',
      'Use the snapshot for context: if something similar already exists, say so rather than proposing a duplicate.',
      'If they gave an amount, use it. If they did not, estimate from what the thing typically costs in Perth and say that is what you did.',
    ].join(' '),
  });
  return store(record, client);
}

// Accepts a proposal into the commitments the forecast already understands, so
// there is no second kind of future expense to maintain.
export async function acceptProposal(proposal, client = { query }) {
  const amount = -Math.abs(Number(proposal.typical_amount));
  if (!Number.isFinite(amount) || amount === 0) throw new Error('That proposal has no usable amount.');
  const cadence = Math.round(Number(proposal.cadence_days));
  if (!Number.isFinite(cadence) || cadence < 1) throw new Error('That proposal has no usable cadence.');

  const { rows } = await client.query(
    `insert into commitments (match_key, label, typical_amount, cadence_days, next_due,
                              source, occurrences, regularity)
     values ($1, $2, $3, $4, $5, 'manual', 0, 1)
     on conflict (match_key) do update set
       label          = excluded.label,
       typical_amount = excluded.typical_amount,
       cadence_days   = excluded.cadence_days,
       next_due       = excluded.next_due,
       active         = true,
       updated_at     = now()
     returning *`,
    [
      `manual:${String(proposal.label).trim().toLowerCase()}`,
      String(proposal.label).trim(),
      amount.toFixed(2),
      cadence,
      proposal.next_due || null,
    ],
  );
  return rows[0];
}

// Called at the end of a sync. Only runs when it is switched on and the cadence
// has come round, so a twice daily sync does not mean twice daily analysis.
export async function runPeriodicAnalysis(options = {}) {
  const run = async (client) => {
    const settings = await getAnalystSettings(client);
    if (!settings?.enabled) return { ran: false, reason: 'Analysis is switched off.' };
    if (!options.messages && !anthropicConfig().configured) {
      return { ran: false, reason: 'ANTHROPIC_API_KEY is not set.' };
    }

    if (settings.last_run_at) {
      const dueAfter = new Date(settings.last_run_at).getTime() + settings.cadence_days * 86_400_000;
      if (Date.now() < dueAfter) return { ran: false, reason: 'Not due yet.' };
    }

    const analysis = await analyse({ kind: 'periodic', client, messages: options.messages });
    return { ran: true, analysis };
  };

  if (options.client) return run(options.client);
  return withTransaction(run, options.pool);
}
