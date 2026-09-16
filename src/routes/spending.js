// Where the money actually went, drillable: group, then category, then
// merchant, then the individual transactions.
//
// Every level uses the same window, and every level reports a per month figure
// as well as the total, because "1,400 over 60 days" and "700 a month" answer
// different questions and people want both.
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { DEFAULT_SPEND_WINDOW_DAYS } from '../forecast.js';

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
              count(*)::int                       as transactions,
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
    const { display_name: displayName, what_it_is: whatItIs, essential, category_id: categoryId } = req.body ?? {};
    const { rows } = await query(
      `update merchants set
         display_name = coalesce($2, display_name),
         what_it_is   = coalesce($3, what_it_is),
         essential    = coalesce($4, essential),
         category_id  = coalesce($5, category_id),
         source       = 'manual',
         updated_at   = now()
       where match_key = $1
       returning *`,
      [req.params.key, displayName ?? null, whatItIs ?? null, essential ?? null, categoryId ?? null],
    );
    if (!rows.length) return res.status(404).json({ error: 'No such merchant' });

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
