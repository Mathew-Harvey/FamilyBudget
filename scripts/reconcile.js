// Does every dollar land in exactly one place?
//
//   node scripts/reconcile.js
//
// "Are we counting expenses correctly" is not a question anyone should have to
// take on trust, and it is not answered by the tests: those prove the code does
// what it was written to do, on fixtures. This checks the real data against
// arithmetic that has to hold whatever the code does.
//
// Every check either passes or prints what is wrong and by how much.
import { query, closePool } from '../src/db.js';
import { buildForecastContext } from '../src/forecast.js';
import { matchKeyFor } from '../src/commitments.js';
import { position } from '../src/behaviour.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The income figure is only safe while every place that sums money in filters
// on the category kind. Checked against the source, because a future edit that
// drops the filter would pass every other check here.
async function unguardedIncomeQueries() {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files = ['forecast.js', 'buckets.js', 'analyst.js', 'behaviour.js', 'lean.js',
    'routes/behaviour.js', 'routes/spending.js', 'alerts.js'];
  const bad = [];
  for (const name of files) {
    const body = await readFile(path.join(src, name), 'utf8');
    const lines = body.split('\n');
    lines.forEach((line, index) => {
      if (!/amount > 0/.test(line)) return;
      // The filter can sit on this line or within a few either side, since SQL
      // in a template literal wraps.
      const near = lines.slice(Math.max(index - 4, 0), index + 5).join(' ');
      if (!/kind = 'income'/.test(near)) bad.push(`${name}:${index + 1}`);
    });
  }
  return bad;
}

const WINDOW = 120;
let failures = 0;

const money = (value) => `$${Number(value).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function check(label, passed, detail = '') {
  if (!passed) failures++;
  console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

console.log('\nReconciling the real data.\n');

// 1. The view must not lose or duplicate a transaction. It has four left joins,
//    and a duplicate key in any of them would silently multiply a row.
console.log('The view');
const { rows: [shape] } = await query(`
  select (select count(*) from transactions) as txns,
         (select count(*) from budget_flows) as flows,
         (select count(distinct id) from budget_flows) as distinct_flows`);
check('budget_flows has one row per transaction', shape.txns === shape.flows && shape.flows === shape.distinct_flows,
  `${shape.txns} transactions, ${shape.flows} rows, ${shape.distinct_flows} distinct`);

// 2. Every transaction on a spendable account falls into exactly one bucket.
//    A row in none of them is money the app has no opinion about.
console.log('\nEvery dollar on a spendable account');
const { rows: buckets } = await query(`
  with tx as (
    select t.*, bf.counts, bf.to_own_debt, bf.no_longer_expected, bf.reversal_of_id as rev
      from transactions t join budget_flows bf on bf.id = t.id
     where t.account_id in (select id from accounts where is_liquid))
  select case
    when counts and amount < 0 and to_own_debt        then 'out, paying down our own debt'
    when counts and amount < 0 and one_off            then 'out, a one off'
    when counts and amount < 0 and no_longer_expected then 'out, a merchant finished with'
    when counts and amount < 0                        then 'out, living'
    when counts and amount > 0                        then 'in'
    when amount = 0                                   then 'zero, a card authorisation'
    when rev is not null                              then 'not counted, a refund cancelling a charge'
    when exists (select 1 from transactions r where r.reversal_of_id = tx.id)
                                                      then 'not counted, a charge that was refunded'
    when is_transfer and transfer_pair_id is not null  then 'not counted, moved between our own accounts'
    when internal_to_account_id is not null           then 'not counted, moved to our own account, on the description alone'
    else 'UNEXPLAINED' end as bucket,
    count(*)::int as n, round(sum(amount), 2) as total
  from tx group by 1 order by 3`);

const total = buckets.reduce((sum, row) => sum + row.n, 0);
const { rows: [raw] } = await query(
  'select count(*)::int n, round(sum(amount), 2) total from transactions where account_id in (select id from accounts where is_liquid)',
);
for (const row of buckets) console.log(`        ${String(row.n).padStart(5)}  ${money(row.total).padStart(14)}  ${row.bucket}`);
check('every row is in a bucket', total === raw.n, `${total} of ${raw.n}`);
check('nothing is unexplained', !buckets.some((row) => row.bucket === 'UNEXPLAINED'));
const bucketSum = buckets.reduce((sum, row) => sum + Number(row.total), 0);
check('the buckets sum to the raw total', Math.abs(bucketSum - Number(raw.total)) < 0.01,
  `${money(bucketSum)} against ${money(raw.total)}`);

// 3. A matched pair holds both of its sides by construction, so it has to net to
//    nothing. If it does not, one side is being counted and the other is not.
const paired = buckets.find((row) => row.bucket === 'not counted, moved between our own accounts');
check('a matched pair of our own accounts nets to zero',
  !paired || Math.abs(Number(paired.total)) < 0.01, paired ? money(paired.total) : 'none');

// A destination read out of the description is one sided on purpose: it is there
// for the moves whose other side never arrived, because the account is not
// connected or the bank never reported it. Requiring that to net to zero asserts
// something the mechanism cannot satisfy, and lumping it in with the pairs hid
// which of the two was actually wrong. What matters is the size, since this is
// money kept out of the budget on a description alone, with no counterpart to
// confirm it. Anything material means the Transfers page has work waiting.
const oneSided = buckets.find(
  (row) => row.bucket === 'not counted, moved to our own account, on the description alone',
);
const outTotal = buckets
  .filter((row) => row.bucket.startsWith('out,'))
  .reduce((sum, row) => sum + Math.abs(Number(row.total)), 0);
const oneSidedTotal = Math.abs(Number(oneSided?.total ?? 0));
check('money kept out of the budget on a description alone is immaterial',
  oneSidedTotal / Math.max(outTotal, 1) < 0.005,
  oneSided
    ? `${money(oneSided.total)} across ${oneSided.n} rows with no counterpart, ${((oneSidedTotal / Math.max(outTotal, 1)) * 100).toFixed(2)}% of money out`
    : 'none');

// 4. A refund and the charge it cancels have to be equal and opposite.
const { rows: [rev] } = await query(`
  select round(coalesce(sum(r.amount), 0), 2) as credits,
         round(coalesce(sum(c.amount), 0), 2) as charges
    from transactions r join transactions c on c.id = r.reversal_of_id
   where r.reversal_of_id is not null`);
check('refunds exactly cancel the charges they are paired to',
  Math.abs(Number(rev.credits) + Number(rev.charges)) < 0.01,
  `${money(rev.credits)} against ${money(rev.charges)}`);

// 5. Nothing counted twice: a pending row and the posted row for the same
//    purchase both counting would inflate everything.
const { rows: [dupes] } = await query(`
  select count(*)::int n from budget_flows a join budget_flows b
    on a.account_id = b.account_id and a.amount = b.amount and a.id <> b.id
   and abs(a.txn_date - b.txn_date) <= 3
   and a.status = 'pending' and b.status = 'posted' and a.counts and b.counts`);
check('no purchase counted as both pending and posted', dupes.n === 0, `${dupes.n} found`);

// 6. Income is only what is categorised as income. A transfer in that leaked
//    into the income figure would make the gap look smaller than it is.
console.log('\nWhat counts as income');
const { rows: leak } = await query(`
  select coalesce(c.kind, 'uncategorised') as kind, count(*)::int n, round(sum(t.amount), 2) total
    from budget_flows t left join categories c on c.id = t.category_id
   where t.counts and t.amount > 0 group by 1 order by 3 desc`);
for (const row of leak) console.log(`        ${String(row.n).padStart(5)}  ${money(row.total).padStart(14)}  ${row.kind}`);
// A transfer in that counts is money the app thinks arrived from outside when
// it came from another account of ours. It makes the gap look smaller than it
// is, so the amount is stated rather than waved through by a threshold.
const transferIn = Number(leak.find((row) => row.kind === 'transfer')?.total ?? 0);
const inTotal = leak.reduce((sum, row) => sum + Math.abs(Number(row.total)), 0);
check('money in that the category calls a transfer is immaterial',
  transferIn / Math.max(inTotal, 1) < 0.005,
  transferIn === 0
    ? 'none'
    : `${money(transferIn)}, ${((transferIn / inTotal) * 100).toFixed(2)}% of money in, from transfers with no counterpart found`);

// Money in that is not income and not a transfer is borrowing: a redraw from
// the mortgage arrives as cash and is not earnings. It must not reach the
// income figure, which is what the kind filter on every income query is for.
const borrowed = Number(leak.find((row) => row.kind === 'expense')?.total ?? 0);
if (borrowed > 0) {
  console.log(`        ${money(borrowed).padStart(14)}  of that is borrowed or refunded, not earned`);
}
const unguarded = await unguardedIncomeQueries();
check('every query that sums money in filters on the income kind',
  unguarded.length === 0,
  unguarded.length ? `unguarded: ${unguarded.join(', ')}` : 'checked across the modules that sum it');

// 7. No commitment is counted twice.
//
// costs.js keeps a commitment's spending out of the everyday rate by looking up
// matchKeyFor(description). A commitment whose key that function could never
// produce is therefore projected AND left in the rate, which is what the old
// "manual:<label>" namespace did: a cafe costing 122 a month was carried at
// 296. Checked against the one definition rather than against that prefix, so a
// future second namespace is caught the same way. Grouped in JavaScript, never
// by writing matchKeyFor again in SQL.
console.log('\nNothing is counted twice');
const { rows: active } = await query('select id, label, match_key from commitments where active');
const { rows: spendRows } = await query(
  `select coalesce(display_description, description) as label, -amount as amt
     from budget_flows where counts and amount < 0 and not one_off and not no_longer_expected
       and txn_date > current_date - $1::integer and txn_date <= current_date`, [WINDOW]);
const spendByKey = new Map();
for (const row of spendRows) {
  const key = matchKeyFor(row.label);
  spendByKey.set(key, (spendByKey.get(key) ?? 0) + Number(row.amt));
}
// A commitment is keyed by what its own label reduces to. Anything else is
// wrong in one of two ways, and both are a double count: either nothing
// subtracts its spending from the everyday rate, or the commitment that does
// hold the right key is the same cost listed a second time.
const heldKeys = new Set(active.map((row) => row.match_key));
const wrongKey = active.filter((row) => matchKeyFor(String(row.label)) !== row.match_key);
const detail = wrongKey.map((row) => {
  const real = matchKeyFor(String(row.label));
  if (!real) return `${row.label} (its name has nothing to match on)`;
  if (heldKeys.has(real)) return `${row.label} (a duplicate of the commitment already holding ${real})`;
  const perMonth = (spendByKey.get(real) ?? 0) * 30.44 / WINDOW;
  return perMonth > 0.005
    ? `${row.label} (${money(perMonth)} a month of its spending is in the everyday rate as well)`
    : `${row.label} (nothing charged to it yet)`;
});
check('every commitment is keyed by what its own label reduces to',
  wrongKey.length === 0,
  wrongKey.length
    ? `${wrongKey.length} are not: ${detail.join(', ')}. Run node scripts/rekey-commitments.js`
    : `${active.length} active, all reachable`);

// 8. The two pages measure the same window the same way.
console.log('\nThe pages agree');
const { rows: [windows] } = await query(`
  select round(sum(-amount) filter (where txn_date > current_date - $1::integer), 2) as spending_page,
         round(sum(-amount) filter (where txn_date > current_date - $1::integer and txn_date <= current_date), 2) as forecast
    from budget_flows where counts and amount < 0`, [WINDOW]);
check('the Spending page and the forecast use the same window',
  Math.abs(Number(windows.spending_page) - Number(windows.forecast)) < 0.01,
  `${money(windows.spending_page)} against ${money(windows.forecast)}`);

// 8. The headline reconciles with what actually left the account, and any
//    difference is named rather than shrugged at.
console.log('\nThe headline against what actually left');
const forecastContext = await buildForecastContext({ window: WINDOW });
const here = await position({ window: WINDOW, forecastContext });
const { costs } = forecastContext;
const rate = costs.rate;
// Divided by the days there is history for, the same divisor the household
// plan uses. Dividing by the window asked for would make this check disagree
// with the figure it is checking on any database younger than the window.
const over = rate.effective_days;
const { rows: [flow] } = await query(`
  select round(sum(-amount) * 30.44 / $2, 2) as all_out,
         round(sum(-amount) filter (where not one_off and not no_longer_expected) * 30.44 / $2, 2) as in_rate
    from budget_flows where counts and amount < 0
      and txn_date > current_date - $1::integer and txn_date <= current_date`, [WINDOW, over]);

console.log(`        ${money(flow.all_out).padStart(14)}  a month left a spendable account`);
console.log(`        ${money(flow.in_rate).padStart(14)}  a month after one offs and finished merchants come out`);
console.log(`        ${money(here.out_per_month).padStart(14)}  a month is in the household plan`);

// The difference is projected commitments against how they actually fell. Named
// per commitment, because an unexplained gap here is the one that matters.
const { rows: txns } = await query(
  `select coalesce(display_description, description) as label, -amount as amt
     from budget_flows where counts and amount < 0 and not one_off and not no_longer_expected
       and txn_date > current_date - $1::integer`, [WINDOW]);
const actual = new Map();
for (const row of txns) {
  const key = matchKeyFor(row.label);
  actual.set(key, (actual.get(key) ?? 0) + Number(row.amt));
}
const drift = costs.commitments
  .map((row) => ({
    label: row.label.slice(0, 34),
    over: Number(row.per_month) - ((actual.get(row.match_key) ?? 0) * 30.44) / WINDOW,
  }))
  .filter((row) => Math.abs(row.over) > 20)
  .sort((a, b) => b.over - a.over);
const driftTotal = costs.commitments.reduce(
  (sum, row) => sum + Number(row.per_month) - ((actual.get(row.match_key) ?? 0) * 30.44) / WINDOW, 0);

const historicalDiscretionary = costs.historical_discretionary_per_month_cents / 100;
const irregularEssential = (Number(rate.irregular_essential) * 30.44) / rate.effective_days;
const allowance = costs.discretionary_allowance_cents / 100;
const explainedPlan = Number(flow.in_rate)
  - historicalDiscretionary
  - irregularEssential
  + allowance
  + driftTotal;

console.log(`        ${money(-historicalDiscretionary).padStart(14)}  optional history replaced by the allowance`);
console.log(`        ${money(-irregularEssential).padStart(14)}  irregular essentials not turned into a rate`);
console.log(`        ${money(allowance).padStart(14)}  discretionary allowance added`);
console.log('\n        commitment timing and amount differences:');
for (const row of drift) console.log(`        ${money(row.over).padStart(14)}  ${row.label}`);
check('the household plan is fully accounted for by named choices',
  Math.abs(explainedPlan - Number(here.out_per_month)) < 5,
  `${money(explainedPlan)} explained against ${money(here.out_per_month)} shown`);

// 9. Spending nobody has explained. Not a failure, but worth knowing.
console.log('\nStill unexplained');
const { rows: [unknown] } = await query(`
  select coalesce(round(sum(-amount) filter (where category_id is null), 2), 0) as uncategorised,
         coalesce(round(sum(-amount) filter (where merchant_key is null or merchant_key = 'UNKNOWN'), 2), 0) as no_merchant,
         round(sum(-amount), 2) as window_total
    from budget_flows where counts and amount < 0 and txn_date > current_date - $1::integer`, [WINDOW]);
console.log(`        ${money(unknown.uncategorised).padStart(14)}  in no category`);
console.log(`        ${money(unknown.no_merchant).padStart(14)}  the bank did not say who it went to`);
console.log(`        ${money(unknown.window_total).padStart(14)}  total in the window`);

console.log(failures === 0
  ? '\nEverything reconciles.\n'
  : `\n${failures} check${failures === 1 ? '' : 's'} did not pass.\n`);
await closePool();
process.exit(failures === 0 ? 0 : 1);
