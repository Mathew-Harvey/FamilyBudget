// Money must be exact. No floating point arithmetic anywhere near an amount.
import test from 'node:test';
import assert from 'node:assert/strict';
import { centsToNumeric, numericToCents, redbarkAmountToCents, formatCents, apportion } from '../src/money.js';

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

test('a total split into shares always adds back up to the total', () => {
  // The whole point. Converting each part on its own and heading the list with
  // a separate conversion of the whole is what leaves a card saying 603.65 over
  // four rows making 603.66.
  const cases = [
    [248210, [1234567, 98765, 4321, 77, 0, 3]],
    [100000, [1, 1, 1]],
    [1, [1, 1, 1, 1, 1]],
    [7, [3, 3, 1]],
    [349020, [40, 40, 40, 40, 40, 40, 40]],
    [999_999_999_999, [999_999_999_999, 1]],
  ];
  for (const [total, weights] of cases) {
    const parts = apportion(total, weights);
    assert.equal(parts.length, weights.length);
    assert.equal(parts.reduce((a, b) => a + b, 0), total, `lost a cent splitting ${total}`);
    assert.ok(parts.every((part) => Number.isInteger(part) && part >= 0));
  }
});

test('shares stay exact across many awkward splits', () => {
  for (let n = 1; n <= 150; n++) {
    // Weights that share no common factor with the total, which is where
    // rounding each part on its own goes wrong.
    const weights = Array.from({ length: n }, (_, i) => (i * 7919) % 1013);
    const total = 100_000 + n;
    const parts = apportion(total, weights);
    const expected = weights.some(Boolean) ? total : 0;
    assert.equal(parts.reduce((a, b) => a + b, 0), expected, `drifted at ${n} parts`);
    // Nothing invented: a weight of zero never gets a cent.
    weights.forEach((weight, i) => {
      if (weight === 0) assert.equal(parts[i], 0);
    });
  }
});

test('the largest remainder gets the odd cent, and the same input gives the same answer', () => {
  // 10 cents over weights of 1, 2 and 4: 1.43, 2.86, 5.71 before rounding, so
  // the spare cent belongs to the .86, not to whichever came first.
  assert.deepEqual(apportion(10, [1, 2, 4]), [1, 3, 6]);
  assert.deepEqual(apportion(10, [1, 2, 4]), apportion(10, [1, 2, 4]));
  // A tie goes to the earlier position rather than to chance.
  assert.deepEqual(apportion(10, [1, 1, 1]), [4, 3, 3]);
});

test('a split refuses what it cannot do exactly', () => {
  assert.deepEqual(apportion(500, [0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(apportion(0, [3, 1]), [0, 0]);
  // Truncation runs the wrong way below zero, so this is refused rather than
  // quietly coming back two cents short.
  assert.throws(() => apportion(-500, [1, 1]), RangeError);
  assert.throws(() => apportion(100, [1, -1]), TypeError);
  assert.throws(() => apportion(100, [1, 1.5]), TypeError);
  assert.throws(() => apportion(100, 'not an array'), TypeError);
});
