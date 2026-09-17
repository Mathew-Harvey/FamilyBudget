// The recurring costs, the curve they make, and the two ways to correct it.
//
// The page used to open on a dropdown. Under it, "Household runway: beyond 90
// days" in the colour used for good news, which was the dropdown reading itself
// back: this household runs out of money on 7 September 2027, and at every
// setting below a year the page said it did not. A control may decide how much
// of the curve you are shown. It may not decide what is true, so the household
// answer comes from a fixed horizon now and the look ahead sits with the chart,
// which is the only thing it changes.
import { api, el, formatAmount, formatDay, renderNav, showError, pageIntro } from '/app.js';
import { cashChart } from '/chart.js';

renderNav('/forecast');
pageIntro('Recurring costs',
  'The bills that repeat, the cash curve they make, and what to do about a '
  + 'purchase that is never happening again.');

const excluded = new Set();
let data = null;

const money = (value) => formatAmount(value);
const abs = (value) => formatAmount(String(value).replace('-', ''));

// --- where the household stands -------------------------------------------

// The same reading Today and the plan lead with, from the same projection
// length, so the three pages cannot give three answers to one question.
function renderHead() {
  const view = data.household;
  const behind = view.going_backwards;
  const runsOut = Boolean(view.runway_date_friendly);
  const head = document.getElementById('head');
  head.innerHTML = '';

  const card = el('div', { class: 'card' }, [
    el('span', { class: `state ${behind ? (runsOut ? 'bad' : 'warn') : 'ok'}` }, [
      el('span', { class: 'dot' }),
      el('span', { text: view.is_scenario
        ? (behind ? 'On this scenario, the money still runs out' : 'On this scenario, more comes in than goes out')
        : (behind
          ? (runsOut ? 'Spendable cash runs out' : 'Spending a little more than comes in')
          : 'More is coming in than going out') }),
    ]),
    runsOut
      ? el('div', { class: 'figure date', text: view.runway_date_friendly })
      : el('div', { class: 'figure', text: abs(view.gap_per_month) }),
    runsOut
      ? el('div', { class: 'delta down' }, [
          el('span', { text: `${view.runway_days} days ` }),
          el('span', { class: 'q', text: `from today, at ${abs(view.gap_per_month)} a month more out than in` }),
        ])
      : el('div', { class: `delta ${behind ? 'down' : 'up'}` }, [
          el('span', { text: `${behind ? '↓' : '↑'} a month ` }),
          el('span', { class: 'q', text: behind
            ? 'more goes out than comes in, though not enough to run the balance down'
            : 'left over, after everything that repeats' }),
        ]),
    // Where the balance goes, which is what the look ahead actually changes.
    //
    // Past a crossing there is no balance to report. The chart already drops
    // its endpoint figure there, because no account holds minus seven hundred
    // dollars, and this line was printing exactly that one row above it: "takes
    // it to $761.91, dipping to -$718.88" under a headline saying the money ran
    // out in September. Same rule, same reason.
    el('p', { class: 'muted small', style: 'margin:12px 0 0', text: data.runway_date
      ? `${money(data.opening_balance)} spendable today, and on this plan it is gone `
        + `within the ${data.days} days drawn below. What the balance does after that `
        + 'is not a number worth printing.'
      : `${money(data.opening_balance)} spendable today. Over the next ${data.days} days this plan `
        + `takes it to ${money(data.closing_balance)}, dipping to ${money(data.lowest_balance)} `
        + `on ${formatDay(data.lowest_date)}.` }),
  ]);

  if (data.series?.length > 1) {
    card.append(cashChart(data.series, { height: 240, runwayDate: data.runway_date }));
  }

  // Beside the thing it controls, and folded, because the default is right for
  // almost everyone and this was the first thing on the page.
  const days = el('select', { onChange: (event) => { look.days = event.target.value; load(); } },
    [['30', '30 days'], ['90', '90 days'], ['180', '180 days'], ['365', 'a year']]
      .map(([value, text]) => el('option', { value, text, selected: value === look.days })));
  const buffer = el('input', { type: 'number', step: '50', value: look.buffer, style: 'width:7rem' });
  buffer.addEventListener('change', () => { look.buffer = buffer.value || '0'; load(); });

  card.append(el('details', { style: 'margin-top:14px' }, [
    el('summary', { class: 'muted small', text: `Showing ${data.days} days` }),
    el('div', { class: 'filters', style: 'margin-top:12px' }, [
      el('div', {}, [el('label', { text: 'Look ahead' }), days]),
      el('div', {}, [el('label', { text: 'Keep a buffer of' }), buffer]),
    ]),
    el('p', { class: 'muted small', style: 'margin:10px 0 0', text:
      'A buffer is cash you do not want to dip into, so the money "runs out" when '
      + 'it reaches that instead of zero. Neither of these changes the answer above, '
      + 'which is worked out over '
      + `${data.household.horizon_days} days however much of it is drawn here.` }),
  ]));

  head.append(card);
}

// --- what is coming up ----------------------------------------------------

function periodRow(period, index) {
  const income = Number(period.income);
  const left = Number(period.left_over);
  // Length is what survives the period, not what leaves it. Drawn the other way
  // round the fortnight with the most spending in it had the longest bar, in
  // the colour used for good news, which is praise for spending.
  const share = income > 0 ? Math.max(Math.min(left / income, 1), 0) : 0;

  const when = index === 0
    ? `Until ${formatDay(period.ends)}`
    : `${formatDay(period.starts)} to ${formatDay(period.ends)}`;

  const rows = period.events.map((event) => el('div', { class: 'item' }, [
    el('span', { class: 'grow' }, [
      el('span', { class: 't truncate', text: event.label }),
      el('span', { class: 's', text: formatDay(event.date) }),
    ]),
    el('span', { class: `amount ${event.amount_cents > 0 ? 'in' : 'out'}`, text: money(event.amount) }),
  ]));
  // Not a bill anybody sent, so it is named as the rate it is rather than
  // dropped, which would leave the listed rows short of the total above them.
  rows.push(el('div', { class: 'item' }, [
    el('span', { class: 'grow' }, [
      el('span', { class: 't', text: 'Everyday spending' }),
      el('span', { class: 's', text: 'groceries, fuel and the allowance, at the projected rate' }),
    ]),
    el('span', { class: 'amount out', text: money(`-${period.everyday}`) }),
  ]));

  const detail = el('div', { class: 'inside', style: 'display:none' }, rows);

  const line = el('div', { class: 'item', style: 'cursor:pointer' }, [
    el('span', { class: 'grow' }, [
      el('span', { class: 't' }, [
        el('span', { text: when }),
        period.partial
          ? el('span', { class: 'note', style: 'margin-left:8px', text: 'part of a period' })
          : null,
      ]),
      el('span', { class: 's', text: income > 0
        ? `${money(period.income)} in, ${money(period.out)} out`
        : `${money(period.out)} out, no pay lands in this stretch` }),
      // No bar at all when no pay lands in the stretch. A full red one is the
      // loudest mark on the page and it would be pointing at a week that is
      // merely waiting for payday, which is the Today period card's rule: say
      // no pay has landed rather than dressing arithmetic as a warning.
      income > 0
        ? el('div', { class: 'track' }, [
            el('i', { style: left < 0
              ? 'width:100%;background:var(--out)'
              : `width:${(share * 100).toFixed(1)}%;background:var(--in)` }),
          ])
        : null,
    ]),
    el('span', { style: 'text-align:right' }, [
      el('span', { class: `amount ${left < 0 ? 'out' : 'in'}`, text: money(period.left_over) }),
      el('span', { class: 's', text: `${money(period.closing)} left` }),
    ]),
  ]);
  line.addEventListener('click', () => {
    detail.style.display = detail.style.display === 'none' ? '' : 'none';
  });

  return el('div', {}, [line, detail]);
}

function renderPeriods() {
  const box = document.getElementById('periods');
  box.innerHTML = '';
  if (!data.periods?.length) {
    box.append(el('p', { class: 'empty', text: 'Nothing scheduled in this window.' }));
    return;
  }
  box.append(el('div', { class: 'card flush' }, data.periods.map(periodRow)));
}

// --- what it is built on --------------------------------------------------

// A link belongs in the caption, not in a column of its own. As a button
// between the label and the amount it took a fixed width out of the middle of
// the row, which on a phone squeezed "Optional allowance" onto two lines and
// its caption onto three.
function assumption(title, caption, amount, link = null) {
  return el('div', { class: 'item' }, [
    el('span', { class: 'grow' }, [
      el('span', { class: 't', text: title }),
      el('span', { class: 's' }, [
        el('span', { text: link ? `${caption}. ` : caption }),
        link ? el('a', { href: link.href, text: link.text }) : null,
      ]),
    ]),
    el('span', { class: 'amount', text: amount }),
  ]);
}

function renderAssumes() {
  const box = document.getElementById('assumes');
  const rate = data.projected_everyday_rate;
  const luxury = data.luxury;
  box.innerHTML = '';

  const rows = [
    // The link to the pay that has not started yet. A wage beginning in March
    // is this row's future and it changes the curve above, and it was reachable
    // from one row of the Set up index and nowhere else.
    assumption('Money coming in',
      `${data.expected_income.source}, ${data.cycle?.cadence || 'each period'}`,
      money(data.expected_income.amount),
      { href: '/plan#expecting', text: 'Expecting more?' }),
    assumption('Essential spending',
      `a day, from the last ${data.spend_window_days} days`,
      money(rate.essential_per_day)),
    assumption('Optional allowance',
      'a month, the one figure the whole app plans against',
      money(luxury.allowance_per_month),
      { href: '/allowance', text: 'Change it' }),
  ];

  if (luxury.active_commitments.length) {
    rows.push(assumption('Optional subscriptions',
      `a month, across ${luxury.active_commitments.length} judged optional on the Spending page`,
      money(luxury.included_commitments_per_month)));
  }

  box.append(el('div', { class: 'card flush' }, rows));

  const notes = [];
  if (Number(data.everyday_rate.irregular_essential) > 0) {
    notes.push(`${money(data.everyday_rate.irregular_essential)} of the essential spending is at `
      + 'places seen on fewer than three dates: vets, registrations, repairs. None of them is '
      + 'quoted a monthly rate, and the total is in the projection anyway, because something in '
      + 'that shape happens most months even though it is never the same thing twice.');
  }
  if (Number(luxury.historical_variable_per_month) !== Number(luxury.allowance_per_month)) {
    notes.push(`Optional day to day spending has actually been running at `
      + `${money(luxury.historical_variable_per_month)} a month. The plan uses the allowance instead.`);
  }
  for (const text of notes) {
    box.append(el('p', { class: 'muted small', style: 'margin:10px 0 0', text }));
  }

  // The scenario control. Turning one off asks what the curve looks like
  // without it, which is the only honest thing a tick box can do here: it
  // cannot cancel anything, and the money keeps leaving until somebody does.
  if (luxury.active_commitments.length) {
    const picks = luxury.active_commitments.map((commitment) => {
      const toggle = el('input', {
        type: 'checkbox',
        checked: commitment.included,
        onChange: (event) => {
          if (event.target.checked) excluded.delete(String(commitment.id));
          else excluded.add(String(commitment.id));
          load();
        },
      });
      return el('label', { class: 'item', style: 'cursor:pointer' }, [
        toggle,
        el('span', { class: 'grow' }, [
          el('span', { class: 't', text: commitment.label }),
          el('span', { class: 's', text: 'judged optional, on the Spending page' }),
        ]),
        el('span', { class: 'amount', text: `${money(commitment.per_month)} a month` }),
      ]);
    });
    box.append(el('details', { class: 'card', style: 'margin-top:12px' }, [
      el('summary', { text: excluded.size
        ? `Without ${excluded.size} of them` : 'What if we stopped some of these' }),
      el('p', { class: 'muted small', style: 'margin:12px 0 0', text:
        'Unticking one takes it out of the curve above so you can see the shape without '
        + 'it. Nothing is cancelled and nothing is saved until somebody cancels it.' }),
      el('div', { class: 'card flush', style: 'margin-top:10px' }, picks),
    ]));
  }

  // A default is not a finding. These reach the optional tier because nothing
  // has ever judged them, and the projection is already treating them as
  // optional, so they are named rather than offered as a saving.
  if (luxury.unjudged_commitments.length) {
    box.append(
      el('p', { class: 'muted small', style: 'margin:12px 0 0' }, [
        el('span', { text: `${money(luxury.unjudged_per_month)} a month across `
          + `${luxury.unjudged_commitments.length} bill`
          + `${luxury.unjudged_commitments.length === 1 ? ' is' : 's are'} being treated as optional `
          + 'because nothing has said otherwise: '
          + `${luxury.unjudged_commitments.map((row) => row.label).join(', ')}. ` }),
        el('a', { href: '/spending', text: 'Say which they are' }),
      ]),
    );
  }
}

// --- the commitments themselves -------------------------------------------

// The Spending page's words, because that is where the judgement is made and a
// commitment described as "essential" here and filed under "Must pay" there is
// two names for one thing.
const TIER_WORD = {
  keep: 'must pay',
  trim: 'could trim',
  cut: 'optional',
  unknown: 'nothing has said whether this is optional',
};

// Two letters from the name the household would recognise, the same tile the
// Spending page and Today use. The tier is the colour it is drawn in, not a
// two letter code of its own: "Ke", "Tr" and "Op" were a fourth vocabulary for
// something that already reads as a word in the line underneath.
function initialsOf(label) {
  const words = String(label || '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/);
  if (!words[0]) return '??';
  const first = words[0];
  return (words.length > 1 ? first[0] + words[1][0] : first.slice(0, 2)).toUpperCase();
}

function tierOf(commitment) {
  if (!commitment.active) return 'unknown';
  if (commitment.tier === 'cut' && commitment.tier_source === 'default') return 'unknown';
  return ['keep', 'trim', 'cut'].includes(commitment.tier) ? commitment.tier : 'unknown';
}

function commitmentRow(commitment) {
  const tier = tierOf(commitment);
  const word = TIER_WORD[tier];

  const toggle = el('input', {
    type: 'checkbox',
    checked: commitment.active,
    onChange: async (event) => {
      try {
        await api(`/api/forecast/commitments/${commitment.id}`, {
          method: 'POST', body: { active: event.target.checked },
        });
        showError('');
        await load();
      } catch (err) {
        showError(err.message);
      }
    },
  });

  const detail = el('div', { style: 'display:none;padding:12px 16px;border-top:1px solid var(--line)' }, [
    el('label', { class: 'row', style: 'gap:9px;margin:0' }, [
      toggle,
      el('span', { class: 'small', text: 'Really does repeat, keep it in the projection' }),
    ]),
    el('p', { class: 'muted small', style: 'margin:10px 0 0', text:
      `${commitment.source === 'manual' ? 'Added by hand' : `Seen ${commitment.occurrences} times`}`
      + `, about every ${commitment.cadence_days} days`
      + `${commitment.category_name ? `, filed under ${commitment.group_name} / ${commitment.category_name}` : ''}`
      + `${commitment.is_debt ? '. Paying down one of our own debts, so it is essential whatever else says' : ''}.` }),
    commitment.name !== commitment.label
      ? el('p', { class: 'muted small', style: 'margin:6px 0 0', text: `The bank calls it: ${commitment.label}` })
      : null,
  ]);

  const line = el('div', { class: `item${commitment.active ? '' : ' muted'}`, style: 'cursor:pointer' }, [
    el('span', { class: `av ${tier}`, text: initialsOf(commitment.name) }),
    el('span', { class: 'grow' }, [
      el('span', { class: 't truncate', text: commitment.name }),
      el('span', { class: 's', text: commitment.active
        ? `${word}, next ${formatDay(commitment.next_due)}`
        : 'turned off, not in the projection' }),
    ]),
    el('span', { style: 'text-align:right' }, [
      el('span', { class: 'amount out', text: money(commitment.typical_amount) }),
      commitment.per_month
        ? el('span', { class: 's', text: `${money(commitment.per_month)} a month` })
        : null,
    ]),
  ]);
  line.addEventListener('click', () => {
    detail.style.display = detail.style.display === 'none' ? '' : 'none';
  });

  return el('div', {}, [line, detail]);
}

async function renderCommitments() {
  const { commitments } = await api('/api/forecast/commitments');
  const box = document.getElementById('commitments');
  box.innerHTML = '';
  if (!commitments.length) {
    box.append(el('p', { class: 'empty', text: 'Nothing repeating has been found yet.' }));
    return;
  }
  const active = commitments.filter((row) => row.active);
  const total = active.reduce((sum, row) => sum + Number(row.per_month || 0), 0);
  box.append(
    el('p', { class: 'muted small', style: 'margin:-4px 0 10px', text:
      `${active.length} of them, ${formatAmount(total.toFixed(2))} a month between them. `
      + 'Turn one off if it is not really a commitment.' }),
    el('div', { class: 'card flush' }, commitments.map(commitmentRow)),
  );
}

// --- one offs -------------------------------------------------------------

async function renderOneOffs() {
  const box = document.getElementById('oneOffs');
  const { candidates } = await api('/api/spending/one-off-candidates');
  box.innerHTML = '';
  if (!candidates.length) {
    box.append(el('p', { class: 'empty', text: 'Nothing large enough to ask about.' }));
    return;
  }
  box.append(el('div', { class: 'card flush' }, candidates.slice(0, 12).map((row) => {
    const mark = el('button', {
      class: row.one_off ? 'small' : 'primary small',
      text: row.one_off ? 'Put it back' : 'A one off',
    });
    mark.addEventListener('click', async () => {
      mark.disabled = true;
      try {
        await api('/api/spending/one-off', {
          method: 'POST', body: { ids: [row.id], one_off: !row.one_off },
        });
        showError('');
        await renderOneOffs();
        await load();
      } catch (err) {
        showError(err.message);
        mark.disabled = false;
      }
    });
    return el('div', { class: 'item' }, [
      el('span', { class: 'grow' }, [
        el('span', { class: 't truncate', text: row.place }),
        el('span', { class: 's', text: `${formatDay(row.txn_date)}, paid on ${row.days_paid} `
          + `day${row.days_paid === 1 ? '' : 's'}${row.category ? `, ${row.category}` : ''}`
          + `${row.one_off ? ', out of the rate' : ''}` }),
      ]),
      el('span', { class: `amount ${row.one_off ? 'muted' : 'out'}`, text: money(row.amount) }),
      mark,
    ]);
  })));
}

// --- wiring ---------------------------------------------------------------

const look = { days: '90', buffer: '0' };

async function load() {
  try {
    const params = new URLSearchParams({ days: look.days, buffer: look.buffer });
    if (excluded.size) params.set('exclude_commitments', [...excluded].join(','));
    data = await api(`/api/forecast?${params}`);
    renderHead();
    renderPeriods();
    renderAssumes();
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

document.getElementById('redetect').addEventListener('click', async () => {
  const state = document.getElementById('detectState');
  state.textContent = 'Looking...';
  try {
    const { found } = await api('/api/forecast/commitments/detect', { method: 'POST' });
    state.textContent = `${found} recurring outgoings found.`;
    await load();
    await renderCommitments();
  } catch (err) {
    showError(err.message);
  }
});

try {
  await load();
  await renderOneOffs();
  await renderCommitments();
} catch (err) {
  showError(err.message);
}
