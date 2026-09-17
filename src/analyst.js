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
import { forecast, DEFAULT_SPEND_WINDOW_DAYS } from './forecast.js';
import { today, daysFromNow } from './dates.js';
import { getPayCycle, currentPeriod, periodState } from './buckets.js';
import { effectiveWindowDays } from './costs.js';
import { matchKeyFor } from './commitments.js';

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
        'Costs that look likely to land soon and are not yet tracked as repeating costs. Only include ones with a real basis in the data or in what the user said.',
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
- "Repeating costs" (the data calls them commitments) are outgoings that recur at a regular interval, found automatically from history. Call them repeating costs in anything the household reads.
- "Buckets" are a zero based budget: each pay period, income is divided between them.
- The runway is the projected date spendable cash reaches zero, given expected income, commitments and the everyday spend rate.

How to answer:
- Weigh the recent month most. Their circumstances changed recently, one income stopped and the other changed jobs, so a long average of past spending is a poor guide to next month. Treat a large one off from months ago as exactly that, not as a rate.
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

  // The last thirty days on their own. A year of history is full of one offs
  // and of circumstances that have changed, so the recent month is what the
  // analysis should weigh most.
  const lastThirtyDays = (
    await client.query(`
      select grp.name as group_name, cat.name as category,
             count(*)::int as transactions, sum(-t.amount) as spent
        from budget_flows t
        join categories cat on cat.id = t.category_id
        left join categories grp on grp.id = cat.parent_id
       where t.counts and t.amount < 0 and cat.kind = 'expense'
         and t.txn_date > current_date - 30
       group by grp.name, cat.name
       order by sum(-t.amount) desc
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
    as_of: today(),
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
      planned_everyday_spend_per_day: projection.projected_everyday_rate.per_day,
      recurring_essentials_per_day: projection.projected_everyday_rate.essential_per_day,
      discretionary_allowance_per_month:
        projection.projected_everyday_rate.discretionary_allowance_per_month,
      historical_everyday_spend_per_day: projection.everyday_rate.per_day,
      // Named from the window that produced them. These said "last_90_days"
      // while carrying whatever SPEND_WINDOW_DAYS was set to, which is 120, so
      // Claude was told to read a third more spending into every month than had
      // happened and its advice was built on it.
      spend_window_days: projection.everyday_rate.days,
      days_of_history_in_window: projection.everyday_rate.effective_days,
      committed_in_window: projection.everyday_rate.committed,
      total_out_in_window: projection.everyday_rate.total,
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
      // Free text someone typed, which is where "BSB 306089 acct 41728394"
      // ends up. Every field in this snapshot goes through the scrub, and this
      // one was the exception.
      notes: scrubLabel(account.notes),
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
    spending_last_30_days_by_category: lastThirtyDays,
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
    effect: { type: 'string', description: 'What adding these would do to the date the money runs out and to the budget, in one or two sentences.' },
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
  const key = matchKeyFor(String(proposal.label ?? ''));
  if (!key) throw new Error('That proposal has no usable name.');

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
      // The key detection would produce, so that if this cost does start
      // appearing on the statement its charges leave the everyday rate instead
      // of being counted a second time alongside the commitment.
      key,
      String(proposal.label).trim(),
      amount.toFixed(2),
      cadence,
      proposal.next_due || null,
    ],
  );
  return rows[0];
}


// --- affordability and trimming ------------------------------------------

// What could realistically be cut, ranked by what it is worth a month. The
// planner needs this to answer "how do we afford X" with something other than
// "spend less".
export async function trimmableSpend(client = { query }, { days = DEFAULT_SPEND_WINDOW_DAYS } = {}) {
  // per_month is worked out in SQL as numeric, so the ranking is exact and no
  // float touches an amount on the way to the page or the model.
  const { rows: recurring } = await client.query(
    `select c.label, c.typical_amount, c.cadence_days,
            cat.name as category, grp.name as group_name,
            round((-c.typical_amount) * 30.44 / greatest(c.cadence_days, 1), 2) as per_month
       from commitments c
       left join categories cat on cat.id = c.category_id
       left join categories grp on grp.id = cat.parent_id
      where c.active
      order by per_month desc
      limit 40`,
  );

  // Everyday spending by category over the same recent window the forecast
  // uses, which is where the discretionary money goes even when no single line
  // looks large.
  const { rows: byCategory } = await client.query(
    `select grp.name as group_name, cat.name as category,
            count(*)::int as transactions,
            sum(-t.amount) as spent_in_window,
            round(sum(-t.amount) * 30.44 / $2, 2) as per_month
       from budget_flows t
       join categories cat on cat.id = t.category_id
       left join categories grp on grp.id = cat.parent_id
      where t.counts and t.amount < 0 and cat.kind = 'expense'
        and t.txn_date > current_date - $1::integer
        and t.txn_date <= current_date
      group by grp.name, cat.name
      order by sum(-t.amount) desc`,
    [days, await effectiveWindowDays(days, client)],
  );

  return {
    window_days: days,
    recurring: recurring.map((row) => ({
      label: scrubLabel(row.label),
      amount: row.typical_amount,
      cadence_days: row.cadence_days,
      category: row.category,
      group: row.group_name,
      per_month: row.per_month,
    })),
    by_category: byCategory,
  };
}

const AFFORD_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['yes comfortably', 'yes but tight', 'only with changes', 'not yet'],
    },
    headline: { type: 'string', description: 'One sentence answer, with the key number in it.' },
    reasoning: { type: 'string', description: 'How you got there, briefly, using their figures.' },
    paths: {
      type: 'array',
      description: 'Distinct ways to make it work. Order them best first. Two to four is plenty.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
          frees_up: { type: ['string', 'null'], description: 'Total dollars this path raises or saves, as a plain number string.' },
          when_affordable: { type: ['string', 'null'], description: 'YYYY-MM-DD the purchase becomes safe under this path, or null.' },
          tradeoff: { type: 'string', description: 'What it costs them, honestly.' },
        },
        required: ['name', 'steps', 'frees_up', 'when_affordable', 'tradeoff'],
        additionalProperties: false,
      },
    },
    trims: {
      type: 'array',
      description: 'Specific things to cut or reduce, largest first. Name the actual line item.',
      items: {
        type: 'object',
        properties: {
          what: { type: 'string' },
          monthly_saving: { type: 'string', description: 'A positive dollar amount, as a plain number string.' },
          how: { type: 'string' },
          pain: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['what', 'monthly_saving', 'how', 'pain'],
        additionalProperties: false,
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'headline', 'reasoning', 'paths', 'trims', 'risks'],
  additionalProperties: false,
};

// "Can we spend 5000 on a bike without going broke, and if not, what would have
// to change." The arithmetic is done here and handed over: Claude is asked to
// plan, not to do sums it cannot check.
export async function afford({ amount, description, when = null, client = { query }, messages } = {}) {
  const settings = await getAnalystSettings(client);
  const cost = Math.abs(Number(amount));
  if (!Number.isFinite(cost) || cost <= 0) throw new Error('An amount is required.');

  const date = when || daysFromNow(14);
  const costText = cost.toFixed(2); // input normalisation, once, at the boundary

  const baseline = await forecast({ days: 365, client });
  const scenario = await forecast({
    days: 365,
    client,
    extraEvents: [{ date, kind: 'scenario', label: description || 'One off purchase', amount: `-${costText}` }],
  });
  // The same question without the income that is only hoped for, which is the
  // honest version of the answer.
  const confirmedOnly = await forecast({
    days: 365,
    client,
    includeConfidence: ['confirmed'],
    extraEvents: [{ date, kind: 'scenario', label: description || 'One off purchase', amount: `-${costText}` }],
  });

  const { rows: assets } = await client.query(
    'select name, estimated_value, sellable, notes from assets where sold_on is null order by estimated_value desc',
  );
  const snapshot = await buildSnapshot(client);
  const trims = await trimmableSpend(client);

  const record = await ask({
    snapshot: {
      ...snapshot,
      purchase: { description: description || 'a one off purchase', amount: costText, planned_for: date },
      runway_now_days: baseline.runway_days,
      runway_if_bought_days: scenario.runway_days,
      runway_if_bought_confirmed_income_only_days: confirmedOnly.runway_days,
      expected_income_streams: baseline.expected_income_streams,
      assets_that_could_be_sold: assets,
      what_could_be_trimmed: trims,
    },
    question: description ? `Can we afford ${description} at $${costText}?` : null,
    kind: 'afford',
    effort: settings?.effort ?? 'high',
    schema: AFFORD_SCHEMA,
    messages,
    instruction: [
      'The household wants to make a one off purchase and needs to know whether they can, and if not, what would have to change.',
      'The arithmetic has already been done for you: runway_now_days, runway_if_bought_days, and the same again counting only confirmed income.',
      'Do not recompute those. Explain what they mean and build the paths.',
      'Use every lever in the snapshot: selling an asset, trimming a named recurring cost, delaying until income starts, or paying over time.',
      'Name actual line items when you propose a trim. "Cut subscriptions" is useless, "Cursor at $351 a month" is not.',
      'Be honest about the version where the hoped for income does not arrive.',
    ].join(' '),
  });
  return store(record, client);
}

// Just the trimming question, without a purchase attached.
export async function suggestTrims({ client = { query }, messages } = {}) {
  const settings = await getAnalystSettings(client);
  const snapshot = await buildSnapshot(client);
  const trims = await trimmableSpend(client);
  const { rows: assets } = await client.query(
    'select name, estimated_value, sellable from assets where sold_on is null order by estimated_value desc',
  );

  const record = await ask({
    snapshot: { ...snapshot, what_could_be_trimmed: trims, assets_that_could_be_sold: assets },
    kind: 'on_demand',
    effort: settings?.effort ?? 'high',
    messages,
    instruction: [
      'Find where this household could realistically spend less, largest first.',
      'Name actual line items and their real monthly cost. Group things that belong together, for example all the AI and developer tooling.',
      'Say plainly what each cut would hurt. Do not propose cutting things that are already small.',
      'Put the trims in predicted_expenses only if they are new costs. Cuts belong in recommendations, with the monthly saving as estimated_monthly_impact.',
    ].join(' '),
  });
  return store(record, client);
}


// --- identifying merchants ------------------------------------------------

const MERCHANT_SCHEMA = {
  type: 'object',
  properties: {
    merchants: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          match_key: { type: 'string', description: 'Copy the key back exactly as it was given.' },
          display_name: { type: 'string', description: 'What a person would call this place.' },
          what_it_is: { type: 'string', description: 'One short line: what it is and what the money buys.' },
          suggested_category: { type: ['string', 'null'], description: 'The best fit from the category list given, or null if none fits.' },
          forecast_tier: {
            type: 'string',
            enum: ['keep', 'trim', 'cut'],
            description: 'Keep for fixed essentials, trim for flexible essentials, cut for optional spending.',
          },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['match_key', 'display_name', 'what_it_is', 'suggested_category', 'forecast_tier', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['merchants'],
  additionalProperties: false,
};

// Works out what the unrecognised places on the statement actually are, from
// the description, the amounts and how often they recur. Australian merchants,
// so a model that knows the local names has a real advantage over a lookup
// table anyone would have to maintain by hand.
export async function identifyMerchants({ window = 60, client = { query }, messages } = {}) {
  const settings = await getAnalystSettings(client);

  const { rows: unknown } = await client.query(
    `select t.merchant_key, count(*)::int as times,
            round(sum(-t.amount), 2) as total,
            round(avg(-t.amount), 2) as typical,
            array_agg(distinct left(t.description, 48)) as examples
       from budget_flows t
       left join merchants m on m.match_key = t.merchant_key
      where t.counts and t.amount < 0
        and m.what_it_is is null
        and coalesce(m.source, 'auto') = 'auto'
        and t.merchant_key is not null
        and t.txn_date > current_date - $1::integer
      group by t.merchant_key
      order by sum(-t.amount) desc
      limit 40`,
    [window],
  );
  if (!unknown.length) return { identified: 0, merchants: [] };

  const { rows: categoryRows } = await client.query(
    `select c.name from categories c where c.parent_id is not null and not c.archived order by c.name`,
  );
  const categoryNames = categoryRows.map((row) => row.name);

  const record = await ask({
    snapshot: {
      // Only the merchant lines, not the whole financial picture: this question
      // does not need balances or a runway, and a smaller prompt is cheaper.
      categories_available: categoryNames,
      unidentified_merchants: unknown.map((row) => ({
        match_key: row.merchant_key,
        times_seen: row.times,
        total_spent: row.total,
        typical_amount: row.typical,
        example_descriptions: (row.examples || []).map(scrubLabel),
      })),
    },
    kind: 'merchants',
    effort: settings?.effort ?? 'high',
    schema: MERCHANT_SCHEMA,
    messages,
    instruction: [
      'These are lines from an Australian bank statement that the app could not identify.',
      'For each one, say what the place is and what the money buys, in one short line.',
      'Use the example descriptions, the typical amount and how often it recurs as evidence.',
      'Pick a suggested_category only from the list given, exactly as spelled there, or null if none fits.',
      'If you genuinely do not know what something is, say so in what_it_is and set confidence to low. Do not invent a plausible sounding business.',
      'Copy each match_key back exactly as given, it is how the answer is matched up.',
    ].join(' '),
  });

  // Write back only what is usable, and never over a name someone chose.
  const byName = new Map(
    (await client.query('select id, name from categories where parent_id is not null')).rows.map((r) => [r.name, r.id]),
  );
  let identified = 0;
  for (const entry of record.result.merchants ?? []) {
    if (!entry.match_key) continue;
    const { rowCount } = await client.query(
      `update merchants set
         display_name = case when source = 'auto' then coalesce($2, display_name) else display_name end,
         what_it_is   = coalesce($3, what_it_is),
         category_id  = coalesce(category_id, $4),
         lean_tier    = coalesce(lean_tier, $5::lean_tier),
         source       = case when source = 'auto' then 'claude' else source end,
         updated_at   = now()
       where match_key = $1 and source <> 'manual'`,
      [
        entry.match_key,
        entry.display_name || null,
        entry.what_it_is || null,
        entry.suggested_category ? byName.get(entry.suggested_category) ?? null : null,
        ['keep', 'trim', 'cut'].includes(entry.forecast_tier) ? entry.forecast_tier : null,
      ],
    );
    identified += rowCount;
  }

  await store(record, client);
  return { identified, merchants: record.result.merchants ?? [] };
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
