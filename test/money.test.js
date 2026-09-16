// Money must be exact. No floating point arithmetic anywhere near an amount.
import test from 'node:test';
import assert from 'node:assert/strict';
import { centsToNumeric, numericToCents, redbarkAmountToCents, formatCents } from '../src/money.js';

test('cents convert to a 2dp decimal string', () => {
  assert.equal(centsToNumeric(0), '0.00');
  assert.equal(centsToNumeric(5), '0.05');
  assert.equal(centsToNumeric(-5), '-0.05');
  assert.equal(centsToNumeric(676), '6.76');
  assert.equal(centsToNumeric(-15970), '-159.70');
  assert.equal(centsToNumeric(180000), '1800.00');
  assert.equal(centsToNumeric(-60272035), '-602720.35');
});

test('round trip is exact across the whole numeric(12,2) range', () => {
  const values = [
    0, 1, -1, 5, -5, 99, -99, 100, -100, 676, -676, 15970, -15970, 180000,
    -60272035, 999_999_999_999, -999_999_999_999,
  ];
  for (const cents of values) {
    assert.equal(numericToCents(centsToNumeric(cents)), cents, `round trip failed for ${cents}`);
  }
});

test('every cent value in a wide sweep round trips', () => {
  // A brute force sweep catches the classic x/100 rounding bugs that spot
  // checks miss.
  for (let cents = -20_000; cents <= 20_000; cents++) {
    assert.equal(numericToCents(centsToNumeric(cents)), cents, `round trip failed for ${cents}`);
  }
});

test('numeric strings from Postgres parse to exact cents', () => {
  assert.equal(numericToCents('159.70'), 15970);
  assert.equal(numericToCents('-6.76'), -676);
  assert.equal(numericToCents('12'), 1200);
  assert.equal(numericToCents('0.05'), 5);
  assert.equal(numericToCents('-0.1'), -10);
  assert.equal(numericToCents(' 1800.00 '), 180000);
});

test('a float is refused rather than silently rounded', () => {
  assert.throws(() => centsToNumeric(1.5), TypeError);
  assert.throws(() => centsToNumeric(0.1 + 0.2), TypeError);
  assert.throws(() => numericToCents(159.7), TypeError);
  assert.throws(() => numericToCents('1.234'), TypeError);
  assert.throws(() => numericToCents('abc'), TypeError);
  assert.throws(() => numericToCents('1e5'), TypeError);
  assert.throws(() => numericToCents(''), TypeError);
});

test('an amount too large for numeric(12,2) is refused', () => {
  assert.throws(() => centsToNumeric(1_000_000_000_000), RangeError);
});

test('the classic float error does not occur through this path', () => {
  // 0.1 + 0.2 is 0.30000000000000004 in floating point. In cents it is exact.
  const total = 10 + 20;
  assert.equal(centsToNumeric(total), '0.30');
  // Summing many awkward amounts stays exact.
  const amounts = [-676, -15970, 180000, -27463, -18618, 99000, -310099];
  const sum = amounts.reduce((a, b) => a + b, 0);
  assert.equal(sum, -93826);
  assert.equal(centsToNumeric(sum), '-938.26');
});

test('Redbark money objects are read as integer cents', () => {
  assert.equal(redbarkAmountToCents({ amount: -15970, currency: 'aud' }), -15970);
  assert.equal(redbarkAmountToCents({ amount: 0, currency: 'aud' }), 0);
  assert.throws(() => redbarkAmountToCents({ amount: 1.5, currency: 'aud' }), TypeError);
  assert.throws(() => redbarkAmountToCents(null), TypeError);
});

test('display formatting keeps the sign outside the dollar sign', () => {
  assert.equal(formatCents(-15970), '-$159.70');
  assert.equal(formatCents(15970), '$159.70');
  assert.equal(formatCents(0), '$0.00');
});
