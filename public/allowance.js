// How much a month for the things we do not have to buy.
//
// This is the one screen in the app that asks for a decision rather than
// reporting one, and for a long time it asked for it in a checkbox next to a
// number that started at zero. Nobody chose zero, and a forecast built on it
// described a household that buys no coffee, no haircut and no present, then
// reported the resulting surplus as money.
//
// So the page leads with the months. One number cannot say whether 3,200 a
// month is every month or the average of a quiet one and a bad one, and that is
// the difference between a figure someone can argue with and one they can only
// accept. The allowance is drawn across those months as a line: whether it sits
// above or below the life you have actually had is the whole decision, and it
// moves as you pick.
import { api, el, formatAmount, renderNav, showError } from '/app.js';

renderNav('/allowance');

const money = (value) => formatAmount(value);
const MONTH_LETTERS = 'JFMAMJJASOND';

let data = null;
let picked = null;      // cents, or null for "follow what we spend"
let previewing = false;

// The figure the line is drawn at: whatever is picked, else what is in force.
// Cents here are geometry, not money: nothing on this page is added up in the
// browser, it is all asked of the projection and printed as it comes back.
const lineCents = () => (picked ?? Math.round(Number(current().per_month) * 100));
const current = () => (previewCard() ?? data.now);
const previewCard = () => (picked === null ? null : data.preview);

// --- the chart ------------------------------------------------------------

function chart() {
  const months = data.months;
  const odd = new Set((data.outliers ?? []).map((row) => row.month));
  // Scaled to the tallest ordinary month, with a little air above it.
  //
  // Not to the tallest thing on the chart. Letting one 11,000 dollar month or
  // an allowance seven times any of them set the scale flattens the other
  // eleven into stubs, and those eleven are the entire reason for drawing this.
  // Anything above the ceiling is drawn cut off instead, which keeps it on the
  // chart and says plainly that it does not fit.
  const ordinary = months
    .filter((row) => row.complete && !odd.has(row.month))
    .map((row) => row.spent_cents);
  const ceiling = Math.max(Math.round(Math.max(...ordinary, 1) * 1.15), 1);

  const plot = el('div', { class: 'plot' });
  for (const row of months) {
    const over = row.spent_cents > ceiling;
    const height = over ? 100 : (row.spent_cents / ceiling) * 100;
    plot.append(el('div', { class: 'band' }, [
      el('i', {
        class: over ? 'over' : (row.complete ? null : 'part'),
        style: `height:${Math.max(height, 2).toFixed(1)}%`,
        title: `${row.month}: ${money(row.spent)}${row.complete ? '' : ', still running'}`,
      }),
    ]));
  }

  // The line carries the only number on the chart. What a cut off month was
  // worth is said in words underneath, where it has room to say what to do
  // about it, rather than as a second figure fighting this one for the same
  // corner of the plot.
  const above = lineCents() > ceiling;
  if (above) plot.classList.add('clipped');
  const at = Math.min((lineCents() / ceiling) * 100, 100);
  plot.append(el('div', { class: 'line', style: `bottom:${at.toFixed(1)}%` }, [
    el('span', { text: money((lineCents() / 100).toFixed(2)) }),
  ]));

  const ticks = el('div', { class: 'ticks' }, months.map((row) => {
    const month = Number(row.month.slice(5, 7));
    return el('span', {
      class: month === 1 || row.month === months.at(-1).month ? 'mark' : null,
      text: MONTH_LETTERS[month - 1],
      title: row.month,
    });
  }));

  return el('div', { class: 'months' }, [plot, el('div', { class: 'base' }), ticks]);
}

// --- the head -------------------------------------------------------------

function renderHead() {
  const view = current();
  // Three states, and the middle one matters: a number being tried is not a
  // number in force. Saying "you chose this" over a figure nothing has been
  // saved at would be the page telling its first lie.
  const state = previewing
    ? ['warning', 'Trying this out, not saved']
    : data.allowance.chosen
      ? ['accent', 'A number you chose']
      : ['neutral', 'Following what you spend'];
  const head = document.getElementById('head');
  head.innerHTML = '';
  head.append(el('div', { class: 'card' }, [
    el('span', { class: 'state' }, [
      el('span', { class: 'dot', style: `background:var(--${state[0]})` }),
      el('span', { text: state[1] }),
    ]),
    el('div', { class: 'figure', text: money(view.per_month) }),
    el('div', { class: 'delta' }, [
      el('span', { class: 'q', text: 'a month for things you do not have to buy' }),
    ]),
    el('div', { style: 'margin-top:20px' }, chart()),
    el('p', { class: 'muted small', style: 'margin:12px 0 0',
      text: `The last ${data.months.length} months, the last of them still running. `
        + 'The line is the allowance.' }),
  ]));
}

// --- what it does ---------------------------------------------------------

// The consequence, in the two numbers the rest of the app leads with. Both come
// back from the real projection, so this page and Home cannot disagree.
function renderNote() {
  const view = current();
  const backwards = view.going_backwards;
  const note = document.getElementById('note');
  note.innerHTML = '';

  const rows = [
    el('div', { class: 'item' }, [
      el('span', { class: 'grow' }, [
        el('span', { class: 't', text: 'Goes out each month' }),
        el('span', { class: 's', text: 'everything, including this allowance' }),
      ]),
      el('span', { class: 'amount', text: money(view.out_per_month) }),
    ]),
    el('div', { class: 'item' }, [
      el('span', { class: 'grow' }, [
        el('span', { class: 't', text: backwards ? 'Short each month' : 'Left over each month' }),
        el('span', { class: 's', text: backwards
          ? (view.runway_date_friendly ? `runs out ${view.runway_date_friendly}` : 'more goes out than comes in')
          : 'more comes in than goes out' }),
      ]),
      el('span', { class: `amount ${backwards ? 'out' : 'in'}`,
        text: money(String(view.gap_per_month).replace('-', '')) }),
    ]),
  ];

  note.append(
    el('div', { class: 'sec', text: previewing ? 'What that would mean' : 'What this means' }),
    el('div', { class: 'card flush' }, rows),
  );

  // One month unlike all the others is one purchase, and the answer to that is
  // to mark the purchase, not to pick a lower allowance and hope.
  if (data.outlier) {
    note.append(el('div', { class: 'nudge', style: 'margin-top:12px' }, [
      el('h3', { text: `${friendlyMonth(data.outlier.month)} was ${money(data.outlier.spent)}` }),
      el('p', { text: 'Many times any other month, so it is probably one purchase rather than '
        + 'a habit. Marking it as a one off keeps it in the history and out of the rate.' }),
      el('a', { class: 'btn', href: monthLink(data.outlier.month), text: 'Find it',
        style: 'margin-top:11px' }),
    ]));
  }
}

// The transactions page reads from and to off the query string, so this lands
// on the month rather than on eight thousand rows.
function monthLink(key) {
  const [year, month] = key.split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `/transactions?from=${key}-01&to=${key}-${String(last).padStart(2, '0')}`;
}

function friendlyMonth(key) {
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
}

// --- choosing -------------------------------------------------------------

function renderPick() {
  const box = document.getElementById('pick');
  box.innerHTML = '';

  // Every anchor is a figure the household has already lived. A choice between
  // measured things beats a choice between a number and a hope.
  const anchors = [
    data.typical_month && ['typical', 'A usual month', data.typical_month.spent,
      friendlyMonth(data.typical_month.month)],
    data.quietest && ['quietest', 'The quietest', data.quietest.spent,
      friendlyMonth(data.quietest.month)],
    ['measured', 'What it has been', data.typical.per_month,
      `average of ${data.typical.effective_days} days`],
  ].filter(Boolean);

  const amount = el('input', {
    type: 'number', min: '0', step: '10', style: 'max-width:11rem',
    value: (lineCents() / 100).toFixed(2),
  });

  // Compared as 2dp text, so a tile lighting up never depends on arithmetic.
  const tiles = el('div', { class: 'picks' }, anchors.map(([, title, value, note]) =>
    el('button', {
      type: 'button',
      'aria-current': previewing && amount.value === Number(value).toFixed(2) ? 'true' : null,
      onClick: () => { amount.value = Number(value).toFixed(2); preview(Number(value).toFixed(2)); },
    }, [
      el('span', { class: 't', text: money(value) }),
      el('span', { class: 's', text: `${title}, ${note}` }),
    ])));

  const save = el('button', { class: 'primary', text: 'Use this number' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await api('/api/forecast/policy', {
        method: 'POST',
        body: { discretionary_monthly: Number(amount.value || 0).toFixed(2) },
      });
      picked = null;
      await load();
    } catch (err) {
      showError(err.message);
      save.disabled = false;
    }
  });

  const cancel = el('button', { text: 'Leave it as it is', onClick: () => load() });

  const follow = el('button', { text: 'Follow what we spend' });
  follow.addEventListener('click', async () => {
    follow.disabled = true;
    try {
      await api('/api/forecast/policy', { method: 'POST', body: { follow_history: true } });
      picked = null;
      await load();
    } catch (err) {
      showError(err.message);
      follow.disabled = false;
    }
  });

  amount.addEventListener('change', () => preview(Number(amount.value || 0).toFixed(2)));

  box.append(
    el('div', { class: 'sec', text: 'Pick a number' }),
    el('div', { class: 'card stack' }, [
      tiles,
      el('div', { class: 'row', style: 'gap:10px;flex-wrap:wrap' }, [
        el('label', { style: 'flex:none', text: 'or' }),
        amount,
        el('span', { class: 's', style: 'margin:0', text: 'a month' }),
      ]),
      el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;margin-top:4px' }, [
        save,
        previewing ? cancel : null,
        data.allowance.chosen && !previewing ? follow : null,
      ]),
    ]),
  );
}

// --- loading --------------------------------------------------------------

// The preview is the same projection the rest of the app runs, asked what it
// would say at this number. Nothing on this page is worked out in the browser.
async function preview(value) {
  try {
    const next = await api(`/api/forecast/allowance?at=${encodeURIComponent(value)}`);
    data = next;
    picked = Math.round(Number(value) * 100);
    previewing = true;
    draw();
  } catch (err) {
    showError(err.message);
  }
}

function draw() {
  renderHead();
  renderPick();
  renderNote();
}

async function load() {
  try {
    data = await api('/api/forecast/allowance');
    picked = null;
    previewing = false;
    draw();
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

await load();
