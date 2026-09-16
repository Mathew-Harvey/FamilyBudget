// Transactions, filterable by account, date range, status and transfer flag.
import { Router } from 'express';
import { query } from '../db.js';

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

    const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
    const limit = Math.min(Number(req.query.limit) || 200, MAX_LIMIT);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const { rows } = await query(
      `select t.id, t.txn_date, t.posted_date, t.description, t.amount, t.status,
              t.is_transfer, t.transfer_pair_id, t.transfer_confidence,
              t.merchant_name, t.provider_category, t.reference,
              a.id as account_id, a.bank, a.name as account_name, a.masked_number,
              pa.name as pair_account_name, pa.masked_number as pair_masked_number,
              p.txn_date as pair_date, p.amount as pair_amount
         from transactions t
         join accounts a on a.id = t.account_id
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
