#!/usr/bin/env node
// Should irregular essentials be in the forecast at all?
//
//   node scripts/backtest-irregular.js
//
// The forecast projects recurring essentials plus the allowance. Essential
// spending at a place seen on fewer than three separate dates is left out
// entirely, and reconcile names the gap rather than closing it. On this
// household that is over a thousand dollars a month of vet bills, registrations,
// repairs and replacements that the plan says will not happen.
//
// The gate itself is right, and it is right for a reason worth keeping: one
// payment divided by a window is not that merchant's monthly cost. The Bendigo
// card is 25 a year to keep open and was once reported at 25.37 a month, which
// is the same number twelve times over.
//
// But refusing to quote a rate FOR A MERCHANT is a different claim from leaving
// the money out of the household total. Which vet, which mechanic and which
// registration falls in any given month is close to random, which is exactly
// why no single one of them reaches three dates. The sum of many small
// independent events is far steadier than any one of them, and that sum is what
// the forecast needs.
//
// That is an argument, and arguments do not settle rate questions here. This
// measures it, the same way scripts/backtest.js measures the window: stand at a
// date in the past, build both rates from the history before it, and compare
// each against what really went out over the sixty days after. Step forward a
// week and repeat.
//
//   without  recurring essentials + discretionary          (what it does today)
//   with     recurring essentials + discretionary + irregular essentials
//
// One offs, finished merchants and anything matching an active commitment are
// out of the inputs and out of the truth, on both sides, because commitments
// are projected as dated events rather than as part of this rate.
import { query, closePool } from '../src/db.js';
import { matchKeyFor } from '../src/commitments.js';
import { TIER_SQL } from '../src/costs.js';

const DAY = 864e5;
const HORIZON = 60;
const WINDOW = Number(process.env.SPEND_WINDOW_DAYS || 120);

const { rows: commitmentRows } = await query(
  'select match_key from commitments where active and cadence_days > 0',
);
const commitmentKeys = new Set(commitmentRows.map((row) => row.match_key));

// The same filter and the same classification buildCostModel uses, over all of
// history rather than one window.
const { rows } = await query(
  `select t.txn_date as d, -t.amount as a,
          coalesce(t.merchant_key, '') as merchant_key,
          coalesce(t.display_description, t.description) as label,
          ${TIER_SQL} as tier
     from budget_flows t
     left join merchants m on m.match_key = t.merchant_key
     left join categories cat on cat.id = t.category_id
    where t.counts and t.amount < 0
      and not t.one_off and not t.no_longer_expected
    order by t.txn_date`,
);

const tx = rows
  .map((row) => {
    const key = matchKeyFor(row.label);
    return {
      day: new Date(`${String(row.d)}T00:00:00Z`).getTime() / DAY,
      amount: Number(row.a),
      place: row.merchant_key || key || row.label,
      tier: row.tier,
      committed: commitmentKeys.has(key),
    };
  })
  .filter((row) => !row.committed);

if (tx.length < 50) {
  console.log('Not enough history to measure this. Come back with a few months of data.');
  await closePool();
  process.exit(0);
}

const between = (from, to) => tx.filter((row) => row.day > from && row.day <= to);

// Split a window the way the cost model does: a place seen on three or more
// separate dates is a rate, anything below the gate is irregular.
function split(window) {
  const dates = new Map();
  for (const row of window) {
    if (!dates.has(row.place)) dates.set(row.place, new Set());
    dates.get(row.place).add(row.day);
  }
  let recurringEssential = 0;
  let irregularEssential = 0;
  let discretionary = 0;
  for (const row of window) {
    if (row.tier === 'cut') discretionary += row.amount;
    else if (dates.get(row.place).size >= 3) recurringEssential += row.amount;
    else irregularEssential += row.amount;
  }
  return { recurringEssential, irregularEssential, discretionary };
}

const first = tx[0].day;
const last = tx.at(-1).day;
const mean = (list) => list.reduce((total, x) => total + x, 0) / list.length;

const errWithout = [];
const errWith = [];
const shares = [];
for (let at = first + WINDOW; at <= last - HORIZON; at += 7) {
  const parts = split(between(at - WINDOW, at));
  // Divided by the days there is history for, the one definition of that.
  const covered = Math.max(Math.min(WINDOW, at - first + 1), 1);
  const perDayWithout = (parts.recurringEssential + parts.discretionary) / covered;
  const perDayWith = perDayWithout + parts.irregularEssential / covered;

  const truth = between(at, at + HORIZON).reduce((total, row) => total + row.amount, 0);
  errWithout.push(Math.abs(perDayWithout * HORIZON - truth));
  errWith.push(Math.abs(perDayWith * HORIZON - truth));
  shares.push(parts.irregularEssential /
    Math.max(parts.recurringEssential + parts.discretionary + parts.irregularEssential, 1));
}

const money = (value) => `$${Math.round(value).toLocaleString()}`;
const pct = (value) => `${(value * 100).toFixed(1)}%`;
// The mean of an error is hostage to one big month: a single 11,000 dollar
// purchase inside a truth window and outside the input window misses by 11,000
// on both sides and drowns the difference being measured. The median says what
// a typical test looked like, and the win rate says how often each side was
// closer, neither of which one outlier can move.
const middle = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

console.log(`Predicting the next ${HORIZON} days of everyday spending, ${errWith.length} tests,`);
console.log(`a ${WINDOW} day window, commitments and one offs out of both sides.\n`);
const wins = errWith.filter((value, i) => value < errWithout[i]).length;
console.log('                                  mean     median');
console.log(`  without irregular essentials  ${money(mean(errWithout)).padStart(8)}  ${money(middle(errWithout)).padStart(8)}`);
console.log(`  with    irregular essentials  ${money(mean(errWith)).padStart(8)}  ${money(middle(errWith)).padStart(8)}`);
console.log(`\n  including them was closer in ${wins} of ${errWith.length} tests`);

const better = middle(errWithout) - middle(errWith);
const share = mean(shares);
console.log(`\n  irregular essentials are ${pct(share)} of everyday spending on average`);
if (Math.abs(better) < 1) {
  console.log('  neither is better: there is nothing here to include');
} else if (better > 0) {
  console.log(`  including them is better by ${money(better)} over ${HORIZON} days at the median,`
    + ` ${pct(better / middle(errWithout))} of the error`);
} else {
  console.log(`  including them is WORSE by ${money(-better)} over ${HORIZON} days at the median,`
    + ` ${pct(-better / middle(errWithout))} of the error`);
}

// Which way each side misses. A rate that is always short is a different
// problem from one that is noisy, and only the first is fixed by adding a term.
const biasWithout = [];
const biasWith = [];
for (let at = first + WINDOW, i = 0; at <= last - HORIZON; at += 7, i++) {
  const parts = split(between(at - WINDOW, at));
  const covered = Math.max(Math.min(WINDOW, at - first + 1), 1);
  const truth = between(at, at + HORIZON).reduce((total, row) => total + row.amount, 0);
  const without = (parts.recurringEssential + parts.discretionary) / covered * HORIZON;
  biasWithout.push(without - truth);
  biasWith.push(without + parts.irregularEssential / covered * HORIZON - truth);
}
// Which way each side misses. A rate that is always short is a different
// problem from one that is noisy, and only the first is fixed by adding a term.
console.log(`\n  the projection misses by (negative means it projects too little):`);
console.log(`    without  ${money(middle(biasWithout)).padStart(8)} at the median, ${money(mean(biasWithout))} on average`);
console.log(`    with     ${money(middle(biasWith)).padStart(8)} at the median, ${money(mean(biasWith))} on average`);

await closePool();
