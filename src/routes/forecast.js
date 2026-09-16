// Stage 4: the forecast, the runway, and the commitments behind them.
import { Router } from 'express';
import { query } from '../db.js';
import { forecast, DEFAULT_SPEND_WINDOW_DAYS } from '../forecast.js';
import { detectCommitments } from '../commitments.js';
import { tieredCosts } from '../lean.js';
import { numericToCents, centsToNumeric } from '../money.js';

export const forecastRouter = Router();

forecastRouter.get('/', async (req, res, next) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 14), 365);
    // Normalised once here so the forecast only ever sees exact 2dp text.
    const buffer = (Number(req.query.buffer) || 0).toFixed(2);
    const window = Math.min(Math.max(Number(req.query.window) || DEFAULT_SPEND_WINDOW_DAYS, 14), 180);
    let discretionaryCents;
    try {
      discretionaryCents = numericToCents(String(req.query.discretionary || '0'));
    } catch {
      return res.status(400).json({ error: 'Discretionary spending must be a dollar amount with at most two decimal places' });
    }
    if (discretionaryCents < 0) {
      return res.status(400).json({ error: 'Discretionary spending cannot be negative' });
    }

    const costs = await tieredCosts({ window });
    const optionalCommitments = costs.commitments.filter((row) => row.tier === 'cut');
    const optionalIds = new Set(optionalCommitments.map((row) => String(row.commitment_id)));
    const requestedExclusions = String(req.query.exclude_commitments || '')
      .split(',')
      .filter(Boolean);
    // The control can turn off luxuries. Fixed and essential commitments
    // cannot be hidden by editing a query string.
    const excluded = requestedExclusions.filter((id) => optionalIds.has(id));

    const projection = await forecast({
      days,
      buffer,
      window,
      discretionaryCentsPerMonth: discretionaryCents,
      excludeCommitmentIds: excluded,
    });
    const historicalDiscretionaryCents = costs.variable
      .filter((row) => row.tier === 'cut')
      .reduce((total, row) => total + row.per_month_cents, 0);
    const optionalCommitmentCents = optionalCommitments
      .reduce((total, row) => total + row.per_month_cents, 0);
    const includedCommitmentCents = optionalCommitments
      .filter((row) => !excluded.includes(String(row.commitment_id)))
      .reduce((total, row) => total + row.per_month_cents, 0);

    res.json({
      ...projection,
      luxury: {
        allowance_per_month: centsToNumeric(discretionaryCents),
        historical_variable_per_month: centsToNumeric(historicalDiscretionaryCents),
        optional_commitments_per_month: centsToNumeric(optionalCommitmentCents),
        included_commitments_per_month: centsToNumeric(includedCommitmentCents),
        active_commitments: optionalCommitments.map((row) => ({
          id: row.commitment_id,
          label: row.name,
          per_month: row.per_month,
          included: !excluded.includes(String(row.commitment_id)),
        })),
      },
    });
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
