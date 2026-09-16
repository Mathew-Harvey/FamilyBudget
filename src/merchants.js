// Turning what the bank wrote into something a person recognises.
//
// A card statement is full of noise: payment processor prefixes, store numbers,
// terminal ids, and descriptions truncated part way through a word. The same
// cafe can appear as "SQ *THE LITTLE BAKERY", "The Little Bakery" and
// "The Little Baker" depending on how it was paid for and how much room the
// bank had.
//
// This reduces a description to a stable key. The key is stored on the
// transaction at write time, never recomputed in SQL: there is one definition
// of it, in JavaScript, for the same reason matchKeyFor has one definition.
// Two keys that are really the same place are merged by giving them the same
// display name in the merchants table, which needs no extra machinery.

// Payment processors that put themselves in front of the real merchant. Each
// must be anchored and must require a separator, or SP would eat SPOTLIGHT.
const PROCESSOR_PREFIXES = [
  /^PAYPAL\s*\*+\s*/i,
  /^SQ\s*\*+\s*/i,
  /^SP[\s*]+/i,
  /^EZI\*|^EZY\s*\*+\s*/i,
  /^ZIP\s*\*+\s*/i,
  /^STRIPE\s*\*+\s*/i,
  /^HUMM\s*\*+\s*/i,
  /^VISA\s+PURCHASE\s+/i,
  /^EFTPOS\s+(PURCHASE\s+)?/i,
  /^OSKO\s+(PAYMENT\s+|WITHDRAWAL\s+)?/i,
  /^BPAY\s+/i,
  /^CARD\s+PURCHASE\s+/i,
  // "DIRECT DEBIT 000650 PAYEE": the number is the biller code, not the payee.
  /^DIRECT\s+DEBIT\s+\d+\s*/i,
  /^PAY\s+ANYONE\s*(-\s*)?(EXTERNAL\s+PARTY\s*)?/i,
];

// Trailing noise: store numbers, terminal ids, the state, the suburb repeated.
const TRAILING_NOISE = [
  /\s+AU$/i,
  /\s+AUS$/i,
  /\s+(WA|NSW|VIC|QLD|SA|NT|ACT|TAS)$/i,
  /\s+PTY\s*(LTD)?$/i,
  /\s+LIMITED$/i,
  /\s+LTD$/i,
  /\s+PL$/i,
];

// Some merchants sign their own name with a suffix that varies per charge.
// "AMAZON RETA* AMAZON AU" and "AMAZON MARKETPLACE AU" are both Amazon.
const FAMILIES = [
  // "PAYPAL *MERCHANT" has already had its prefix stripped by the time we get
  // here, so a PAYPAL still standing at the front is PayPal itself billing us.
  [/^PAYPAL\b/i, 'PAYPAL'],
  // Not anchored: the biller sits in front of the insurer on a direct debit,
  // as "PREMCBA YOUI". Six policies, one company, and the household wants to
  // see what insurance costs rather than six unremarkable lines.
  [/\bYOUI\b/i, 'YOUI'],
  [/^AMAZON\b/i, 'AMAZON'],
  [/^AMZN\b/i, 'AMAZON'],
  [/^GOOGLE\b/i, 'GOOGLE'],
  [/^APPLE\b/i, 'APPLE'],
  [/^BP\b/i, 'BP'],
  [/^AMPOL\b/i, 'AMPOL'],
  [/^COLES\s+EXPRESS/i, 'COLES EXPRESS'],
  [/^COLES\b/i, 'COLES'],
  [/^WOOLWORTHS\b/i, 'WOOLWORTHS'],
  [/^ALDI\b/i, 'ALDI'],
  [/^BUNNINGS\b/i, 'BUNNINGS'],
  [/^KMART\b/i, 'KMART'],
  [/^PETBARN\b/i, 'PETBARN'],
  [/^ANTHROPIC\b/i, 'ANTHROPIC'],
  [/^CLAUDE\b/i, 'ANTHROPIC'],
  [/^OPENAI\b/i, 'OPENAI'],
  [/^CURSOR\b/i, 'CURSOR'],
  [/^NETFLIX\b/i, 'NETFLIX'],
  [/^SYNERGY\b/i, 'SYNERGY'],
  [/^WATER\s+CORPORATION/i, 'WATER CORPORATION'],
  [/^TELSTRA\b/i, 'TELSTRA'],
  [/^AUSSIE\s+BROADBAND/i, 'AUSSIE BROADBAND'],
  [/^ZIPMONEY\b|^ZIP\s+MONEY\b/i, 'ZIPMONEY'],
  [/^VIRGIN\s+MONEY/i, 'VIRGIN MONEY'],
  [/^SMARTRIDER\b|^PTA\s+SMARTRIDER/i, 'SMARTRIDER'],
];

// When the bank gave nothing at all, say so rather than inventing a merchant.
export const UNKNOWN_KEY = 'UNKNOWN';

export function merchantKeyFor(description, merchantName = null) {
  // Redbark's own merchant name is cleaner than the description when it exists,
  // so prefer it, but it is padded and sometimes empty.
  const source = (merchantName && merchantName.trim()) || description || '';
  let text = String(source).toUpperCase();

  if (/DESCRIPTION NOT CURRENTLY AVAILABLE/.test(text) || !text.trim()) return UNKNOWN_KEY;

  // Strip processor prefixes, repeatedly: "PAYPAL *SQ *THING" happens.
  for (let pass = 0; pass < 3; pass++) {
    const before = text;
    for (const prefix of PROCESSOR_PREFIXES) text = text.replace(prefix, '');
    if (text === before) break;
  }

  // Punctuation to spaces, so "CO.,LTD" and "CO LTD" agree.
  text = text.replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Reference numbers are not identities.
  //
  // Banks staple a policy, invoice or customer number onto the payee, and it is
  // different on every account and sometimes on every charge. Keeping it split
  // one insurer into six merchants, each too small to notice, when together they
  // were 673 dollars a month. PayPal direct debits were worse: the reference was
  // the ONLY thing left after the prefixes came off, so every charge became its
  // own merchant and 344 of 543 merchant keys had been seen exactly once.
  //
  // A token is a reference if it carries five or more digits, which spares real
  // names that happen to contain a number: 7ELEVEN, BP1, CAFE63.
  text = text
    .split(' ')
    .filter((word) => (word.match(/[0-9]/g) ?? []).length < 5)
    .join(' ')
    .trim();

  // A merchant family wins outright: every Amazon is Amazon.
  for (const [pattern, name] of FAMILIES) {
    if (pattern.test(text)) return name;
  }

  for (const noise of TRAILING_NOISE) text = text.replace(noise, '');

  // Trailing store and terminal numbers. Kept when the whole thing is numeric,
  // which would otherwise leave nothing.
  const withoutNumbers = text.replace(/\s+\d[\d\s]*$/, '').trim();
  if (withoutNumbers) text = withoutNumbers;

  // Long descriptions carry a reference after the name. Four words is enough to
  // identify a merchant and short enough to survive truncation.
  const words = text.split(' ').filter(Boolean).slice(0, 4);
  const key = words.join(' ').trim();

  // A key made only of digits is a BSB or an account number, never a payee.
  // "PAY ANYONE EXTERNAL PARTY 016742 496129173" left 016742 behind and a five
  // thousand dollar payment to a person was filed under a bank branch code.
  // The bank did not say who it went to, so neither do we.
  if (!key || /^[0-9 ]+$/.test(key)) return UNKNOWN_KEY;
  return key;
}

// A readable default, used until someone gives it a better name.
export function titleCase(key) {
  if (key === UNKNOWN_KEY) return 'Not described by the bank';
  return key
    .toLowerCase()
    .split(' ')
    .map((word) => (word.length <= 2 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
    .join(' ');
}

// Fills in merchant_key wherever it is missing, in batches. Called after a sync
// and by the backfill script.
export async function backfillMerchantKeys(client, { batchSize = 2000 } = {}) {
  let updated = 0;
  for (;;) {
    const { rows } = await client.query(
      `select id, description, merchant_name from transactions
        where merchant_key is null limit $1`,
      [batchSize],
    );
    if (!rows.length) break;

    for (const row of rows) {
      await client.query('update transactions set merchant_key = $2 where id = $1', [
        row.id,
        merchantKeyFor(row.description, row.merchant_name),
      ]);
      updated++;
    }
    if (rows.length < batchSize) break;
  }
  return updated;
}

// Makes sure every key seen has a merchants row, so names and explanations have
// somewhere to live. Existing rows are never overwritten: a name someone chose,
// or one Claude worked out, outranks the generated default.
export async function ensureMerchantRows(client) {
  const { rowCount } = await client.query(
    `insert into merchants (match_key, display_name, source)
     select distinct t.merchant_key, t.merchant_key, 'auto'
       from transactions t
      where t.merchant_key is not null
     on conflict (match_key) do nothing`,
  );

  // The generated default is only applied to rows that still carry the raw key
  // as their name, so a chosen name is never clobbered.
  const { rows } = await client.query(
    `select match_key, display_name from merchants where source = 'auto' and display_name = match_key`,
  );
  for (const row of rows) {
    const pretty = titleCase(row.match_key);
    if (pretty !== row.display_name) {
      await client.query('update merchants set display_name = $2, updated_at = now() where match_key = $1', [
        row.match_key,
        pretty,
      ]);
    }
  }
  return rowCount;
}
