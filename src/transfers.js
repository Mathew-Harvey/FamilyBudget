// Transfer detection. Runs at the end of every sync over unpaired transactions.
//
// A pair is a transfer when all of these hold:
//   - the two rows are on different accounts that we own
//   - the amounts are equal in size and opposite in sign
//   - the dates are within 3 days of each other
//   - neither row is already paired
//   - the pair has not been rejected before
//
// Zero amount rows are excluded. Real data contains $0 card authorisations, and
// two of those on different accounts satisfy "equal and opposite" trivially,
// which would pair unrelated rows.
import { query, withTransaction } from './db.js';
import { daysBetween, normaliseDescription, toDateOnly } from './matching.js';

const MAX_DAYS_APART = 3;

const TRANSFER_WORDS = ['TRANSFER', 'LOAN', 'REPAYMENT', 'INTERNAL', 'PAYMENT'];
const TRANSFER_CATEGORIES = new Set(['TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS']);

// All the text a bank might put the counterpart's identity into.
function haystack(txn) {
  return normaliseDescription(
    [txn.description, txn.reference, txn.extended_description].filter(Boolean).join(' '),
  );
}

// Last four digits of a masked number like "xxxx4047".
function lastFour(maskedNumber) {
  const digits = String(maskedNumber || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

// Significant words from an account name, used as a weaker hint than the
// number. "ING Australia Savings Maximiser" gives SAVINGS, MAXIMISER.
function nameTokens(name) {
  return normaliseDescription(name)
    .split(' ')
    .filter((word) => word.length >= 5);
}

// Scores how much the text of the two rows says "these two belong together".
// Higher is stronger. This only breaks ties, it never pairs on its own.
export function hintScore(a, b, accountsById) {
  const accountA = accountsById.get(a.account_id);
  const accountB = accountsById.get(b.account_id);
  const textA = haystack(a);
  const textB = haystack(b);
  let score = 0;

  // Strongest signal by far. ING writes the other account's number into the
  // description of the receiving side, for example
  // "INTERNAL TRANSFER 923100 89634047" where 4047 is the source account.
  const fourA = lastFour(accountA?.masked_number);
  const fourB = lastFour(accountB?.masked_number);
  if (fourB && textA.includes(fourB)) score += 3;
  if (fourA && textB.includes(fourA)) score += 3;

  // The other account's name appearing in the text.
  for (const token of nameTokens(accountB?.name)) if (textA.includes(token)) score += 1;
  for (const token of nameTokens(accountA?.name)) if (textB.includes(token)) score += 1;

  // The bank's own view that this is a transfer or a loan payment.
  if (TRANSFER_CATEGORIES.has(a.provider_category)) score += 1;
  if (TRANSFER_CATEGORIES.has(b.provider_category)) score += 1;

  // Generic wording.
  for (const word of TRANSFER_WORDS) {
    if (textA.includes(word)) score += 1;
    if (textB.includes(word)) score += 1;
  }
  return score;
}

// Builds every legal candidate pair and scores it. Pure, so it is testable
// without a database.
export function buildCandidates(transactions, accountsById, rejectedPairKeys = new Set()) {
  const candidates = [];
  const byAmount = new Map();

  for (const txn of transactions) {
    const cents = txn.amount_cents;
    if (cents === 0) continue; // never pair a zero amount row
    if (!byAmount.has(cents)) byAmount.set(cents, []);
    byAmount.get(cents).push(txn);
  }

  for (const [cents, rows] of byAmount) {
    if (cents <= 0) continue; // walk positives and look up their negatives once
    const opposites = byAmount.get(-cents);
    if (!opposites) continue;

    for (const a of rows) {
      for (const b of opposites) {
        if (a.account_id === b.account_id) continue;
        const apart = daysBetween(a.txn_date, b.txn_date);
        if (apart > MAX_DAYS_APART) continue;
        if (rejectedPairKeys.has(pairKey(a.id, b.id))) continue;
        candidates.push({ a, b, daysApart: apart, hints: hintScore(a, b, accountsById) });
      }
    }
  }

  // Closest date wins first, then the strongest text hints.
  candidates.sort((x, y) => x.daysApart - y.daysApart || y.hints - x.hints);
  return candidates;
}

export function pairKey(idA, idB) {
  return idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
}

// Resolves candidates into pairs. A pair is only taken when it is strictly
// better than every other still available candidate on both of its sides.
// Anything that ties is left alone for a person to decide.
export function resolvePairs(candidates) {
  const taken = new Set();
  const pairs = [];
  const ambiguous = [];

  const forTxn = new Map();
  for (const candidate of candidates) {
    for (const side of [candidate.a, candidate.b]) {
      if (!forTxn.has(side.id)) forTxn.set(side.id, []);
      forTxn.get(side.id).push(candidate);
    }
  }

  const sameStrength = (x, y) => x.daysApart === y.daysApart && x.hints === y.hints;

  for (const candidate of candidates) {
    const { a, b } = candidate;
    if (taken.has(a.id) || taken.has(b.id)) continue;

    // Is there another equally good option still on the table for either side?
    const rivals = [];
    for (const side of [a, b]) {
      for (const other of forTxn.get(side.id) ?? []) {
        if (other === candidate) continue;
        if (taken.has(other.a.id) || taken.has(other.b.id)) continue;
        if (sameStrength(other, candidate)) rivals.push(other);
      }
    }

    if (rivals.length) {
      ambiguous.push({ candidate, rivals });
      continue;
    }

    taken.add(a.id);
    taken.add(b.id);
    pairs.push(candidate);
  }

  return { pairs, ambiguous };
}

// Loads what detection needs: unpaired non zero rows on accounts we own, plus
// the rejection list so a rejected pair is never offered again.
async function loadState(client, { sinceDays = 400 } = {}) {
  const accountsResult = await client.query(
    'select id, name, masked_number, bank, role, type from accounts',
  );
  const accountsById = new Map(accountsResult.rows.map((row) => [row.id, row]));

  const txnResult = await client.query(
    `select t.id, t.account_id, t.txn_date, t.description, t.reference,
            t.extended_description, t.provider_category,
            (t.amount * 100)::bigint as amount_cents
       from transactions t
      where t.transfer_pair_id is null
        and t.amount <> 0
        and t.txn_date >= current_date - $1::integer
      order by t.txn_date desc`,
    [sinceDays],
  );

  const rejected = await client.query('select txn_low_id, txn_high_id from transfer_rejections');
  const rejectedPairKeys = new Set(rejected.rows.map((r) => pairKey(r.txn_low_id, r.txn_high_id)));

  return {
    accountsById,
    transactions: txnResult.rows.map((row) => ({ ...row, txn_date: toDateOnly(row.txn_date) })),
    rejectedPairKeys,
  };
}

// Writes one confirmed or automatic pair. Both rows point at each other.
export async function linkPair(client, idA, idB, confidence = 'auto') {
  await client.query(
    `update transactions
        set is_transfer = true,
            transfer_pair_id = $2,
            transfer_confidence = $3,
            updated_at = now()
      where id = $1`,
    [idA, idB, confidence],
  );
  await client.query(
    `update transactions
        set is_transfer = true,
            transfer_pair_id = $1,
            transfer_confidence = $3,
            updated_at = now()
      where id = $2`,
    [idA, idB, confidence],
  );
}

export async function unlinkPair(client, idA, idB) {
  await client.query(
    `update transactions
        set is_transfer = false,
            transfer_pair_id = null,
            transfer_confidence = null,
            updated_at = now()
      where id = any($1::uuid[])`,
    [[idA, idB]],
  );
}

// Records that these two are not a transfer, so detection never offers the
// pair again. Each row stays free to pair with the right counterpart.
export async function rejectPair(client, idA, idB) {
  const [low, high] = idA < idB ? [idA, idB] : [idB, idA];
  await unlinkPair(client, idA, idB);
  await client.query(
    `insert into transfer_rejections (txn_low_id, txn_high_id)
     values ($1, $2)
     on conflict do nothing`,
    [low, high],
  );
}

// The main entry point, called at the end of every sync.
export async function detectTransfers(options = {}) {
  const run = async (client) => {
    const { accountsById, transactions, rejectedPairKeys } = await loadState(client, options);
    const candidates = buildCandidates(transactions, accountsById, rejectedPairKeys);
    const { pairs } = resolvePairs(candidates);

    for (const pair of pairs) {
      await linkPair(client, pair.a.id, pair.b.id, 'auto');
    }
    return pairs.length;
  };

  if (options.client) return run(options.client);
  return withTransaction(run, options.pool);
}

// Read only view for the review UI: which unpaired rows have candidates, and
// what those candidates are.
export async function listCandidates(options = {}) {
  const client = options.client ?? { query: (text, params) => query(text, params) };
  const { accountsById, transactions, rejectedPairKeys } = await loadState(client, options);
  const candidates = buildCandidates(transactions, accountsById, rejectedPairKeys);
  const { ambiguous } = resolvePairs(candidates);

  // Group by the pair so the UI can render one row per possible link.
  const seen = new Set();
  const out = [];
  for (const entry of [...ambiguous.map((x) => x.candidate), ...ambiguous.flatMap((x) => x.rivals)]) {
    const key = pairKey(entry.a.id, entry.b.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      a: { ...entry.a, account: accountsById.get(entry.a.account_id) },
      b: { ...entry.b, account: accountsById.get(entry.b.account_id) },
      days_apart: entry.daysApart,
      hints: entry.hints,
    });
  }
  return out;
}
