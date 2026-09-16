// Where the money actually went, drillable: group, then category, then
// merchant, then the individual transactions.
//
// Every level uses the same window, and every level reports a per month figure
// as well as the total, because "1,400 over 60 days" and "700 a month" answer
// different questions and people want both.
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { DEFAULT_SPEND_WINDOW_DAYS } from '../forecast.js';
import { matchKeyFor } from '../commitments.js';

export const spendingRouter = Router();

const windowFrom = (req) =>
  Math.min(Math.max(Number(req.query.window) || DEFAULT_SPEND_WINDOW_DAYS, 7), 400);

// The overview: what each group and category cost, and the biggest merchants.
spendingRouter.get('/', async (req, res, next) => {
  try {
    const days = windowFrom(req);

    const { rows: categories } = await query(
      `select coalesce(grp.name, 'Uncategorised') as group_name,
              coalesce(grp.sort_order, 999)       as group_order,
              cat.name                            as category,
              cat.id                              as category_id,
              count(*)::int                       as transactions,
              sum(-t.amount)                      as spent,
              round(sum(-t.amount) * 30.44 / $1, 2) as per_month
         from budget_flows t
         left join categories cat on cat.id = t.category_id
         left join categories grp on grp.id = cat.parent_id
        where t.counts and t.amount < 0
          and (cat.kind is null or cat.kind = 'expense')
          and t.txn_date > current_date - $1::integer
        group by grp.name, grp.sort_order, cat.name, cat.id
        order by group_order, sum(-t.amount) desc`,
      [days],
    );

    const { rows: totals } = await query(
      `select coalesce(sum(-t.amount), 0) as spent,
              round(coalesce(sum(-t.amount), 0) * 30.44 / $1, 2) as per_month,
              count(*)::int as transactions
         from budget_flows t
         left join categories cat on cat.id = t.category_id
        where t.counts and t.amount < 0
          and (cat.kind is null or cat.kind = 'expense')
          and t.txn_date > current_date - $1::integer`,
      [days],
    );

    // Grouped for the page, so it does not have to do the nesting itself.
    const groups = [];
    for (const row of categories) {
      let group = groups.find((g) => g.name === row.group_name);
      if (!group) {
        group = { name: row.group_name, spent: '0', per_month: '0', categories: [] };
        groups.push(group);
      }
      group.categories.push(row);
    }
    // Group totals summed in SQL, so the arithmetic stays numeric.
    const { rows: groupTotals } = await query(
      `select coalesce(grp.name, 'Uncategorised') as group_name,
              sum(-t.amount) as spent,
              round(sum(-t.amount) * 30.44 / $1, 2) as per_month
         from budget_flows t
         left join categories cat on cat.id = t.category_id
         left join categories grp on grp.id = cat.parent_id
        where t.counts and t.amount < 0
          and (cat.kind is null or cat.kind = 'expense')
          and t.txn_date > current_date - $1::integer
        group by grp.name`,
      [days],
    );
    for (const group of groups) {
      const total = groupTotals.find((g) => g.group_name === group.name);
      if (total) {
        group.spent = total.spent;
        group.per_month = total.per_month;
      }
    }

    res.json({ window_days: days, total: totals[0], groups });
  } catch (err) {
    next(err);
  }
});

// Merchants, ranked. Optionally within one category.
spendingRouter.get('/merchants', async (req, res, next) => {
  try {
    const days = windowFrom(req);
    const categoryId = req.query.category_id || null;

    const { rows } = await query(
      `select coalesce(m.display_name, t.merchant_key, 'Not described by the bank') as merchant,
              min(t.merchant_key)                 as merchant_key,
              max(m.what_it_is)                   as what_it_is,
              bool_or(m.essential)                as essential,
              max(m.ended_on)                     as ended_on,
              count(*)::int                       as transactions,
              count(distinct t.txn_date)::int     as days_paid,
              sum(-t.amount)                      as spent,
              round(sum(-t.amount) * 30.44 / $1, 2) as per_month,
              min(t.txn_date)                     as first_seen,
              max(t.txn_date)                     as last_seen,
              max(cat.name)                       as category
         from budget_flows t
         left join merchants m on m.match_key = t.merchant_key
         left join categories cat on cat.id = t.category_id
        where t.counts and t.amount < 0
          and (cat.kind is null or cat.kind = 'expense')
          and t.txn_date > current_date - $1::integer
          and ($2::uuid is null or t.category_id = $2::uuid)
        group by coalesce(m.display_name, t.merchant_key, 'Not described by the bank')
        order by sum(-t.amount) desc
        limit 200`,
      [days, categoryId],
    );
    res.json({ window_days: days, merchants: rows });
  } catch (err) {
    next(err);
  }
});

// Everything charged by one merchant, so "what is this" can be answered by
// looking at the actual transactions.
spendingRouter.get('/merchants/:key/transactions', async (req, res, next) => {
  try {
    const days = windowFrom(req);
    const { rows } = await query(
      `select t.id, t.txn_date, t.amount, t.description, t.display_description,
              a.bank, a.masked_number, cat.name as category
         from budget_flows t
         join accounts a on a.id = t.account_id
         left join categories cat on cat.id = t.category_id
         left join merchants m on m.match_key = t.merchant_key
        where t.counts
          and (t.merchant_key = $2 or m.display_name = $2)
          and t.txn_date > current_date - $1::integer
        order by t.txn_date desc
        limit 100`,
      [days, req.params.key],
    );
    res.json({ transactions: rows });
  } catch (err) {
    next(err);
  }
});

// Naming a merchant, saying what it is, and marking it essential.
spendingRouter.post('/merchants/:key', async (req, res, next) => {
  try {
    const {
      display_name: displayName, what_it_is: whatItIs, essential, category_id: categoryId,
      // Finished with: cancelled, switched away from, or stopped using. The
      // history stays and every total still shows it, it just stops being a
      // guide to next month. Pass false to undo.
      ended,
    } = req.body ?? {};
    const { rows } = await query(
      `update merchants set
         display_name = coalesce($2, display_name),
         what_it_is   = coalesce($3, what_it_is),
         essential    = coalesce($4, essential),
         category_id  = coalesce($5, category_id),
         ended_on     = case when $6::boolean is null then ended_on
                             when $6 then coalesce(ended_on, current_date)
                             else null end,
         source       = 'manual',
         updated_at   = now()
       where match_key = $1
       returning *`,
      [req.params.key, displayName ?? null, whatItIs ?? null, essential ?? null, categoryId ?? null,
       ended === undefined ? null : Boolean(ended)],
    );
    if (!rows.length) return res.status(404).json({ error: 'No such merchant' });

    // Finishing with a merchant has to stop its commitment too, or the bill
    // leaves the spend rate and carries on being projected on its due dates,
    // which is the worst of both: cancelled and still forecast.
    //
    // Resolved in JavaScript, because a commitment key and a merchant key are
    // different normalisations and joining them in SQL matches almost nothing.
    if (ended !== undefined) {
      const { rows: labels } = await query(
        `select distinct coalesce(display_description, description) as label
           from budget_flows where merchant_key = $1`,
        [req.params.key],
      );
      const keys = [...new Set(labels.map((row) => matchKeyFor(row.label)).filter(Boolean))];
      if (keys.length) {
        await query(
          `update commitments set active = $2, updated_at = now()
            where match_key = any($1::text[]) and source = 'detected'`,
          [keys, !ended],
        );
      }
    }

    // Naming a merchant is also a way of categorising everything it sold you,
    // which saves writing a rule for each one. Rows set by hand are left alone.
    if (categoryId) {
      await withTransaction(async (client) => {
        await client.query(
          `update transactions set category_id = $2, category_source = 'rule', updated_at = now()
            where merchant_key = $1 and category_source is distinct from 'manual'`,
          [req.params.key, categoryId],
        );
      });
    }
    res.json({ merchant: rows[0] });
  } catch (err) {
    next(err);
  }
});

// The ones worth naming first: biggest spend, still carrying a generated name
// and no explanation.
spendingRouter.get('/unexplained', async (req, res, next) => {
  try {
    const days = windowFrom(req);
    const { rows } = await query(
      `select t.merchant_key, m.display_name, count(*)::int as transactions,
              sum(-t.amount) as spent,
              array_agg(distinct left(t.description, 48)) as examples
         from budget_flows t
         left join merchants m on m.match_key = t.merchant_key
        where t.counts and t.amount < 0
          and m.what_it_is is null
          and coalesce(m.source, 'auto') = 'auto'
          and t.txn_date > current_date - $1::integer
        group by t.merchant_key, m.display_name
        order by sum(-t.amount) desc
        limit 40`,
      [days],
    );
    res.json({ window_days: days, merchants: rows });
  } catch (err) {
    next(err);
  }
});

// Purchases that look like they happened once rather than repeatedly.
//
// The point of marking these is that a rate should describe normal life. The
// 2025 renovation put tens of thousands through the account, and while it was
// still inside the window every forecast built on it was wrong. Hiding it
// behind a short window worked only until the next large purchase, and threw
// away the older history that makes a rate stable in the first place.
//
// A candidate is large, and comes from somewhere we have paid rarely. That is a
// suggestion, not a decision: a person confirms it, because only a person knows
// whether the new dishwasher replaces one that will last ten years or is the
// first of six trips to Bunnings.
spendingRouter.get('/one-off-candidates', async (req, res, next) => {
  try {
    const days = Math.min(Math.max(Number(req.query.window) || 400, 30), 800);
    const { rows } = await query(
      `with seen as (
         select merchant_key, count(*)::int as times
           from budget_flows
          where counts and amount < 0 and txn_date > current_date - $1::integer
          group by merchant_key
       )
       select t.id, t.txn_date, -t.amount as amount, t.one_off,
              coalesce(m.display_name, t.merchant_key, 'Not described by the bank') as place,
              coalesce(s.times, 1) as times_paid,
              cat.name as category
         from budget_flows t
         left join merchants m on m.match_key = t.merchant_key
         left join seen s on s.merchant_key = t.merchant_key
         left join categories cat on cat.id = t.category_id
        where t.counts and t.amount < 0
          and t.txn_date > current_date - $1::integer
          and -t.amount >= 400
          and coalesce(s.times, 1) <= 4
        order by -t.amount desc
        limit 60`,
      [days],
    );
    res.json({ window_days: days, candidates: rows });
  } catch (err) {
    next(err);
  }
});

// An annual bill is not a one off, it is a commitment with a long cadence.
// Commitment detection ignores anything spaced more than 200 days apart,
// because two petrol fills four months apart are not a quarterly bill, so rates,
// rego, insurance and health cover never reached the forecast at all. They are
// real and predictable, so they are confirmed by hand and marked annual, which
// keeps detection from standing them down for having gone quiet.
spendingRouter.post('/annual', async (req, res, next) => {
  try {
    const { label, amount, next_due: nextDue, cadence_days: cadence = 365 } = req.body ?? {};
    // The label has to be a real description from the statement, because the key
    // is derived from it. An earlier version accepted a merchant key and stored
    // that: commitments are looked up by matchKeyFor and merchants by
    // merchantKeyFor, and the two normalisations never match, so the bill would
    // have been projected as a commitment AND left in the everyday rate, and
    // counted twice. Same drift CLAUDE.md warns about, third instance found.
    if (!label || !String(label).trim()) {
      return res.status(400).json({ error: 'A label is required, and it must match how the bill appears on the statement' });
    }
    if (!Number(amount)) return res.status(400).json({ error: 'A typical amount is required' });
    if (!nextDue) return res.status(400).json({ error: 'A date it is next due is required' });

    const matchKey = matchKeyFor(label);
    if (!matchKey) return res.status(400).json({ error: 'That label has nothing in it to match on' });

    // Negative is money out, everywhere. The forecast adds typical_amount to
    // the balance, so a bill entered as 1800 rather than -1800 paid the
    // household 1800 on its due date instead of charging it: a 3,600 dollar
    // error every time it came round. The sign is not the caller's to get
    // wrong, so it is normalised here rather than validated.
    const outgoing = -Math.abs(Number(amount));
    if (!Number.isFinite(outgoing)) return res.status(400).json({ error: 'That amount is not a number' });

    const { rows } = await query(
      `insert into commitments (match_key, label, typical_amount, cadence_days, next_due,
                                occurrences, regularity, annual, source, active)
       values ($1, $2, $3, $4, $5, 1, 1, true, 'manual', true)
       on conflict (match_key) do update set
         label = excluded.label, typical_amount = excluded.typical_amount,
         cadence_days = excluded.cadence_days, next_due = excluded.next_due,
         annual = true, source = 'manual', active = true, updated_at = now()
       returning *`,
      [matchKey, String(label).trim(), outgoing.toFixed(2), Number(cadence) || 365, nextDue],
    );
    res.json({ commitment: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Marking, one transaction or a whole merchant at a time. A one off stays in
// every total and on every page: it really happened. It is left out only where
// a rate is worked out, which is the forecast and the trim suggestions.
spendingRouter.post('/one-off', async (req, res, next) => {
  try {
    const { ids, merchant_key: merchantKey, one_off: oneOff = true } = req.body ?? {};
    if (!Array.isArray(ids) && !merchantKey) {
      return res.status(400).json({ error: 'Give either a list of transaction ids or a merchant key' });
    }
    const { rowCount } = merchantKey
      ? await query(
          `update transactions set one_off = $2, updated_at = now()
            where merchant_key = $1 and amount < 0`,
          [merchantKey, Boolean(oneOff)],
        )
      : await query(
          `update transactions set one_off = $2, updated_at = now() where id = any($1::uuid[])`,
          [ids, Boolean(oneOff)],
        );
    res.json({ updated: rowCount });
  } catch (err) {
    next(err);
  }
});
