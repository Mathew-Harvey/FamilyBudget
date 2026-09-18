// Money is never a JavaScript number with a fractional part anywhere in this
// app. Redbark hands us integer minor units (cents), we keep integer cents in
// memory, and we convert to a decimal string only at the Postgres numeric
// boundary. No floating point arithmetic touches an amount.

const NUMERIC_PATTERN = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

// Largest value numeric(12,2) can hold, in cents: 9999999999.99
const MAX_CENTS = 999_999_999_999;

export function assertCents(cents, label = 'amount') {
  if (typeof cents !== 'number' || !Number.isInteger(cents)) {
    throw new TypeError(`${label} must be an integer number of cents, got ${JSON.stringify(cents)}`);
  }
  if (Math.abs(cents) > MAX_CENTS) {
    throw new RangeError(`${label} of ${cents} cents does not fit numeric(12,2)`);
  }
  return cents;
}

// 15970 -> "159.70", -676 -> "-6.76", 0 -> "0.00"
export function centsToNumeric(cents) {
  assertCents(cents);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const remainder = abs % 100;
  // abs - remainder is an exact multiple of 100, so this division is exact in
  // IEEE 754 for every value we allow. Never use abs / 100 directly.
  const whole = (abs - remainder) / 100;
  return `${negative ? '-' : ''}${whole}.${String(remainder).padStart(2, '0')}`;
}

// "159.70" -> 15970, "-6.76" -> -676, "12" -> 1200. Accepts what Postgres
// numeric sends back, which is always a string in this app (see src/db.js).
export function numericToCents(value) {
  if (typeof value === 'number') {
    // Guard against a float sneaking in from somewhere that skipped the parser.
    if (!Number.isInteger(value)) {
      throw new TypeError(`refusing to read ${value} as money: it is a float, not a numeric string`);
    }
    value = String(value);
  }
  if (typeof value !== 'string') {
    throw new TypeError(`expected a numeric string, got ${JSON.stringify(value)}`);
  }
  const match = NUMERIC_PATTERN.exec(value.trim());
  if (!match) {
    throw new TypeError(`not a 2dp decimal string: ${JSON.stringify(value)}`);
  }
  const [, sign, whole, fraction = ''] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  assertCents(cents);
  return sign ? -cents : cents;
}

// Redbark money object: { amount: -15970, currency: "aud" } -> -15970.
export function redbarkAmountToCents(money, label = 'amount') {
  if (!money || typeof money !== 'object') {
    throw new TypeError(`${label}: expected a Redbark money object, got ${JSON.stringify(money)}`);
  }
  return assertCents(money.amount, label);
}

// For display only: -15970 -> "-$159.70".
export function formatCents(cents) {
  assertCents(cents);
  const negative = cents < 0;
  return `${negative ? '-' : ''}$${centsToNumeric(Math.abs(cents))}`;
}

// Rates. A month is 30.44 days, the mean Gregorian month, and these are the
// only three conversions this app does between a rate and a period.
//
// They were written out by hand in a dozen places, as `* 30.44 / days` in some
// and `* 3044 / (days * 100)` in others, with a private MONTH_DAYS constant in
// two modules. The second form is the right one: it keeps the arithmetic in
// integers until the single division, where the first multiplies cents by a
// float. One definition, so a rate cannot mean two things depending on which
// file worked it out.
const MONTH_DAYS_HUNDREDTHS = 3044;

// An amount that left over some number of days, as a monthly rate.
export function centsPerMonth(cents, days) {
  if (!(days > 0)) throw new RangeError('a rate needs a positive number of days to divide by');
  return Math.round((cents * MONTH_DAYS_HUNDREDTHS) / (days * 100));
}

// A daily rate as a monthly one.
export function monthlyFromDaily(centsPerDay) {
  return Math.round((centsPerDay * MONTH_DAYS_HUNDREDTHS) / 100);
}

// A monthly rate as a daily one.
export function dailyFromMonthly(cents) {
  return Math.round((cents * 100) / MONTH_DAYS_HUNDREDTHS);
}

// One total split into parts that add up to it.
//
// A share of a figure is not a second measurement of it. Converting each part
// to a monthly rate on its own and heading the list with a separate conversion
// of the whole gives rows that visibly fail to add up to the number above them,
// by a cent a row, which is the same fault as a card headed 603.65 over four
// lines making 603.66. The weights say how the total divides; the total is the
// answer and it is never recomputed.
//
// The remainder goes to the largest fractions first, ties by position, so the
// same input always gives the same answer. BigInt for the one multiplication,
// because a total near the numeric(12,2) ceiling times a weight the same size
// is past what a double holds exactly and this has to be exact.
export function apportion(totalCents, weights) {
  assertCents(totalCents, 'total');
  // Refused rather than handled. Truncation runs the wrong way below zero, so a
  // negative total would quietly come back two cents short, and nothing in this
  // app divides a negative figure into shares of itself.
  if (totalCents < 0) throw new RangeError('a total split into shares cannot be negative');
  if (!Array.isArray(weights)) throw new TypeError('weights must be an array');
  for (const weight of weights) {
    if (!Number.isInteger(weight) || weight < 0) {
      throw new TypeError(`a weight must be a whole non negative number, got ${JSON.stringify(weight)}`);
    }
  }
  const sum = weights.reduce((total, weight) => total + weight, 0);
  if (sum === 0) return weights.map(() => 0);

  const total = BigInt(totalCents);
  const divisor = BigInt(sum);
  const parts = [];
  const remainders = [];
  for (let i = 0; i < weights.length; i++) {
    const product = total * BigInt(weights[i]);
    parts.push(Number(product / divisor));
    remainders.push([i, product % divisor]);
  }
  remainders.sort((a, b) => (a[1] === b[1] ? a[0] - b[0] : (b[1] > a[1] ? 1 : -1)));
  let left = totalCents - parts.reduce((running, part) => running + part, 0);
  for (let i = 0; left > 0 && i < remainders.length; i++, left--) {
    parts[remainders[i][0]]++;
  }
  return parts;
}
