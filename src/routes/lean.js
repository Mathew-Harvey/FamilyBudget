// The survival plan: what it would take to last, and what each step costs you.
import { Router } from 'express';
import { query } from '../db.js';
import { leanPlan, assetLevers, trimPercent } from '../lean.js';
import { DEFAULT_SPEND_WINDOW_DAYS } from '../forecast.js';

export const leanRouter = Router();

const windowFrom = (req) =>
  Math.min(Math.max(Number(req.query.window) || DEFAULT_SPEND_WINDOW_DAYS, 14), 400);

leanRouter.get('/', async (req, res, next) => {
  try {
    const window = windowFrom(req);
    res.json({
      plan: await leanPlan({ window }),
      levers: await assetLevers({ window }),
    });
  } catch (err) {
    next(err);
  }
});

// Moving a cost between keep, trim and cut. The plan is only as good as the
// tiering, and the tiering is a judgement, so it belongs to a person.
leanRouter.post('/tier', async (req, res, next) => {
  try {
    const { merchant_key: merchantKey, category_id: categoryId, tier } = req.body ?? {};
    if (!['keep', 'trim', 'cut', null].includes(tier ?? null)) {
      return res.status(400).json({ error: 'A tier is keep, trim or cut' });
    }
    if (merchantKey) {
      const { rowCount } = await query(
        'update merchants set lean_tier = $2, updated_at = now() where match_key = $1',
        [merchantKey, tier ?? null],
      );
      if (!rowCount) return res.status(404).json({ error: 'No such place' });
    } else if (categoryId) {
      const { rowCount } = await query(
        'update categories set lean_tier = $2 where id = $1',
        [categoryId, tier ?? null],
      );
      if (!rowCount) return res.status(404).json({ error: 'No such category' });
    } else {
      return res.status(400).json({ error: 'Give a place or a category to move' });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// How hard the trimming is assumed to be.
leanRouter.post('/trim-percent', async (req, res, next) => {
  try {
    const percent = Number(req.body?.percent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 90) {
      return res.status(400).json({ error: 'A percentage between 0 and 90' });
    }
    await query(
      `insert into settings (key, value) values ('lean_trim_percent', $1)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [String(Math.round(percent))],
    );
    res.json({ trim_percent: await trimPercent() });
  } catch (err) {
    next(err);
  }
});
