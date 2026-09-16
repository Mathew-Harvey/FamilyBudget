// Analysis by Claude, manual accounts, and turning a plan into a commitment.
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import {
  analyse,
  afford,
  suggestTrims,
  trimmableSpend,
  planExpense,
  acceptProposal,
  buildSnapshot,
  getAnalystSettings,
  updateAnalystSettings,
  anthropicConfig,
} from '../analyst.js';

export const analystRouter = Router();

analystRouter.get('/', async (req, res, next) => {
  try {
    const config = anthropicConfig();
    const { rows } = await query(
      `select id, kind, question, result, model, input_tokens, output_tokens, created_at
         from analyses order by created_at desc limit 20`,
    );
    res.json({
      settings: await getAnalystSettings(),
      // The key itself never leaves the server.
      claude: { configured: config.configured, model: config.model },
      analyses: rows,
    });
  } catch (err) {
    next(err);
  }
});

analystRouter.post('/settings', async (req, res, next) => {
  try {
    res.json({ settings: await updateAnalystSettings(req.body ?? {}) });
  } catch (err) {
    next(err);
  }
});

// Exactly what would be sent, so it can be read before anything is sent.
analystRouter.get('/snapshot', async (req, res, next) => {
  try {
    res.json({ snapshot: await buildSnapshot() });
  } catch (err) {
    next(err);
  }
});

analystRouter.post('/analyse', async (req, res, next) => {
  try {
    const question = req.body?.question ? String(req.body.question).slice(0, 2000) : null;
    res.json({ analysis: await analyse({ question }) });
  } catch (err) {
    next(err);
  }
});

// "Can we afford a 5000 push bike without going broke."
analystRouter.post('/afford', async (req, res, next) => {
  try {
    const { amount, description, when } = req.body ?? {};
    if (!amount || Number.isNaN(Number(amount))) return res.status(400).json({ error: 'An amount is required' });
    res.json({ analysis: await afford({ amount, description: description ? String(description).slice(0, 500) : null, when: when || null }) });
  } catch (err) {
    next(err);
  }
});

analystRouter.post('/trim', async (req, res, next) => {
  try {
    res.json({ analysis: await suggestTrims() });
  } catch (err) {
    next(err);
  }
});

// The raw ranking, so the page can show where the money goes without spending
// anything on a model call.
analystRouter.get('/trimmable', async (req, res, next) => {
  try {
    res.json(await trimmableSpend());
  } catch (err) {
    next(err);
  }
});

// --- assets and expected income ------------------------------------------

analystRouter.get('/levers', async (req, res, next) => {
  try {
    const assets = await query('select * from assets order by sold_on nulls first, estimated_value desc');
    const income = await query('select * from expected_income order by active desc, starts_on nulls last');
    res.json({ assets: assets.rows, expected_income: income.rows });
  } catch (err) {
    next(err);
  }
});

analystRouter.post('/assets', async (req, res, next) => {
  try {
    const { name, estimated_value: value, notes, sellable } = req.body ?? {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'A name is required' });
    if (!Number(value)) return res.status(400).json({ error: 'An estimated value is required' });
    const { rows } = await query(
      `insert into assets (name, estimated_value, notes, sellable)
       values ($1, $2, $3, coalesce($4, true)) returning *`,
      [String(name).trim(), Math.abs(Number(value)).toFixed(2), notes ?? null, sellable ?? null],
    );
    res.status(201).json({ asset: rows[0] });
  } catch (err) {
    next(err);
  }
});

analystRouter.post('/assets/:id', async (req, res, next) => {
  try {
    const { estimated_value: value, sellable, sold_on: soldOn, name } = req.body ?? {};
    const { rows } = await query(
      `update assets set
         name            = coalesce($2, name),
         estimated_value = coalesce($3, estimated_value),
         sellable        = coalesce($4, sellable),
         sold_on         = coalesce($5, sold_on),
         updated_at      = now()
       where id = $1 returning *`,
      [req.params.id, name ?? null, value === undefined || value === null ? null : Math.abs(Number(value)).toFixed(2), sellable ?? null, soldOn ?? null],
    );
    if (!rows.length) return res.status(404).json({ error: 'No such asset' });
    res.json({ asset: rows[0] });
  } catch (err) {
    next(err);
  }
});

analystRouter.delete('/assets/:id', async (req, res, next) => {
  try {
    const { rowCount } = await query('delete from assets where id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'No such asset' });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

analystRouter.post('/expected-income', async (req, res, next) => {
  try {
    const { label, amount, cadence_days: cadence, starts_on: startsOn, confidence, notes } = req.body ?? {};
    if (!label || !String(label).trim()) return res.status(400).json({ error: 'A label is required' });
    if (!Number(amount)) return res.status(400).json({ error: 'An amount is required' });
    if (!Number(cadence)) return res.status(400).json({ error: 'How often it arrives, in days, is required' });
    const { rows } = await query(
      `insert into expected_income (label, amount, cadence_days, starts_on, confidence, notes)
       values ($1,$2,$3,$4,coalesce($5,'likely'),$6) returning *`,
      [String(label).trim(), Math.abs(Number(amount)).toFixed(2), Math.round(Number(cadence)), startsOn || null, confidence ?? null, notes ?? null],
    );
    res.status(201).json({ income: rows[0] });
  } catch (err) {
    next(err);
  }
});

analystRouter.post('/expected-income/:id', async (req, res, next) => {
  try {
    const { active, amount, starts_on: startsOn, confidence } = req.body ?? {};
    const { rows } = await query(
      `update expected_income set
         active     = coalesce($2, active),
         amount     = coalesce($3, amount),
         starts_on  = coalesce($4, starts_on),
         confidence = coalesce($5, confidence),
         updated_at = now()
       where id = $1 returning *`,
      [req.params.id, active ?? null, amount === undefined || amount === null ? null : Math.abs(Number(amount)).toFixed(2), startsOn ?? null, confidence ?? null],
    );
    if (!rows.length) return res.status(404).json({ error: 'No such expected income' });
    res.json({ income: rows[0] });
  } catch (err) {
    next(err);
  }
});

analystRouter.delete('/expected-income/:id', async (req, res, next) => {
  try {
    const { rowCount } = await query('delete from expected_income where id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'No such expected income' });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

analystRouter.post('/plan-expense', async (req, res, next) => {
  try {
    const description = String(req.body?.description ?? '').trim();
    if (!description) return res.status(400).json({ error: 'Describe what is coming up' });
    res.json({ analysis: await planExpense(description.slice(0, 2000)) });
  } catch (err) {
    next(err);
  }
});

analystRouter.post('/accept-proposal', async (req, res, next) => {
  try {
    const proposal = req.body?.proposal;
    if (!proposal?.label) return res.status(400).json({ error: 'A proposal with a label is required' });
    const commitment = await withTransaction((client) => acceptProposal(proposal, client));
    res.status(201).json({ commitment });
  } catch (err) {
    next(err);
  }
});

// --- manual accounts -----------------------------------------------------
// A credit card or personal loan open banking cannot see is still part of the
// picture, so it can be entered and its balance kept up to date by hand.

analystRouter.post('/manual-accounts', async (req, res, next) => {
  try {
    const { bank, name, type, role, is_liquid: isLiquid, balance, notes } = req.body ?? {};
    if (!bank || !name) return res.status(400).json({ error: 'A bank and a name are required' });

    const account = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into accounts (source, bank, name, type, role, is_liquid, notes)
         values ('manual', $1, $2, $3, $4, coalesce($5, false), $6)
         returning *`,
        [String(bank).trim(), String(name).trim(), type ?? 'credit_card', role ?? null, isLiquid ?? null, notes ?? null],
      );
      const created = rows[0];

      if (balance !== undefined && balance !== null && balance !== '') {
        // A debt is money owed, so it is stored negative like every other
        // amount that is not ours.
        const owed = -Math.abs(Number(balance));
        await client.query(
          `insert into balances (account_id, balance_date, balance)
           values ($1, current_date, $2)
           on conflict (account_id, balance_date) do update set balance = excluded.balance`,
          [created.id, owed.toFixed(2)],
        );
        await client.query("update accounts set balance_updated_by = 'hand' where id = $1", [created.id]);
      }
      return created;
    });
    res.status(201).json({ account });
  } catch (err) {
    next(err);
  }
});

analystRouter.post('/manual-accounts/:id/balance', async (req, res, next) => {
  try {
    const { balance } = req.body ?? {};
    if (balance === undefined || balance === null || Number.isNaN(Number(balance))) {
      return res.status(400).json({ error: 'A balance is required' });
    }
    const { rows } = await query("select id, source, type from accounts where id = $1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'No such account' });
    if (rows[0].source !== 'manual') {
      return res.status(400).json({ error: 'That account is synced from the bank, so its balance is not set by hand' });
    }

    // Debt accounts are stored negative. Anything else is taken as given.
    const isDebt = ['credit_card', 'loan', 'personal_loan', 'mortgage'].includes(rows[0].type);
    const value = isDebt ? -Math.abs(Number(balance)) : Number(balance);

    await query(
      `insert into balances (account_id, balance_date, balance)
       values ($1, current_date, $2)
       on conflict (account_id, balance_date) do update set balance = excluded.balance, captured_at = now()`,
      [req.params.id, value.toFixed(2)],
    );
    await query("update accounts set balance_updated_by = 'hand', updated_at = now() where id = $1", [req.params.id]);
    res.json({ ok: true, balance: value.toFixed(2) });
  } catch (err) {
    next(err);
  }
});

analystRouter.delete('/manual-accounts/:id', async (req, res, next) => {
  try {
    const { rowCount } = await query("delete from accounts where id = $1 and source = 'manual'", [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'No such manual account' });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});
