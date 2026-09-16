// Accounts: what the app holds, and the two fields a person sets by hand.
import { Router } from 'express';
import { query } from '../db.js';

const ROLES = ['joint_everyday', 'personal_everyday', 'personal_savings', 'mortgage', 'other'];

export const accountsRouter = Router();

accountsRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(`
      select a.id, a.bank, a.name, a.masked_number, a.type, a.role, a.is_liquid,
             a.source, a.currency, a.status,
             count(t.id)::int              as transaction_count,
             min(t.txn_date)               as earliest_transaction,
             max(t.txn_date)               as latest_transaction,
             b.balance                     as latest_balance,
             b.available_balance           as latest_available_balance,
             b.balance_date                as latest_balance_date,
             b.freshness                   as balance_freshness
        from accounts a
        left join transactions t on t.account_id = a.id
        left join lateral (
          select balance, available_balance, balance_date, freshness
            from balances
           where account_id = a.id
           order by balance_date desc
           limit 1
        ) b on true
       group by a.id, b.balance, b.available_balance, b.balance_date, b.freshness
       order by a.bank, a.name
    `);
    res.json({ accounts: rows });
  } catch (err) {
    next(err);
  }
});

// Role and is_liquid live in the database and are set here, never hardcoded.
accountsRouter.post('/:id', async (req, res, next) => {
  try {
    const { role, is_liquid: isLiquid } = req.body ?? {};
    if (role !== undefined && role !== null && !ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });
    }
    if (isLiquid !== undefined && typeof isLiquid !== 'boolean') {
      return res.status(400).json({ error: 'is_liquid must be true or false' });
    }
    const { rows } = await query(
      `update accounts
          set role       = coalesce($2, role),
              is_liquid  = coalesce($3, is_liquid),
              updated_at = now()
        where id = $1
        returning id, role, is_liquid`,
      [req.params.id, role ?? null, isLiquid ?? null],
    );
    if (!rows.length) return res.status(404).json({ error: 'No such account' });
    res.json({ account: rows[0] });
  } catch (err) {
    next(err);
  }
});
