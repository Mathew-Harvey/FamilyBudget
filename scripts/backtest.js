// Which spend window actually predicts the next sixty days best?
//
// Stand at a date in the past, work out the rate from the window before it,
// then compare that against what really went out over the sixty days after.
// Repeat weekly and average the error. This is the only honest way to choose a
// window: the intuition that recent data is better competes with the fact that
// less data is noisier, and only a measurement settles it.
//
// One offs are excluded from both the inputs and the truth, because the whole
// point of marking them is that they are not part of the rate.
//
//   node scripts/backtest.js
import { query, closePool } from '../src/db.js';
const { rows } = await query(`select t.txn_date d, -t.amount a from budget_flows t
  where t.counts and t.amount<0 and not t.one_off order by t.txn_date`);
const tx=rows.map(r=>({d:new Date(String(r.d)+'T00:00:00Z').getTime()/864e5,a:Number(r.a)}));
const sum=(f,t)=>tx.filter(x=>x.d>f&&x.d<=t).reduce((s,x)=>s+x.a,0);
const first=tx[0].d,last=tx.at(-1).d,mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
const out=[];
for(const W of [30,45,60,90,120,150,180]){
  const e=[]; for(let D=first+180; D<=last-60; D+=7) e.push(Math.abs(sum(D-W,D)*60/W - sum(D,D+60)));
  out.push([W,Math.round(mean(e)),e.length]);
}
out.sort((a,b)=>a[1]-b[1]);
console.log('Backtest with real one_off flags: predict the next 60 days of spending');
for(const [W,err,n] of out) console.log(`  ${String(W).padStart(3)}d window -> mean error $${err.toLocaleString().padStart(6)} over ${n} tests`);
console.log('\nbest window:', out[0][0]+'d');
// stability of the answer today
console.log('\nToday\'s monthly rate by window (one-offs out):');
for(const W of [30,60,90,120,180]) console.log(`  ${String(W).padStart(3)}d -> $${Math.round(sum(last-W,last)*30.44/W).toLocaleString()}/mo`);
await closePool();
