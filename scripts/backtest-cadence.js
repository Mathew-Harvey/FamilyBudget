#!/usr/bin/env node
// Which statistic should a commitment's cadence be?
//
//   node scripts/backtest-cadence.js
//
// scripts/backtest.js answers the same shape of question about the everyday
// spend window. This one is about the cadence, and it exists because that
// choice was made on synthetic data and then only partly held up on real data.
//
// The cadence is the denominator of `amount * 30.44 / cadence`, so it has to
// answer "how often does this actually happen". Two statistics compete:
//
//   median  robust to a long gap, a holiday, a bill paid late. Sits below the
//           mean whenever gaps are right skewed, which they usually are, so it
//           projects high for anything irregular.
//   mean    agrees with the observed total by construction. Sensitive to one
//           short gap, a re-charge or a second service billed two days later,
//           which drags it down and projects high in the other direction.
//
// So both fail, in opposite directions, and only a measurement says which
// fails less on a given household. Two more are tried alongside them:
//
//   trimmed the mean with the longest and shortest gap dropped, which is meant
//           to survive both failure modes
//   merged  the mean after gaps shorter than a third of the median are folded
//           into the gap before them, on the theory that a charge two days
//           after another is the same event rather than a new one
//
// Method, the same as scripts/backtest.js: stand at a date in the past, detect
// commitments from the history before it, project each one's monthly cost, and
// compare against what that merchant really cost over the sixty days after.
// Step forward a week and repeat. One offs and finished merchants are out of
// both the inputs and the truth.
import { query, closePool } from '../src/db.js';
import { matchKeyFor, median, medianCents } from '../src/commitments.js';
import { numericToCents } from '../src/money.js';

const DAY = 864e5;
const LOOKBACK = Number(process.env.SYNC_COMMITMENT_LOOKBACK_DAYS || 400);
const HORIZON = 60;

const { rows } = await query(
  `select coalesce(display_description, description) as label, amount, txn_date
     from budget_flows
    where counts and amount < 0 and not one_off and not no_longer_expected
    order by txn_date`,
);
if (rows.length < 50) {
  console.log('Not enough history to backtest anything. Sync first.');
  await closePool();
  process.exit(0);
}

const tx = rows
  .map((row) => ({
    key: matchKeyFor(row.label),
    day: Date.parse(`${String(row.txn_date).slice(0, 10)}T00:00:00Z`) / DAY,
    cents: -numericToCents(row.amount),
  }))
  .filter((row) => row.key);

const first = tx[0].day;
const last = tx.at(-1).day;

// The four candidates, each given the positive gaps and the median of them.
const CADENCES = {
  median: (gaps, med) => med,
  mean: (gaps) => gaps.reduce((a, b) => a + b, 0) / gaps.length,
  trimmed: (gaps) => {
    if (gaps.length < 4) return gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sorted = [...gaps].sort((a, b) => a - b).slice(1, -1);
    return sorted.reduce((a, b) => a + b, 0) / sorted.length;
  },
  merged: (gaps, med) => {
    // A charge that lands within a third of a cadence of the one before it is
    // the same event, not a new one, so it stops being its own gap.
    const kept = [];
    for (const gap of gaps) {
      if (gap < med / 3 && kept.length) kept[kept.length - 1] += gap;
      else kept.push(gap);
    }
    return kept.reduce((a, b) => a + b, 0) / kept.length;
  },
};

// The detector, exactly as src/commitments.js gates it, with the cadence swapped.
function detect(upTo, pick) {
  const groups = new Map();
  for (const row of tx) {
    if (row.day > upTo || row.day <= upTo - LOOKBACK) continue;
    const group = groups.get(row.key) ?? { days: [], cents: [] };
    group.days.push(row.day);
    group.cents.push(row.cents);
    groups.set(row.key, group);
  }

  const found = [];
  for (const [key, group] of groups) {
    if (group.days.length < 3) continue;
    const gaps = [];
    for (let i = 1; i < group.days.length; i++) {
      const gap = group.days[i] - group.days[i - 1];
      if (gap > 0) gaps.push(gap);
    }
    if (gaps.length < 2) continue;
    const med = median(gaps);
    if (med < 5 || med > 200) continue;
    if (med > 45 && gaps.length < 3) continue;
    const close = gaps.filter((gap) => Math.abs(gap - med) <= med * 0.3).length;
    if (close / gaps.length < 0.6) continue;

    const cadence = Math.round(pick(gaps, med));
    if (!(cadence >= 5) || cadence > 200) continue;
    const amount = medianCents(group.cents.slice(-6));
    found.push({ key, perMonthCents: (amount * 3044) / (cadence * 100) });
  }
  return found;
}

console.log(`\nBacktesting the commitment cadence over ${Math.round(last - first)} days of history.`);
console.log(`Predicting the next ${HORIZON} days, stepping weekly.\n`);

const results = [];
for (const [name, pick] of Object.entries(CADENCES)) {
  const errors = [];
  let over = 0;
  let under = 0;
  for (let at = first + LOOKBACK / 2; at <= last - HORIZON; at += 7) {
    for (const commitment of detect(at, pick)) {
      const actual = tx
        .filter((row) => row.key === commitment.key && row.day > at && row.day <= at + HORIZON)
        .reduce((total, row) => total + row.cents, 0);
      const predicted = (commitment.perMonthCents * HORIZON) / 30.44;
      errors.push(Math.abs(predicted - actual));
      if (predicted > actual) over += predicted - actual;
      else under += actual - predicted;
    }
  }
  if (!errors.length) continue;
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  results.push({ name, mean, over: over / errors.length, under: under / errors.length, n: errors.length });
}

if (!results.length) {
  console.log('No commitment was detectable at any point in the history. Nothing to compare.');
  await closePool();
  process.exit(0);
}

results.sort((a, b) => a.mean - b.mean);
const money = (cents) => `$${(cents / 100).toFixed(2)}`;
console.log('  statistic    mean error   projected high   projected low   predictions');
for (const row of results) {
  console.log(
    `  ${row.name.padEnd(11)}${money(row.mean).padStart(10)}${money(row.over).padStart(17)}${money(row.under).padStart(16)}${String(row.n).padStart(14)}`,
  );
}
console.log(`\nbest: ${results[0].name}`);
console.log('src/commitments.js uses the mean. Change it only with this output in hand,');
console.log('and say in the commit which household it was measured on.\n');
await closePool();
