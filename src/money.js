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
