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
import { numericToCents } from './money.js';

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
//
// Every unpaired row, however old, unless a caller narrows it. This used to be
// a rolling 400 days, which left the first run permanently half explained: the
// backfill reaches about 7 years, so no transfer older than the window was ever
// offered a counterpart. One side of each of those was still kept out of the
// budget by resolveInternalDestinations, which reads the destination out of the
// description and has no date limit, while the other side counted as income.
// The Transfers page could not rescue it either, because listCandidates loads
// through here too, so the pairs a person needed to confirm were never shown.
// There is no window to tune: only unpaired rows are read, and whether two rows
// are equal, opposite and three days apart does not depend on their age.
async function loadState(client, { sinceDays = null } = {}) {
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
        -- A row that is already half of a refund pair is spoken for, and the
        -- guard has to run in both directions: resolveReversals refuses rows
        -- that are transfers, so detection has to refuse rows that are refunds.
        -- Without this it only looked symmetric because a sync pairs transfers
        -- before refunds, which holds on the first run and never again: every
        -- later run sees the refund pairs written by the one before. A 24 cent
        -- international transaction fee, already cancelled by its own refund,
        -- was taken as a transfer against an unrelated 24 cent credit on
        -- another account, two days apart and with nothing to outrank it.
        and t.reversal_of_id is null
        and not exists (select 1 from transactions r where r.reversal_of_id = t.id)
        and ($1::integer is null or t.txn_date >= current_date - $1::integer)
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

// Money moved between two accounts we own, proved from the description rather
// than from a matching counterpart row.
//
// Pairing needs both sides present. That fails often enough to matter: the
// other side may not have synced yet, or the destination may not be connected
// to Redbark at all. When it fails, budget_flows sees an ordinary payment
// leaving a spendable account and counts it as spending, which it is not. On
// this household that was about 710 dollars a month of money that had simply
// moved to the next account along.
//
// ING writes the destination account number into the description, so the
// destination can be read directly. Only a number belonging to an account we
// own is accepted, and the row's own account is excluded: a description
// quoting the account it is already on tells us nothing about where it went.
// Everything else is left alone and still counts, which is the safe direction
// to be wrong in.
export function internalDestinationFor(description, accounts, sourceAccountId) {
  const digits = String(description || '').replace(/\D/g, '');
  if (digits.length < 4) return null;

  for (const account of accounts) {
    if (account.id === sourceAccountId) continue;
    const four = lastFour(account.masked_number);
    if (four && digits.includes(four)) return account.id;
  }
  return null;
}

// Only descriptions that say they are a transfer are considered. A merchant
// whose name happens to contain four digits matching an account is not one.
const INTERNAL_WORDS = /INTERNAL TRANSFER|TRANSFER TO LINKED|TRANSFER FROM LINKED/i;

export async function resolveInternalDestinations(options = {}) {
  const run = async (client) => {
    const { rows: accounts } = await client.query(
      'select id, masked_number from accounts where masked_number is not null',
    );
    if (!accounts.length) return 0;

    const { rows } = await client.query(
      `select id, account_id, description from transactions
        where internal_to_account_id is null
          and transfer_pair_id is null
          and description ~* 'INTERNAL TRANSFER|TRANSFER TO LINKED|TRANSFER FROM LINKED'`,
    );

    let resolved = 0;
    for (const row of rows) {
      if (!INTERNAL_WORDS.test(row.description || '')) continue;
      const destination = internalDestinationFor(row.description, accounts, row.account_id);
      if (!destination) continue;
      await client.query('update transactions set internal_to_account_id = $2, updated_at = now() where id = $1', [
        row.id,
        destination,
      ]);
      resolved++;
    }
    return resolved;
  };

  if (options.client) return run(options.client);
  return withTransaction(run, options.pool);
}

// A credit that cancels an earlier charge at the same merchant.
//
// Pairing is strict and one to one, for the same reason transfer pairing is:
// getting this wrong hides real spending, which is worse than leaving a credit
// unexplained. Same merchant, same amount to the cent, the credit on or after
// the charge and within the window, and each row consumed once. Charges are
// taken oldest first so a merchant that bills and refunds repeatedly pairs in
// the order it happened.
//
// A credit with no charge to cancel is left alone. It could be a rebate, a
// cashback or money from a person, and guessing is worse than not knowing.
const REVERSAL_WINDOW_DAYS = 30;
const DAY = 86_400_000;
const atMidnight = (value) => Date.parse(`${String(value).slice(0, 10)}T00:00:00Z`);

export async function resolveReversals(options = {}) {
  const run = async (client) => {
    const { rows } = await client.query(
      `select t.id, t.merchant_key, t.amount, t.txn_date, t.reversal_of_id
         from transactions t
         join accounts a on a.id = t.account_id
        where a.is_liquid
          and t.merchant_key is not null
          and t.merchant_key <> 'UNKNOWN'
          and not t.is_transfer
        -- Charges before credits within a day. A refund is very often posted on
        -- the same date as the charge it cancels, and ordering by id there is
        -- ordering by a random uuid: the credit arrives before there is anything
        -- waiting for it and the pair is missed. Amount ascending puts the
        -- negatives first.
        order by t.txn_date, t.amount, t.id`,
    );

    const { rows: existing } = await client.query(
      'select reversal_of_id from transactions where reversal_of_id is not null',
    );
    const alreadyCancelled = new Set(existing.map((row) => row.reversal_of_id));

    // Charges waiting to be cancelled, keyed by merchant and exact amount.
    const waiting = new Map();
    const keyFor = (merchant, cents) => `${merchant} :: ${cents}`;
    const pairs = [];

    for (const row of rows) {
      // numericToCents, not Math.round(Number(x) * 100): that is float
      // arithmetic on an amount, which is the thing money.js exists to
      // prevent, and it silently rounds a value that should have been refused.
      const cents = numericToCents(row.amount);
      if (cents < 0) {
        if (alreadyCancelled.has(row.id)) continue;
        const key = keyFor(row.merchant_key, -cents);
        if (!waiting.has(key)) waiting.set(key, []);
        waiting.get(key).push(row);
        continue;
      }
      if (cents === 0) continue;
      // Already paired on an earlier run. Without this the credit is matched
      // again, to a different charge, and every run silently reshuffles which
      // charges are considered refunded.
      if (row.reversal_of_id) continue;

      const queue = waiting.get(keyFor(row.merchant_key, cents));
      if (!queue?.length) continue;

      const index = queue.findIndex((charge) => {
        const gap = (atMidnight(row.txn_date) - atMidnight(charge.txn_date)) / DAY;
        return gap >= 0 && gap <= REVERSAL_WINDOW_DAYS;
      });
      if (index === -1) continue;

      const [charge] = queue.splice(index, 1);
      pairs.push({ creditId: row.id, chargeId: charge.id });
    }

    for (const pair of pairs) {
      await client.query(
        'update transactions set reversal_of_id = $2, updated_at = now() where id = $1',
        [pair.creditId, pair.chargeId],
      );
    }
    return pairs.length;
  };

  if (options.client) return run(options.client);
  return withTransaction(run, options.pool);
}
