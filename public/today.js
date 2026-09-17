// The Today page.
//
// The other pages answer "what happened". This one answers "what now", and it
// is built around a handful of findings about how people actually respond to
// financial information. docs/behaviour.md has the reasoning and the list of
// things deliberately not done. The rules it follows:
//
//   A date, not a day count.     "68 days" is arithmetic you have to do
//                                something with. "23 November" is already in
//                                your calendar, next to things you have
//                                planned.
//   Credit first.                What was cut is shown before what grew. On
//                                this household the cuts were real, and a page
//                                that opens by telling someone their effort
//                                failed is a page they stop opening.
//   No names.                    Spending is attributed to categories and
//                                places, never to a person. Two people share
//                                this. The moment it becomes evidence it stops
//                                being a budget.
//   Everything is true.          No invented urgency, no countdown that is not
//                                a real date, no number bent to make a point.
//                                A tool you cannot trust the numbers in is
//                                worth nothing, which makes honesty the
//                                self interested choice as well as the right
//                                one.
import { api, el, formatAmount, renderNav, showError } from '/app.js';
import { cashChart } from '/chart.js';

renderNav('/today');

const money = (value) => formatAmount(value);
// Integer cents to a 2dp string without dividing by 100, which is float
// arithmetic on an amount. Same conversion money.js does on the server.
const centsToText = (cents) => {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const part = abs % 100;
  // abs - part is an exact multiple of 100, so this division is exact in IEEE
  // 754 for every value we allow. Never abs / 100 directly. Same as money.js.
  const whole = (abs - part) / 100;
  return `${negative ? '-' : ''}${whole}.${String(part).padStart(2, '0')}`;
};
const abs = (value) => formatAmount(String(value).replace('-', ''));

// Two letters from the name the household would recognise. A logo would need
// fetching from somewhere and a generic glyph says less than the initials.
function initialsOf(label) {
  const words = String(label || '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/);
  if (!words[0]) return '??';
  const first = words[0];
  return (words.length > 1 ? first[0] + words[1][0] : first.slice(0, 2)).toUpperCase();
}

// keep, trim or cut, straight from the server. src/costs.js owns classification
// and no page reimplements it, so this only guards against an older payload.
// A commitment that reached the optional tier only because nothing has judged
// it is not a choice somebody made, it is a question nobody has answered. It
// gets the hatch rather than the pale blue, the same mark the Spending diagram
// and the Lasting plan use, so the front page stops presenting a default as a
// decision.
function tierOf(item) {
  if (item.tier === 'cut' && item.tier_source === 'default') return 'unknown';
  return ['keep', 'trim', 'cut'].includes(item.tier) ? item.tier : 'unknown';
}

// The opening. One sentence someone can repeat to the other person in the
// house without opening the app.
//
// docs/behaviour.md is firm that the runway is a DATE, in the largest type,
// with the day count as a footnote: "68 days" is arithmetic, "23 November"
// collides with a calendar you already have in your head. So the date wins the
// hero whenever there is one.
//
// It does not always say what to do when there is not one, which is the
// ordinary case for a household that is slightly short with cash in the bank.
// Printing the balance there instead is the honest fallback: it is the number
// the runway would have been computed from, it is true, and it is the thing you
// would look up if the app did not exist. The state line above it carries the
// direction so the figure is never read as good news on its own.
function headline(position, curve, expecting = []) {
  const box = document.getElementById('headline');
  box.innerHTML = '';
  box.className = 'card';

  const behind = position.going_backwards;
  const runsOut = Boolean(position.runway_date_friendly);

  const state = el('span', { class: `state ${behind ? (runsOut ? 'bad' : 'warn') : 'ok'}` }, [
    el('span', { class: 'dot' }),
    el('span', { text: behind
      ? (runsOut ? 'Spendable cash runs out' : 'Spending a little more than comes in')
      : 'More is coming in than going out' }),
  ]);

  const figure = runsOut
    ? el('div', { class: 'figure date', text: position.runway_date_friendly })
    : el('div', { class: 'figure', text: money(position.spendable) });

  // The footnote under the figure. A day count under a date, the direction
  // under a balance. Never the word null, which is what both of these used to
  // read when the projection did not reach zero.
  const under = runsOut
    ? el('div', { class: 'delta down' }, [
        el('span', { text: `${position.runway_days} days ` }),
        el('span', { class: 'q', text: 'from today, using the household plan' }),
      ])
    : el('div', { class: `delta ${behind ? 'down' : 'up'}` }, [
        el('span', { text: `${behind ? '\u2193' : '\u2191'} ${abs(position.gap_per_month)} ` }),
        el('span', { class: 'q', text: behind ? 'a month more out than in' : 'a month left over' }),
      ]);

  box.append(state, figure, under);

  // The shape of it, which is the one thing no figure on this page carries.
  //
  // The headline is a point on this curve: a runway date is where it crosses
  // zero, a balance is where it starts. Drawing the curve under it says the
  // same thing in the dimension the numbers cannot, which is time. The band is
  // measured from today's level, so building up and running down are an area
  // and a colour rather than a sign on a number, and a fortnight that dips
  // before payday and recovers after is visible here and nowhere else.
  if (curve?.series?.length > 1) {
    box.append(cashChart(curve.series, { height: 190, runwayDate: curve.runway_date }));
  }

  // In against out, on one scale, so the gap is a length rather than a
  // sentence. This replaced "X comes in, the plan includes Y of recurring
  // essentials, Z discretionary and active commitments", which is four figures
  // in a line of prose and reads as wallpaper. The out bar is split into the
  // two things it is: both leave the account, but one is consumed and one buys
  // down what is owed, and only one of them is a monthly choice.
  const inCents = Math.round(Number(position.in_per_month) * 100);
  const livingCents = Math.round(Number(position.living_per_month) * 100);
  const debtCents = Math.round(Number(position.debt_per_month) * 100);
  const widest = Math.max(inCents, livingCents + debtCents, 1);
  const width = (cents) => `${((cents / widest) * 100).toFixed(1)}%`;

  if (inCents > 0 || livingCents > 0 || debtCents > 0) {
    box.append(
      el('div', { class: 'compare', style: 'margin-top:20px' }, [
        el('span', { class: 's', text: 'In' }),
        // Neutral, not the status green. Green is reserved for state and a bar
        // is a series, so income is the quiet reference and the coloured bar
        // below is the subject. The comparison is length, which needs no hue.
        el('div', { class: 'split', style: `width:${width(inCents)}` }, [
          el('i', { style: 'flex:1;background:var(--neutral)' }),
        ]),
        el('span', { class: 'amount', text: money(position.in_per_month) }),

        el('span', { class: 's', text: 'Out' }),
        el('div', { class: 'split', style: `width:${width(livingCents + debtCents)}` }, [
          el('i', { style: `flex:${Math.max(livingCents, 1)};background:var(--accent)` }),
          debtCents > 0 ? el('i', { style: `flex:${debtCents};background:var(--accent-2)` }) : null,
        ]),
        el('span', { class: 'amount', text: money(position.out_per_month) }),
      ]),
      el('div', { class: 'keys' }, [
        el('span', {}, [el('i', { style: 'background:var(--accent)' }),
          el('span', { text: 'Living ' }), el('b', { text: money(position.living_per_month) })]),
        debtCents > 0 ? el('span', {}, [el('i', { style: 'background:var(--accent-2)' }),
          el('span', { text: 'Debt ' }), el('b', { text: money(position.debt_per_month) })]) : null,
      ]),
      // Income that has not started yet belongs beside the income that has.
      // A second job, a wage beginning in March: the app has carried these all
      // along and put them behind one row of the Set up index, which is where
      // they were looked for twice and not found. Said here, next to the "In"
      // this page is measured against, because that is the bar they change.
      el('p', { class: 'muted small', style: 'margin:12px 0 0' }, [
        el('span', { text: expecting?.length
          ? `${expecting.length} more coming that has not started yet. `
          : 'Expecting a wage that has not started yet, or a second job? ' }),
        el('a', { href: '/expected', text: expecting?.length ? 'Check it' : 'Add it to the forecast' }),
      ]),
    );
  }

  // Where the plan and the spending disagree, said on the page that leads with
  // the plan's own figure.
  //
  // "Out" is every essential, the allowance and the commitments, so optional
  // day to day spending enters it only through the allowance. Essentials here
  // means the irregular ones too, the vets and registrations that never reach
  // three dates: they are 106.24 a month on this household and leaving them out
  // of this sentence made it describe a smaller figure than the one drawn. An
  // allowance nobody has chosen now follows what that spending has actually
  // been, which makes this silent, as it should be: there is nothing to warn
  // about when the plan and the household agree. It fires when someone has set
  // a figure below what they are spending, which is an intention rather than a
  // mistake, and worth keeping in view for exactly that reason.
  const excluded = Number(position.optional_history_excluded ?? 0);
  if (excluded > 0) {
    box.after(el('div', { class: 'nudge' }, [
      el('h3', { text: 'The plan assumes less than lately' }),
      el('p', { text:
        `It allows ${money(position.discretionary_per_month)} a month for things you do not have `
        + `to buy. The last few months have run at ${money(position.optional_history_per_month)}.` }),
      el('a', { class: 'btn', href: '/allowance', text: 'Look at it', style: 'margin-top:11px' }),
    ]));
  }

  for (const warning of position.warnings ?? []) {
    box.append(el('p', { class: 'warn small', style: 'margin-bottom:0', text: warning.message }));
  }
}

// How this fortnight is going.
//
// Everything above is a month, and nobody lives a month. The pay lands every
// fortnight and has to last until the next lot, which is the unit the decisions
// are actually taken in: "965 a month short" is a fact about a shape, "443
// short this fortnight" is a fact about the week you are having.
//
// Measured rather than converted. Dividing the monthly figure by 2.17 gives a
// fortnight sized number that describes no particular fortnight; this is what
// actually came in and went out since the last payday.
//
// The mark on the bars is where an even spend would have reached by now, so
// being ahead or behind is a length rather than a division. The balance is
// deliberately not the subject: a household with 22,000 in the bank is not
// living on it for four days, and the flow through the period means the same
// thing at any balance.
function fortnight(period) {
  const box = document.getElementById('fortnight');
  box.innerHTML = '';
  if (!period || !period.days_total) return;

  const inCents = period.in_so_far_cents;
  const outCents = period.out_so_far_cents;
  const widest = Math.max(inCents, outCents, period.pace_cents, 1);
  const width = (cents) => `${Math.min((cents / widest) * 100, 100).toFixed(1)}%`;
  const over = outCents > period.pace_cents;

  const lane = (cents, className) => el('div', { class: 'lane' }, [
    el('i', { class: className, style: `width:${width(cents)}` }),
  ]);
  const outLane = lane(outCents, over ? 'out over' : 'out');
  if (period.has_income) {
    outLane.append(el('div', {
      class: 'pace',
      style: `left:${width(period.pace_cents)}`,
      'data-note': `${period.days_elapsed} of ${period.days_total} days gone`,
    }));
  }

  box.append(
    el('div', { class: 'sec', text: `This ${period.unit}` }),
    el('div', { class: 'card period' }, [
      el('span', { class: `state ${over ? 'warn' : 'ok'}` }, [
        el('span', { class: 'dot' }),
        el('span', { text: period.days_left === 0
          ? 'Payday tomorrow'
          : `${period.days_left} day${period.days_left === 1 ? '' : 's'} to payday, ${period.next_payday_friendly}` }),
      ]),
      el('div', { class: 'figure', text: abs(period.net_so_far) }),
      el('div', { class: `delta ${String(period.net_so_far).startsWith('-') ? 'down' : 'up'}` }, [
        el('span', { class: 'q', text: String(period.net_so_far).startsWith('-')
          ? `more has gone out than came in this ${period.unit}`
          : `of this ${period.unit}'s pay is still unspent` }),
      ]),
      el('div', { class: 'bars', style: 'margin-top:20px' }, [
        el('span', { class: 's', text: 'In' }),
        lane(inCents),
        el('span', { class: 'amount', text: money(period.in_so_far) }),
        el('span', { class: 's', text: 'Out' }),
        outLane,
        el('span', { class: 'amount', text: money(period.out_so_far) }),
      ]),
      el('p', { class: 'muted small', style: 'margin:0', text:
        (period.has_income
          // "under", not "short of". Being below an even spend is the good
          // case and this line sat under a green head saying the pay was still
          // unspent, so the one word was arguing with the rest of the card.
          ? `${money(period.off_pace)} ${over ? 'past' : 'under'} an even spend by now`
          : `No pay has landed this ${period.unit} yet`)
        + (period.still_to_come && Number(period.still_to_come) > 0
          ? `, and the plan expects ${money(period.still_to_come)} more before payday.`
          : '.') }),
    ]),
  );
}

// Did the last decision hold?
//
// This is the part most likely to change anything, and the part easiest to get
// wrong. Everyone who decides to spend less believes they then spent less. The
// only way to know is to measure either side of the decision, and the common
// answer is that real cuts were made and then quietly spent somewhere else.
function stuck(data, changePoint) {
  const box = document.getElementById('stuck');
  box.innerHTML = '';
  if (!data) return;

  const cut = Number(String(data.cut).replace(/[^0-9.-]/g, ''));
  const rose = Number(String(data.rose).replace(/[^0-9.-]/g, ''));
  const net = Number(String(data.net_per_month).replace(/[^0-9.-]/g, ''));

  const card = el('div', { class: 'card stack' }, [
    el('h3', { style: 'margin:0', text: 'Did it stick?' }),
    el('div', { class: 'muted', text: `${data.days_since} days since ${changePoint.date}, against the ${data.compared_against_days} before it.` }),
  ]);

  // Credit first, and it is not a kindness, it is the larger number.
  card.append(
    el('p', { style: 'font-size:1.05rem;margin:0.4rem 0' }, [
      el('span', { text: 'You cut ' }),
      el('strong', { class: 'amount', text: `${abs(cut)} a month` }),
      el('span', { text: '. ' }),
      rose > 0 ? el('span', {}, [
        el('span', { text: 'Then ' }),
        el('strong', { class: 'amount out', text: `${abs(rose)} a month` }),
        el('span', { text: ' of it came back somewhere else.' }),
      ]) : el('span', { text: 'None of it came back.' }),
    ]),
    el('div', { class: net < 0 ? 'good' : 'warn', style: 'font-weight:600' ,
      text: net < 0
        ? `Net, you are ${abs(net)} a month better off than before.`
        : `Net, you are ${abs(net)} a month worse off than before.` }),
  );

  const table = (rows, tone) => el('table', { class: 'table-responsive' }, [
    el('tbody', {}, rows.map((row) =>
      el('tr', {}, [
        el('td', { 'data-col': 'group', text: row.group }),
        el('td', { 'data-col': 'was', class: 'muted', text: `was ${money(row.before_per_month)}` }),
        el('td', { 'data-col': 'change', class: 'right' }, [
          el('span', { class: `amount ${tone}`, text: `${row.change_cents > 0 ? '+' : ''}${money(row.change_per_month)}` }),
        ]),
      ]),
    )),
  ]);

  if (data.cuts.length) {
    card.append(el('div', { class: 'muted', style: 'margin-top:0.6rem', text: 'Down' }), table(data.cuts, ''));
  }
  if (data.rises.length) {
    card.append(el('div', { class: 'muted', style: 'margin-top:0.6rem', text: 'Up' }), table(data.rises, 'out'));
  }
  box.append(card);
}

// Where the money that came back went. Places, not categories, because a
// category cannot be cancelled and a place can.
function moversSection(data) {
  const box = document.getElementById('movers');
  box.innerHTML = '';
  if (!data || !data.up.length) return;

  const card = el('div', { class: 'card stack' }, [
    el('h3', { style: 'margin:0', text: 'What grew' }),
    el('div', { class: 'muted', text: 'Where the cuts went.' }),
    el('table', { class: 'table-responsive' }, [
      el('tbody', {}, data.up.slice(0, 8).map((row) =>
        el('tr', {}, [
          el('td', { 'data-col': 'place' }, [
            el('div', { class: 'truncate', text: row.place }),
            row.what_it_is ? el('div', { class: 'muted truncate', text: row.what_it_is }) : null,
          ]),
          el('td', { 'data-col': 'times', class: 'muted', text: `${row.times_since} since` }),
          el('td', { 'data-col': 'change', class: 'right' }, [
            el('span', { class: 'amount out', text: `+${money(row.change_per_month)}` }),
            el('div', { class: 'muted', style: 'font-size:0.75rem', text: 'a month' }),
          ]),
        ]),
      )),
    ]),
  ]);

  // Said out loud rather than dropped. A bill paid once a year has no monthly
  // rate to compare, so it is not evidence either way about a change in
  // behaviour, but it did take the money.
  if (data.irregular?.length) {
    card.append(el('p', { class: 'muted', style: 'margin:0.3rem 0 0', text:
      'Left out because they are paid too rarely to compare: '
      + data.irregular.map((row) => `${row.place} ${formatAmount(row.spent)}`).join(', ')
      + '. Real money, but not a change in habit.' }));
  }
  box.append(card);
}

// What is owed, and when each one disappears.
//
// The mortgage is a fixture and is shown as one. The small debts are the
// motivating ones: each has a date it is gone and an amount that comes back
// every month afterwards, which is the same fact as the balance but in the unit
// that makes it feel finite.
function debtsSection(list) {
  const box = document.getElementById('debts');
  box.innerHTML = '';
  if (!list?.length) return;

  const owing = list.filter((row) => Number(row.owed) > 0);
  if (!owing.length) return;

  const rows = owing.map((row) => el('div', {
    style: 'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0.1rem 0.6rem;'
      + 'padding:0.5rem 0;border-bottom:1px solid var(--line)',
  }, [
    el('div', { class: 'truncate', style: 'font-weight:500', text: row.name }),
    el('div', { class: 'amount out', style: 'text-align:right;white-space:nowrap', text: money(row.owed) }),
    el('div', { class: 'muted', style: 'font-size:0.8rem', text:
      !row.regular
        // Too few payments to call it a rate. Say what was actually observed.
        ? `${money(row.per_year)} paid over ${row.payments_seen} payment${row.payments_seen === 1 ? '' : 's'} in the last year`
        : row.cleared_on_friendly
          ? `Gone ${row.cleared_on_friendly}, then ${money(row.per_month)} a month comes back`
          : 'Long term, not a countdown' }),
    el('div', { class: 'muted', style: 'text-align:right;white-space:nowrap;font-size:0.8rem',
      text: row.regular && Number(row.per_month) > 0 ? `${money(row.per_month)} a month` : '' }),
  ]));

  const card = el('div', { class: 'card stack' }, [
    el('h3', { style: 'margin:0', text: 'What you owe' }),
    el('div', { class: 'muted', text: 'Not spending. It still leaves the account.' }),
    el('div', {}, rows),
  ]);

  // The near ones, with what clearing them gives back.
  const soon = owing.filter((row) => row.months_left !== null && row.months_left <= 24);
  if (soon.length) {
    const freed = soon.reduce((total, row) => total + Number(String(row.per_month).replace(/[^0-9.]/g, '')), 0);
    card.append(el('p', { class: 'good', style: 'margin:0.3rem 0 0;font-weight:600', text:
      `${soon.map((row) => `${row.name.split(',')[0]} clears ${row.cleared_on_friendly}`).join(', ')}. `
      + `That is ${formatAmount(freed.toFixed(2))} a month back.` }));
    card.append(el('p', { class: 'muted', style: 'margin:0', text:
      'Assumes the current payment, ignores interest.' }));
  }

  // A card carried at zero is a line of credit, not a debt.
  const lines = list.filter((row) => row.unused_credit_line);
  if (lines.length) {
    card.append(el('p', { class: 'muted', style: 'margin:0.2rem 0 0', text:
      `${lines.map((row) => row.name).join(', ')}: nothing owing, kept open as a line of credit. `
      + 'The runway below does not count it, so there is more room than the date suggests.' }));
  }

  // A line of credit with nothing owing still shows if it cost something to keep.
  const feeOnly = list.filter((row) => row.unused_credit_line && Number(row.per_year) > 0);
  if (feeOnly.length) {
    card.append(el('p', { class: 'muted', style: 'margin:0', text:
      feeOnly.map((row) => `Keeping ${row.name} open cost ${money(row.per_year)} over the last year`).join('. ') + '.' }));
  }
  box.append(card);
}

// What a recurring cost is really worth.
//
// Subscriptions are priced monthly because a small monthly number is easy to
// agree to. That framing is doing work, and it is working against the person
// paying, so the year is shown next to the month. The runway column is the
// local currency: with money going out faster than it comes in, the honest
// price of anything is a piece of the time left.
async function whatToStop(data) {
  const box = document.getElementById('stop');
  box.innerHTML = '';

  const chosen = new Set();
  const result = el('div', { id: 'tradeOffResult', class: 'muted', style: 'min-height:1.4rem;margin-top:0.4rem' });

  async function recalculate() {
    if (!chosen.size) { result.textContent = ''; result.className = 'muted'; return; }
    const monthly = data.items
      .filter((item) => chosen.has(item.commitment_id))
      .reduce((total, item) => total + Number(String(item.per_month).replace(/[^0-9.]/g, '')), 0);
    result.textContent = 'Working it out...';
    try {
      // Only the commitment ids. Sending the monthly amount as well asked the
      // forecast to both stop the bill and cut the daily rate by the same
      // amount, so one 322 dollar subscription bought 22 days instead of 2.
      // The amount is still shown, it just is not a second lever.
      const moved = await api('/api/today/trade-off', {
        method: 'POST',
        body: { monthly: 0, commitment_ids: [...chosen] },
      });
      result.className = 'good';
      result.style.fontWeight = '600';
      result.textContent = moved.clears_the_gap
        ? 'That closes the gap entirely. Nothing runs out.'
        : `${moved.from_friendly} becomes ${moved.to_friendly}, ${moved.days_gained} more days, for ${formatAmount(monthly.toFixed(2))} a month.`;
    } catch (err) {
      result.className = 'warn';
      result.textContent = err.message;
    }
  }

  // One row per cost. Built as a grid rather than a table because five columns
  // on a phone becomes a jumble whichever way the table is told to reflow.
  const line = (item) => {
    const tick = el('input', { type: 'checkbox', style: 'margin:0' });
    tick.addEventListener('change', () => {
      if (tick.checked) chosen.add(item.commitment_id); else chosen.delete(item.commitment_id);
      recalculate();
    });
    return el('label', {
      class: 'item',
      style: 'display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;gap:0.15rem 0.7rem;'
        + 'align-items:center;cursor:pointer',
    }, [
      el('div', { style: 'grid-row:1/span 2' }, [tick]),
      // The tile says how hard this would be to stop, which the app has always
      // known and has never shown. One hue in three ordered steps: dark is a
      // bill you must pay, pale is a choice. Ordered, so it is a real encoding
      // rather than decoration, and the caption under the list says so.
      el('div', { class: `av ${tierOf(item)}`, style: 'grid-row:1/span 2',
        text: initialsOf(item.label) }),
      el('div', { class: 'truncate t', text: item.label }),
      // The year figure is the loud one. A subscription is priced monthly
      // because a small monthly number is easy to say yes to, and showing the
      // year next to it undoes exactly that framing.
      el('div', { class: 'amount out', style: 'text-align:right;white-space:nowrap', text: `${money(item.per_year)} a year` }),
      el('div', { class: 'truncate s', text: tierOf(item) === 'unknown'
        ? 'nothing has said whether this is optional'
        : item.what_it_is || item.category || '' }),
      // No per row day estimate. Working it out in closed form ignores the
      // paydays in between and came out about double what this app's own
      // projection says, and two numbers that disagree are worse than one.
      // Tick the row and the answer underneath is the real projection.
      el('div', { class: 'muted', style: 'text-align:right;white-space:nowrap;font-size:0.8rem' }, [
        el('span', { text: `${money(item.per_month)} a month` }),
      ]),
    ]);
  };

  const choice = data.items.filter((item) => !item.fixed);
  const fixed = data.items.filter((item) => item.fixed);

  const card = el('div', { class: 'card stack' }, [
    el('h3', { style: 'margin:0', text: 'What each one is really costing' }),
    el('div', { class: 'muted', text: 'Priced by the year. Tick to see what stopping it would do.' }),
    el('div', {}, choice.map(line)),
    result,
  ]);

  // The honest total, and the honest caveat with it. A page that let someone
  // cancel two subscriptions and feel the problem was handled would have done
  // them harm. The small stuff is real and it is worth having, and on a gap
  // this size it is not the answer, so both halves get said.
  const small = choice.filter((item) => Number(String(item.per_month).replace(/[^0-9.]/g, '')) < 60);
  if (small.length >= 5) {
    const yearly = small.reduce((total, item) => total + Number(String(item.per_year).replace(/[^0-9.]/g, '')), 0);
    const monthly = yearly / 12;
    const share = data.daily_gap_cents > 0
      ? Math.round((monthly * 100) / ((data.daily_gap_cents / 100) * 30.44))
      : null;
    card.append(el('p', { class: 'muted', style: 'margin:0.2rem 0 0' , text:
      `${small.length} of these are under ${money('60')} a month each. Together they are `
      + `${formatAmount(yearly.toFixed(2))} a year, which is worth having`
      + (share !== null ? `, and it is ${share}% of the gap. The rest has to come from the big items or from income.` : '.') }));
  }

  // Shown, because knowing the mortgage is forty seven thousand a year is worth
  // knowing. Listed apart, because a "what to stop" list whose first entry is
  // obviously not an option teaches you the list is not worth reading.
  if (fixed.length) {
    const body = el('div', { style: 'display:none' }, fixed.map(line));
    const toggle = el('button', { class: 'small', text: `Show the ${fixed.length} you cannot simply stop` });
    toggle.addEventListener('click', () => {
      const opening = body.style.display === 'none';
      body.style.display = opening ? '' : 'none';
      toggle.textContent = opening ? 'Hide those' : `Show the ${fixed.length} you cannot simply stop`;
    });
    card.append(el('hr'), toggle, body);
  }
  box.append(card);
}

// Decisions, with the "when" that makes them hold, and checked against the
// transactions rather than against a tick box.
function decisions(list, watchable) {
  const box = document.getElementById('decisions');
  box.innerHTML = '';

  const what = el('input', { placeholder: 'What will change', style: 'flex:2;min-width:10rem' });
  const when = el('input', { placeholder: 'When exactly (the trigger)', style: 'flex:2;min-width:10rem' });
  const worth = el('input', { placeholder: '$ a month', style: 'flex:1;min-width:8rem' });

  // Naming the place is what makes the decision checkable. Without it this is a
  // note to self, and the app says so rather than pretending otherwise.
  const watch = el('select', { style: 'flex:2;min-width:10rem' }, [
    el('option', { value: '', text: 'Nothing to watch (a note to self)' }),
    ...(watchable ?? []).map((item) =>
      el('option', { value: item.merchant_key ?? '', text: `Watch: ${item.label}` })),
  ]);

  const add = el('button', { class: 'primary', text: 'Decide it', style: 'white-space:nowrap' });
  add.addEventListener('click', async () => {
    if (!what.value.trim()) return showError('Say what will change');
    add.disabled = true;
    try {
      await api('/api/today/intentions', {
        method: 'POST',
        body: {
          what: what.value,
          trigger_text: when.value || null,
          target_monthly: worth.value || null,
          merchant_key: watch.value || null,
        },
      });
      what.value = ''; when.value = ''; worth.value = ''; watch.value = '';
      await load();
    } catch (err) {
      showError(err.message);
    } finally {
      add.disabled = false;
    }
  });

  const card = el('div', { class: 'card stack' }, [
    el('h3', { style: 'margin:0', text: 'Decisions' }),
    // The example pair from docs/behaviour.md rather than the maxim it was
    // shrunk into. "A decision with a when attached gets done, one without does
    // not" is a claim about people that this page cannot check, on the page
    // whose whole rule is that every line must be true and checkable.
    el('div', { class: 'muted', text:
      'What changes, and when exactly. "No delivery on weeknights" is a plan. '
      + '"Spend less on takeaway" is a mood.' }),
    // Wraps rather than squeezing. Five controls on one phone width turned
    // every placeholder into a truncated fragment.
    el('div', { class: 'row', style: 'flex-wrap:wrap' }, [what, when]),
    el('div', { class: 'row', style: 'flex-wrap:wrap' }, [watch, worth, add]),
  ]);

  if (list.length) {
    card.append(el('table', { class: 'table-responsive' }, [
      el('tbody', {}, list.map((item) =>
        el('tr', {}, [
          el('td', { 'data-col': 'what' }, [
            el('div', { text: item.what }),
            item.trigger_text ? el('div', { class: 'muted truncate', text: item.trigger_text }) : null,
          ]),
          el('td', { 'data-col': 'verdict' }, [
            el('span', { class: item.verdict === 'held' ? 'good' : item.verdict === 'still being charged' ? 'warn' : 'muted', text: item.verdict }),
            item.merchant_key ? el('div', { class: 'muted truncate', style: 'font-size:0.75rem', text: `watching ${item.merchant_key}` }) : null,
          ]),
          el('td', { 'data-col': 'worth', class: 'right muted', text: item.target_monthly ? `${money(item.target_monthly)} a month` : '' }),
        ]),
      )),
    ]));
  }
  box.append(card);
}

async function load() {
  try {
    const data = await api('/api/today');
    headline(data.position, data.curve, data.expecting);
    fortnight(data.period);
    stuck(data.stuck, data.change_point);
    moversSection(data.movers);
    debtsSection(data.debts);
    // The costs share the same loaded forecast model as the headline.
    decisions(data.intentions, data.costs.items.filter((item) => !item.fixed));
    await whatToStop(data.costs);
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

await load();
