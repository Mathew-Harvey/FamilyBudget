// Categories: the taxonomy, and the mapping from provider categories onto it.
import { Router } from 'express';
import { query } from '../db.js';
import { categoriseAll } from '../categorise.js';

const KINDS = ['income', 'expense', 'transfer', 'ignore'];

export const categoriesRouter = Router();

categoriesRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(`
      select c.id, c.parent_id, c.name, c.kind, c.colour, c.sort_order, c.archived,
             p.name as parent_name,
             (select count(*) from transactions t where t.category_id = c.id)::int as transaction_count
        from categories c
        left join categories p on p.id = c.parent_id
       order by coalesce(p.sort_order, c.sort_order), p.name nulls first, c.sort_order, c.name
    `);
    const groups = rows.filter((row) => row.parent_id === null);
    const categories = rows.filter((row) => row.parent_id !== null);
    res.json({
      groups: groups.map((group) => ({
        ...group,
        categories: categories.filter((c) => c.parent_id === group.id),
      })),
    });
  } catch (err) {
    next(err);
  }
});

categoriesRouter.post('/', async (req, res, next) => {
  try {
    const { parent_id: parentId, name, kind, colour, sort_order: sortOrder } = req.body ?? {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'A name is required' });
    if (kind && !KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });

    const { rows } = await query(
      `insert into categories (parent_id, name, kind, colour, sort_order)
       values ($1, $2, coalesce($3, 'expense'), $4, coalesce($5, 100))
       returning *`,
      [parentId ?? null, String(name).trim(), kind ?? null, colour ?? null, sortOrder ?? null],
    );
    res.status(201).json({ category: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A category with that name already exists here' });
    next(err);
  }
});

// What the banks call things, and where each one currently lands.
categoriesRouter.get('/provider-map', async (req, res, next) => {
  try {
    const { rows } = await query(`
      select m.provider_category, m.category_id, c.name as category_name, p.name as group_name,
             (select count(*) from transactions t where t.provider_category = m.provider_category)::int as transaction_count
        from provider_category_map m
        join categories c on c.id = m.category_id
        left join categories p on p.id = c.parent_id
       order by m.provider_category
    `);
    res.json({ mappings: rows });
  } catch (err) {
    next(err);
  }
});

categoriesRouter.post('/provider-map', async (req, res, next) => {
  try {
    const { provider_category: providerCategory, category_id: categoryId } = req.body ?? {};
    if (!providerCategory) return res.status(400).json({ error: 'provider_category is required' });

    if (!categoryId) {
      await query('delete from provider_category_map where provider_category = $1', [providerCategory]);
    } else {
      await query(
        `insert into provider_category_map (provider_category, category_id)
         values ($1, $2)
         on conflict (provider_category) do update set category_id = excluded.category_id`,
        [providerCategory, categoryId],
      );
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Re-runs rules and the provider mapping over everything not set by hand.
categoriesRouter.post('/recategorise', async (req, res, next) => {
  try {
    res.json({ changed: await categoriseAll() });
  } catch (err) {
    next(err);
  }
});

categoriesRouter.post('/:id', async (req, res, next) => {
  try {
    const { name, kind, colour, sort_order: sortOrder, archived, parent_id: parentId } = req.body ?? {};
    if (kind && !KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
    if (parentId && parentId === req.params.id) {
      return res.status(400).json({ error: 'A category cannot be its own group' });
    }

    const { rows } = await query(
      `update categories set
         name       = coalesce($2, name),
         kind       = coalesce($3, kind),
         colour     = coalesce($4, colour),
         sort_order = coalesce($5, sort_order),
         archived   = coalesce($6, archived),
         parent_id  = coalesce($7, parent_id),
         updated_at = now()
       where id = $1
       returning *`,
      [req.params.id, name ?? null, kind ?? null, colour ?? null, sortOrder ?? null, archived ?? null, parentId ?? null],
    );
    if (!rows.length) return res.status(404).json({ error: 'No such category' });
    res.json({ category: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A category with that name already exists here' });
    next(err);
  }
});

categoriesRouter.delete('/:id', async (req, res, next) => {
  try {
    const children = await query('select count(*)::int as n from categories where parent_id = $1', [req.params.id]);
    if (children.rows[0].n > 0 && req.query.cascade !== 'true') {
      return res.status(409).json({ error: 'That group still has categories in it. Move them first, or pass cascade=true.' });
    }
    const { rowCount } = await query('delete from categories where id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'No such category' });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

