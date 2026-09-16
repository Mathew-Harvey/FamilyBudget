// Stage 3: the pay cycle, pay periods and buckets.
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import {
  CADENCES,
  getPayCycle,
  setPayCycle,
  ensurePayPeriods,
  periodState,
  currentPeriod,
  allocate,
  applyTargets,
  suggestPayCycle,
} from '../buckets.js';

export const bucketsRouter = Router();

// --- the pay cycle -------------------------------------------------------

bucketsRouter.get('/cycle', async (req, res, next) => {
  try {
    res.json({ cycle: await getPayCycle(), suggestion: await suggestPayCycle() });
  } catch (err) {
    next(err);
  }
});

bucketsRouter.post('/cycle', async (req, res, next) => {
  try {
    const { cadence, anchor_date: anchorDate, expected_income: expectedIncome } = req.body ?? {};
    if (!CADENCES.includes(cadence)) {
      return res.status(400).json({ error: `cadence must be one of ${CADENCES.join(', ')}` });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(anchorDate || ''))) {
      return res.status(400).json({ error: 'anchor_date must be a date like 2026-09-09' });
    }
    const cycle = await setPayCycle(cadence, anchorDate, expectedIncome ?? null);
    const periods = await ensurePayPeriods();
    res.json({ cycle, periods });
  } catch (err) {
    next(err);
  }
});

// --- periods -------------------------------------------------------------

bucketsRouter.get('/periods', async (req, res, next) => {
  try {
    await ensurePayPeriods();
    const { rows } = await query(
      `select p.id, p.starts_on, p.ends_on,
              (p.starts_on <= current_date and p.ends_on >= current_date) as is_current,
              coalesce((select sum(ba.allocated) from bucket_allocations ba
                         where ba.pay_period_id = p.id), 0) as total_allocated,
              coalesce((select sum(t.amount) from budget_flows t
                          join categories c on c.id = t.category_id
                         where c.kind = 'income' and t.counts
                           and t.txn_date between p.starts_on and p.ends_on), 0) as income
         from pay_periods p
        where p.starts_on <= current_date + 60
        order by p.starts_on desc
        limit 30`,
    );
    res.json({ periods: rows });
  } catch (err) {
    next(err);
  }
});

bucketsRouter.get('/periods/current', async (req, res, next) => {
  try {
    await ensurePayPeriods();
    const period = await currentPeriod();
    if (!period) return res.json({ state: null });
    res.json({ state: await periodState(period.id) });
  } catch (err) {
    next(err);
  }
});

bucketsRouter.get('/periods/:id', async (req, res, next) => {
  try {
    const state = await periodState(req.params.id);
    if (!state) return res.status(404).json({ error: 'No such pay period' });
    res.json({ state });
  } catch (err) {
    next(err);
  }
});

bucketsRouter.post('/periods/:id/apply-targets', async (req, res, next) => {
  try {
    res.json({ filled: await applyTargets(req.params.id) });
  } catch (err) {
    next(err);
  }
});

bucketsRouter.post('/periods/:id/allocate', async (req, res, next) => {
  try {
    const { bucket_id: bucketId, allocated } = req.body ?? {};
    if (!bucketId) return res.status(400).json({ error: 'bucket_id is required' });
    if (allocated === undefined || allocated === null || Number.isNaN(Number(allocated))) {
      return res.status(400).json({ error: 'allocated must be a number' });
    }
    await allocate(bucketId, req.params.id, allocated);
    res.json({ state: await periodState(req.params.id) });
  } catch (err) {
    next(err);
  }
});

// --- buckets -------------------------------------------------------------

bucketsRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(`
      select b.*,
             coalesce(json_agg(json_build_object('id', c.id, 'name', c.name, 'group_name', g.name))
                      filter (where c.id is not null), '[]') as categories
        from buckets b
        left join bucket_categories bc on bc.bucket_id = b.id
        left join categories c on c.id = bc.category_id
        left join categories g on g.id = c.parent_id
       group by b.id
       order by b.sort_order, b.name
    `);
    res.json({ buckets: rows });
  } catch (err) {
    next(err);
  }
});

bucketsRouter.post('/', async (req, res, next) => {
  try {
    const { name, notes, target, carry_over: carryOver, sort_order: sortOrder, category_ids: categoryIds } = req.body ?? {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'A name is required' });

    const bucket = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into buckets (name, notes, target, carry_over, sort_order)
         values ($1, $2, coalesce($3, 0), coalesce($4, true), coalesce($5, 100))
         returning *`,
        [String(name).trim(), notes ?? null, target ?? null, carryOver ?? null, sortOrder ?? null],
      );
      const created = rows[0];
      for (const categoryId of categoryIds ?? []) {
        await client.query(
          'insert into bucket_categories (bucket_id, category_id) values ($1, $2) on conflict do nothing',
          [created.id, categoryId],
        );
      }
      return created;
    });
    res.status(201).json({ bucket });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That name is taken, or one of those categories already belongs to another bucket' });
    }
    next(err);
  }
});

bucketsRouter.post('/:id', async (req, res, next) => {
  try {
    const { name, notes, target, carry_over: carryOver, sort_order: sortOrder, archived, category_ids: categoryIds } = req.body ?? {};
    const bucket = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `update buckets set
           name       = coalesce($2, name),
           notes      = coalesce($3, notes),
           target     = coalesce($4, target),
           carry_over = coalesce($5, carry_over),
           sort_order = coalesce($6, sort_order),
           archived   = coalesce($7, archived),
           updated_at = now()
         where id = $1
         returning *`,
        [req.params.id, name ?? null, notes ?? null, target ?? null, carryOver ?? null, sortOrder ?? null, archived ?? null],
      );
      if (!rows.length) return null;

      // Categories are replaced whole when supplied, which is simpler to reason
      // about than working out adds and removes.
      if (Array.isArray(categoryIds)) {
        await client.query('delete from bucket_categories where bucket_id = $1', [req.params.id]);
        for (const categoryId of categoryIds) {
          await client.query('insert into bucket_categories (bucket_id, category_id) values ($1, $2)', [
            req.params.id,
            categoryId,
          ]);
        }
      }
      return rows[0];
    });
    if (!bucket) return res.status(404).json({ error: 'No such bucket' });
    res.json({ bucket });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That name is taken, or one of those categories already belongs to another bucket' });
    }
    next(err);
  }
});

bucketsRouter.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await query('delete from buckets where id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'No such bucket' });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});
