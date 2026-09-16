// Transfer review: what was paired automatically, what needs a decision, and
// the actions to confirm, reject or link by hand.
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { listCandidates, linkPair, rejectPair } from '../transfers.js';

export const transfersRouter = Router();

// Auto paired transfers awaiting confirmation, one row per pair.
transfersRouter.get('/pairs', async (req, res, next) => {
  try {
    const confidence = req.query.confidence || 'auto';
    const { rows } = await query(
      `select t.id, t.txn_date, t.amount, t.description, t.transfer_confidence,
              a.bank, a.name as account_name, a.masked_number,
              p.id as pair_id, p.txn_date as pair_date, p.amount as pair_amount,
              p.description as pair_description,
              pa.bank as pair_bank, pa.name as pair_account_name,
              pa.masked_number as pair_masked_number
         from transactions t
         join accounts a on a.id = t.account_id
         join transactions p on p.id = t.transfer_pair_id
         join accounts pa on pa.id = p.account_id
        where t.is_transfer
          and t.transfer_confidence = $1
          -- one row per pair, not two
          and t.id < p.id
        order by t.txn_date desc
        limit 200`,
      [confidence],
    );
    res.json({ pairs: rows });
  } catch (err) {
    next(err);
  }
});

// Candidates that were too close to call automatically.
transfersRouter.get('/candidates', async (req, res, next) => {
  try {
    res.json({ candidates: await listCandidates() });
  } catch (err) {
    next(err);
  }
});

transfersRouter.post('/confirm', async (req, res, next) => {
  try {
    const { id, pair_id: pairId } = req.body ?? {};
    if (!id || !pairId) return res.status(400).json({ error: 'id and pair_id are required' });
    await withTransaction((client) => linkPair(client, id, pairId, 'confirmed'));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Rejection is recorded against the pair, so these two are never offered to
// each other again while each stays free to pair with the right counterpart.
transfersRouter.post('/reject', async (req, res, next) => {
  try {
    const { id, pair_id: pairId } = req.body ?? {};
    if (!id || !pairId) return res.status(400).json({ error: 'id and pair_id are required' });
    await withTransaction((client) => rejectPair(client, id, pairId));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

transfersRouter.post('/link', async (req, res, next) => {
  try {
    const { id, pair_id: pairId } = req.body ?? {};
    if (!id || !pairId) return res.status(400).json({ error: 'id and pair_id are required' });
    if (id === pairId) return res.status(400).json({ error: 'a transaction cannot pair with itself' });

    const { rows } = await query(
      'select id, account_id, amount, transfer_pair_id from transactions where id = any($1::uuid[])',
      [[id, pairId]],
    );
    if (rows.length !== 2) return res.status(404).json({ error: 'One or both transactions were not found' });
    if (rows[0].account_id === rows[1].account_id) {
      return res.status(400).json({ error: 'A transfer must be between two different accounts' });
    }
    if (rows.some((row) => row.transfer_pair_id)) {
      return res.status(409).json({ error: 'One of these is already part of a transfer' });
    }
    await withTransaction((client) => linkPair(client, id, pairId, 'confirmed'));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
