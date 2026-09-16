// Stage 4: the forecast, the runway, and the commitments behind them.
import { Router } from 'express';
import { query } from '../db.js';
import { forecast } from '../forecast.js';
import { detectCommitments } from '../commitments.js';

export const forecastRouter = Router();

forecastRouter.get('/', async (req, res, next) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 14), 365);
    const buffer = Number(req.query.buffer) || 0;
    res.json(await forecast({ days, buffer }));
  } catch (err) {
    next(err);
  }
});

forecastRouter.get('/commitments', async (req, res, next) => {
  try {
    const { rows } = await query(`
      select c.*, cat.name as category_name, grp.name as group_name
        from commitments c
        left join categories cat on cat.id = c.category_id
        left join categories grp on grp.id = cat.parent_id
       order by c.active desc, c.typical_amount, c.label
    `);
    res.json({ commitments: rows });
  } catch (err) {
    next(err);
  }
});

forecastRouter.post('/commitments/detect', async (req, res, next) => {
  try {
    res.json({ found: await detectCommitments() });
  } catch (err) {
    next(err);
  }
});

forecastRouter.post('/commitments', async (req, res, next) => {
  try {
    const { label, typical_amount: amount, cadence_days: cadence, next_due: nextDue, category_id: categoryId } = req.body ?? {};
    if (!label || !String(label).trim()) return res.status(400).json({ error: 'A label is required' });
    if (!Number(amount)) return res.status(400).json({ error: 'A typical amount is required' });
    if (!Number(cadence)) return res.status(400).json({ error: 'How often it happens, in days, is required' });

    // A hand entered commitment uses a key detection will not produce, so the
    // two never fight over the same row.
    const { rows } = await query(
      `insert into commitments (match_key, label, typical_amount, cadence_days, next_due,
                                category_id, source, occurrences, regularity)
       values ($1, $2, $3, $4, $5, $6, 'manual', 0, 1)
       returning *`,
      [
        `manual:${String(label).trim().toLowerCase()}`,
        String(label).trim(),
        // Outgoings are negative everywhere in this app.
        -Math.abs(Number(amount)),
        Math.round(Number(cadence)),
        nextDue || null,
        categoryId || null,
      ],
    );
    res.status(201).json({ commitment: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'There is already a commitment with that name' });
    next(err);
  }
});

forecastRouter.post('/commitments/:id', async (req, res, next) => {
  try {
    const { active, typical_amount: amount, cadence_days: cadence, next_due: nextDue, label } = req.body ?? {};
    const { rows } = await query(
      `update commitments set
         active         = coalesce($2, active),
         typical_amount = coalesce($3, typical_amount),
         cadence_days   = coalesce($4, cadence_days),
         next_due       = coalesce($5, next_due),
         label          = coalesce($6, label),
         updated_at     = now()
       where id = $1
       returning *`,
      [
        req.params.id,
        active ?? null,
        amount === undefined || amount === null ? null : -Math.abs(Number(amount)),
        cadence ?? null,
        nextDue ?? null,
        label ?? null,
      ],
    );
    if (!rows.length) return res.status(404).json({ error: 'No such commitment' });
    res.json({ commitment: rows[0] });
  } catch (err) {
    next(err);
  }
});

forecastRouter.delete('/commitments/:id', async (req, res, next) => {
  try {
    const { rowCount } = await query('delete from commitments where id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'No such commitment' });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});
