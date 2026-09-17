// Transactions, filterable by account, date range, status and transfer flag.
import { Router } from 'express';
import { query } from '../db.js';
import { setCategoryManually } from '../categorise.js';

export const transactionsRouter = Router();

const MAX_LIMIT = 500;

transactionsRouter.get('/', async (req, res, next) => {
  try {
    const conditions = [];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };

    if (req.query.account_id) add('t.account_id = ?', req.query.account_id);
    if (req.query.from) add('t.txn_date >= ?::date', req.query.from);
    if (req.query.to) add('t.txn_date <= ?::date', req.query.to);
    if (req.query.status) add('t.status = ?', req.query.status);
    if (req.query.transfer === 'true') conditions.push('t.is_transfer');
    if (req.query.transfer === 'false') conditions.push('not t.is_transfer');
    if (req.query.search) add("t.description ilike '%' || ? || '%'", req.query.search);
    // "none" is the filter for rows with no category at all, which cannot be
    // expressed as an equality against a uuid column.
    if (req.query.category_id === 'none') conditions.push('t.category_id is null');
    else if (req.query.category_id) add('t.category_id = ?', req.query.category_id);
    if (req.query.uncategorised === 'true') conditions.push('t.category_id is null');

    const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
    const limit = Math.min(Number(req.query.limit) || 200, MAX_LIMIT);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const { rows } = await query(
      `select t.id, t.txn_date, t.posted_date, t.description, t.amount, t.status,
              t.is_transfer, t.transfer_pair_id, t.transfer_confidence,
              t.merchant_name, t.provider_category, t.reference,
              t.category_id, t.category_source, t.display_description, t.note, t.one_off,
              cat.name as category_name, grp.name as category_group,
              a.id as account_id, a.bank, a.name as account_name, a.masked_number,
              pa.name as pair_account_name, pa.masked_number as pair_masked_number,
              p.txn_date as pair_date, p.amount as pair_amount
         from transactions t
         join accounts a on a.id = t.account_id
         left join categories cat on cat.id = t.category_id
         left join categories grp on grp.id = cat.parent_id
         left join transactions p on p.id = t.transfer_pair_id
         left join accounts pa on pa.id = p.account_id
         ${where}
        order by t.txn_date desc, t.created_at desc
        limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, limit, offset],
    );

    const totals = await query(
      `select count(*)::int as count, coalesce(sum(t.amount), 0) as net
         from transactions t ${where}`,
      params,
    );

    res.json({ transactions: rows, total: totals.rows[0].count, net: totals.rows[0].net, limit, offset });
  } catch (err) {
    next(err);
  }
});

// What has not been filed, grouped by where it went.
//
// Registered before any route with a parameter in it, or /:id would swallow it.
//
// 483 uncategorised rows on this household are fifteen merchants: 65 ALDI, 62
// Woolworths, 57 Coles. Filing them one at a time is the same judgement 483
// times, so the page offers the fifteen and writes a rule for each, which files
// the history and everything that arrives later.
//
// budget_flows rather than transactions, so a transfer between our own accounts
// is not sitting in the list forever waiting to be given a category it should
// never have.
transactionsRouter.get('/unfiled', async (req, res, next) => {
  try {
    const { rows } = await query(
      `select coalesce(merchant_key, 'Not described by the bank') as merchant,
              count(*)::int as count,
              coalesce(sum(-amount), 0) as total,
              min(txn_date) as first_seen,
              max(txn_date) as last_seen
         from budget_flows
        where counts and category_id is null
        group by 1
        order by count(*) desc
        limit 60`,
    );
    const { rows: [totals] } = await query(
      `select count(*)::int as unfiled, coalesce(sum(-amount), 0) as total
         from budget_flows where counts and category_id is null`,
    );
    res.json({ places: rows, rows: totals.unfiled, total: totals.total });
  } catch (err) {
    next(err);
  }
});

// Setting a category by hand pins it, so later rule runs leave it alone.
transactionsRouter.post('/:id/category', async (req, res, next) => {
  try {
    const updated = await setCategoryManually(req.params.id, req.body?.category_id ?? null);
    if (!updated) return res.status(404).json({ error: 'No such transaction' });
    res.json({ transaction: updated });
  } catch (err) {
    next(err);
  }
});
