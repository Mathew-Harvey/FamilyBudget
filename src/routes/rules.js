// Rules: ordered, evaluated top to bottom, first match wins.
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { categoriseAll, previewRule } from '../categorise.js';

const MATCH_FIELDS = ['any', 'description', 'merchant_name', 'reference', 'extended_description'];
const MATCH_TYPES = ['contains', 'equals', 'starts_with', 'regex'];

export const rulesRouter = Router();

function validate(body) {
  if (body.match_field && !MATCH_FIELDS.includes(body.match_field)) {
    return `match_field must be one of ${MATCH_FIELDS.join(', ')}`;
  }
  if (body.match_type && !MATCH_TYPES.includes(body.match_type)) {
    return `match_type must be one of ${MATCH_TYPES.join(', ')}`;
  }
  if (body.direction && !['debit', 'credit'].includes(body.direction)) {
    return 'direction must be debit or credit';
  }
  // A broken pattern would silently never match, so refuse it at the door.
  if (body.match_type === 'regex' && body.match_value) {
    try {
      new RegExp(body.match_value);
    } catch (err) {
      return `That is not a valid pattern: ${err.message}`;
    }
  }
  const hasCondition =
    body.match_value || body.account_id || body.direction ||
    body.min_amount !== undefined || body.max_amount !== undefined;
  if (!hasCondition) return 'A rule needs at least one condition, otherwise it matches everything';

  const hasAction = body.category_id || body.rename_to || body.set_note || body.mark_ignore;
  if (!hasAction) return 'A rule needs at least one action';
  return null;
}

rulesRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(`
      select r.*, c.name as category_name, p.name as group_name,
             a.bank, a.masked_number,
             (select count(*) from transactions t where t.categorised_by_rule_id = r.id)::int as matched_count
        from rules r
        left join categories c on c.id = r.category_id
        left join categories p on p.id = c.parent_id
        left join accounts a on a.id = r.account_id
       order by r.position, r.created_at
    `);
    res.json({ rules: rows });
  } catch (err) {
    next(err);
  }
});

rulesRouter.post('/', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    if (!body.name || !String(body.name).trim()) return res.status(400).json({ error: 'A name is required' });
    const problem = validate(body);
    if (problem) return res.status(400).json({ error: problem });

    const next_position = await query('select coalesce(max(position), 0) + 10 as p from rules');
    const { rows } = await query(
      `insert into rules (position, name, enabled, match_field, match_type, match_value,
                          account_id, direction, min_amount, max_amount,
                          category_id, rename_to, set_note, mark_ignore)
       values ($1,$2,coalesce($3,true),coalesce($4,'any'),coalesce($5,'contains'),$6,
               $7,$8,$9,$10,$11,$12,$13,coalesce($14,false))
       returning *`,
      [
        next_position.rows[0].p,
        String(body.name).trim(),
        body.enabled ?? null,
        body.match_field ?? null,
        body.match_type ?? null,
        body.match_value ?? null,
        body.account_id ?? null,
        body.direction ?? null,
        body.min_amount ?? null,
        body.max_amount ?? null,
        body.category_id ?? null,
        body.rename_to ?? null,
        body.set_note ?? null,
        body.mark_ignore ?? null,
      ],
    );
    const changed = await categoriseAll();
    res.status(201).json({ rule: rows[0], recategorised: changed });
  } catch (err) {
    next(err);
  }
});

rulesRouter.post('/reorder', async (req, res, next) => {
  try {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids must be a non empty array' });
    await withTransaction(async (client) => {
      for (const [index, id] of ids.entries()) {
        await client.query('update rules set position = $2, updated_at = now() where id = $1', [id, (index + 1) * 10]);
      }
    });
    res.json({ ok: true, recategorised: await categoriseAll() });
  } catch (err) {
    next(err);
  }
});

rulesRouter.post('/preview', async (req, res, next) => {
  try {
    const problem = validate(req.body ?? {});
    if (problem) return res.status(400).json({ error: problem });
    res.json(await previewRule(req.body));
  } catch (err) {
    next(err);
  }
});

rulesRouter.post('/:id', async (req, res, next) => {
  try {
    const body = req.body ?? {};

    // Enabling or disabling is its own path. Sending it through the full update
    // below would null out every condition the rule already has.
    if (Object.keys(body).length === 1 && 'enabled' in body) {
      const { rows } = await query(
        'update rules set enabled = $2, updated_at = now() where id = $1 returning *',
        [req.params.id, Boolean(body.enabled)],
      );
      if (!rows.length) return res.status(404).json({ error: 'No such rule' });
      return res.json({ rule: rows[0], recategorised: await categoriseAll() });
    }

    const problem = validate(body);
    if (problem) return res.status(400).json({ error: problem });

    const { rows } = await query(
      `update rules set
         name        = coalesce($2, name),
         enabled     = coalesce($3, enabled),
         match_field = coalesce($4, match_field),
         match_type  = coalesce($5, match_type),
         match_value = $6,
         account_id  = $7,
         direction   = $8,
         min_amount  = $9,
         max_amount  = $10,
         category_id = $11,
         rename_to   = $12,
         set_note    = $13,
         mark_ignore = coalesce($14, mark_ignore),
         updated_at  = now()
       where id = $1
       returning *`,
      [
        req.params.id,
        body.name ?? null,
        body.enabled ?? null,
        body.match_field ?? null,
        body.match_type ?? null,
        body.match_value ?? null,
        body.account_id ?? null,
        body.direction ?? null,
        body.min_amount ?? null,
        body.max_amount ?? null,
        body.category_id ?? null,
        body.rename_to ?? null,
        body.set_note ?? null,
        body.mark_ignore ?? null,
      ],
    );
    if (!rows.length) return res.status(404).json({ error: 'No such rule' });
    res.json({ rule: rows[0], recategorised: await categoriseAll() });
  } catch (err) {
    next(err);
  }
});

rulesRouter.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await query('delete from rules where id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'No such rule' });
    res.json({ deleted: true, recategorised: await categoriseAll() });
  } catch (err) {
    next(err);
  }
});
