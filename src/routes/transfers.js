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

// The same decision, taken once.
//
// A fortnightly transfer between the same two accounts for the same amount
// produces a pair every fortnight, and this page offered all 42 of them
// separately: 42 identical judgements, 42 requests, down a page eight thousand
// pixels long. Deciding a group is deciding the shape, which is what a person
// was actually doing each of those 42 times.
//
// Everything here was already paired by the detector, which only pairs
// automatically when a match beats every other candidate on both sides. This
// endorses that, it does not invent a pairing.
transfersRouter.post('/confirm-many', async (req, res, next) => {
  try {
    const pairs = Array.isArray(req.body?.pairs) ? req.body.pairs : null;
    if (!pairs?.length) return res.status(400).json({ error: 'Give a list of pairs' });
    if (pairs.length > 500) return res.status(400).json({ error: 'Too many at once' });
    if (pairs.some((pair) => !pair?.id || !pair?.pair_id)) {
      return res.status(400).json({ error: 'Every pair needs an id and a pair_id' });
    }
    await withTransaction(async (client) => {
      for (const pair of pairs) await linkPair(client, pair.id, pair.pair_id, 'confirmed');
    });
    res.json({ confirmed: pairs.length });
  } catch (err) {
    next(err);
  }
});

transfersRouter.post('/reject-many', async (req, res, next) => {
  try {
    const pairs = Array.isArray(req.body?.pairs) ? req.body.pairs : null;
    if (!pairs?.length) return res.status(400).json({ error: 'Give a list of pairs' });
    if (pairs.length > 500) return res.status(400).json({ error: 'Too many at once' });
    if (pairs.some((pair) => !pair?.id || !pair?.pair_id)) {
      return res.status(400).json({ error: 'Every pair needs an id and a pair_id' });
    }
    await withTransaction(async (client) => {
      for (const pair of pairs) await rejectPair(client, pair.id, pair.pair_id);
    });
    res.json({ rejected: pairs.length });
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
