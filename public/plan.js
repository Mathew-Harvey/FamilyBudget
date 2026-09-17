// What we can change.
//
// Home says where the money stands. This is every lever in one place, ordered
// by what it is worth, with the curve at the top moving as you tick: what to
// stop, what to spend less on, the allowance, money that has not started yet,
// things that could be sold, and the decisions already taken. They were spread
// over five pages, and the one somebody needed, a second wage starting in
// January, was on the one page nobody could find.
//
// Two rules from docs/behaviour.md hold here. Name what goes: every saving is a
// list of actual things, so it can be argued with. And say when it is not
// enough: a page that let somebody tick two subscriptions and believe the
// problem was handled would be doing them harm, so the head says what the
// ticks are worth against the gap and the floor says whether all of it is.
//
// No arithmetic on money happens here. A tick re-asks the server, which
// re-projects, and every figure on the page comes back from that.
import { api, el, formatAmount, formatDay, renderNav, showError } from '/app.js';
import { cashChart } from '/chart.js';

renderNav('/plan');

const money = (value) => formatAmount(value);
const abs = (value) => formatAmount(String(value).replace('-', ''));
const cents = (value) => Math.round(Number(value ?? 0) * 100);

// What is ticked. Null until the first payload arrives, which seeds it with the
// whole plan. After that every change is sent back rather than worked out here.
let ticks = null;
let data = null;

function query() {
  if (!ticks) return '';
  const params = new URLSearchParams({
    stop: [...ticks.stop].join(','),
    allowance: ticks.allowance,
    trim: String(ticks.trim),
  });
  return `?${params}`;
}

// Two letters from the name, the same tile Spending and Home use.
function initialsOf(label) {
  const words = String(label || '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/);
  if (!words[0]) return '??';
  const first = words[0];
  return (words.length > 1 ? first[0] + words[1][0] : first.slice(0, 2)).toUpperCase();
}

// "every 14 days" is arithmetic; a fortnight is a thing that happens.
function howOften(days) {
  const n = Number(days);
  if (n === 7) return 'weekly';
  if (n === 14) return 'fortnightly';
  if (n >= 28 && n <= 31) return 'monthly';
  if (n >= 88 && n <= 95) return 'quarterly';
  if (n >= 360 && n <= 370) return 'yearly';
  return `every ${n} days`;
}

const isShort = (plan) => {
  // Positive is going backwards. Read off the sign of the string rather than
  // multiplying by 100, which would be float arithmetic on an amount to answer
  // a question about a minus sign.
  const gapText = String(plan.now.gap_per_month ?? '0');
  return !gapText.startsWith('-') && Number(gapText) > 0;
};

// --- the diagram, for the deficit case only --------------------------------

// The track is the gap. Each step fills part of it. What is left unfilled is
// what cutting cannot reach, drawn hatched because it is the absence of an
// answer and not a fourth kind of saving.
const TONE = { optional: 'cut', trim: 'trim' };
const SHORT = { optional: 'Optional costs', trim: 'Trimming' };

function gapDiagram(plan, short) {
  const gap = cents(plan.now.gap_per_month);
  const steps = plan.steps;
  if (!short || gap <= 0 || !steps.length) return null;
  let running = 0;
  const segments = steps.map((step) => {
    const total = Math.min(cents(step.saves_per_month), gap);
    const added = Math.max(total - running, 0);
    running = Math.max(running, total);
    return { key: step.key, added };
  }).filter((segment) => segment.added > 0);
  const shortfall = Math.max(gap - running, 0);
  return el('div', { style: 'margin-top:14px' }, [
    el('div', { class: 'split', style: 'height:22px' }, [
      ...segments.map((segment) => el('i', {
        style: `flex:${segment.added};background:var(--tier-${TONE[segment.key] ?? 'trim'})`,
      })),
      shortfall > 0 ? el('i', { class: 'unreachable', style: `flex:${shortfall}` }) : null,
    ]),
    el('div', { class: 'keys' }, [
      ...segments.map((segment, index) => el('span', {}, [
        el('i', { style: `background:var(--tier-${TONE[segment.key] ?? 'trim'})` }),
        el('span', { text: `${SHORT[segment.key] ?? steps[index].title} ` }),
        el('b', { text: money((segment.added / 100).toFixed(2)) }),
      ])),
      shortfall > 0 ? el('span', {}, [
        el('i', { class: 'unreachable' }),
        el('span', { text: 'Cutting cannot reach ' }),
        el('b', { text: money((shortfall / 100).toFixed(2)) }),
      ]) : null,
    ]),
  ]);
}

// --- the head -------------------------------------------------------------

// Where the household stands, and what the ticks below are worth. The curve is
// the money with what is ticked as the ink line and the money as it is as the
// dashed one, so the worth of the ticks is a distance rather than a sentence.
function renderHead() {
  const plan = data.plan;
  const short = isShort(plan);
  const chosen = plan.chosen;
  const head = document.getElementById('head');
  head.innerHTML = '';

  let verdict;
  if (!short) {
    verdict = cents(chosen.saves_per_month) > 0
      ? `${money(chosen.saves_per_month)} a month more left over with what is ticked.`
      : 'Nothing is ticked, so the two lines are one.';
  } else if (chosen.lasts) {
    verdict = 'With what is ticked this balances. Nothing runs out.';
  } else if (chosen.beyond_horizon) {
    verdict = `With what is ticked it lasts past ${chosen.horizon_date_friendly}, `
      + `still ${money(chosen.still_short_per_month)} a month short.`;
  } else {
    verdict = `With what is ticked it runs out ${chosen.runway_date_friendly}, `
      + `still ${money(chosen.still_short_per_month)} a month short.`;
  }

  head.append(el('div', { class: 'card' }, [
    el('span', { class: `state ${short ? 'bad' : 'ok'}` }, [
      el('span', { class: 'dot' }),
      el('span', { text: short ? 'Going backwards' : 'More is coming in than going out' }),
    ]),
    el('div', { class: 'figure', text: abs(plan.now.gap_per_month) }),
    el('div', { class: `delta ${short ? 'down' : 'up'}` }, [
      el('span', { class: 'q', text: short
        ? `a month short${plan.now.runway_date_friendly ? `, runs out ${plan.now.runway_date_friendly}` : ''}`
        : 'a month left over' }),
    ]),
    gapDiagram(plan, short),
    chosen.curve?.series?.length > 1
      ? cashChart(chosen.curve.series, {
          height: 200,
          runwayDate: chosen.curve.runway_date,
          reference: { series: plan.curve.as_is.series, label: 'as it is' },
        })
      : null,
    el('div', { class: 'keys', style: 'margin-top:6px' }, [
      el('span', {}, [el('i', { style: 'background:var(--ink)' }), el('span', { text: 'With what is ticked' })]),
      el('span', {}, [el('i', { style: 'background:var(--neutral)' }), el('span', { text: 'As it is' })]),
    ]),
    el('p', { class: 'muted small', style: 'margin:12px 0 0', text: verdict }),
  ]));
}

// --- stop these -----------------------------------------------------------

function tickRow({ checked, onChange, tile, title, caption, right, under }) {
  const box = el('input', { type: 'checkbox' });
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  return el('label', { class: 'item', style: 'cursor:pointer' }, [
    box,
    tile,
    el('span', { class: 'grow' }, [
      el('span', { class: 't truncate', text: title }),
      el('span', { class: 's', text: caption }),
    ]),
    el('span', { style: 'text-align:right' }, [
      el('span', { class: 'amount out', text: right }),
      under ? el('span', { class: 's', text: under }) : null,
    ]),
  ]);
}

function renderStop() {
  const plan = data.plan;
  const box = document.getElementById('stop');
  box.innerHTML = '';

  const rows = plan.optional.map((row) => tickRow({
    checked: ticks.stop.has(String(row.id)),
    onChange: (on) => { if (on) ticks.stop.add(String(row.id)); else ticks.stop.delete(String(row.id)); refresh(); },
    tile: el('span', { class: 'av cut', text: initialsOf(row.name) }),
    title: row.name,
    caption: row.what_it_is || 'optional, judged on the Spending page',
    // The year figure is the loud one. A subscription is priced monthly because
    // a small number is easy to say yes to, and the year undoes exactly that.
    right: `${money(row.per_year)} a year`,
    under: `${money(row.per_month)} a month`,
  }));

  if (cents(plan.allowance_per_month) > 0) {
    rows.push(tickRow({
      checked: ticks.allowance === 'zero',
      onChange: (on) => { ticks.allowance = on ? 'zero' : 'keep'; refresh(); },
      tile: el('span', { class: 'av cut', text: '..' }),
      title: 'Everything else optional, day to day',
      caption: 'the allowance: takeaway, clothes, whatever is not a bill',
      right: `${money(plan.allowance_per_month)} a month`,
      under: 'change the figure on its own page',
    }));
  }

  box.append(
    el('div', { class: 'sec', text: 'Stop these' }),
    el('p', { class: 'muted small', style: 'margin:-4px 0 10px' }, [
      el('span', { text: 'Ticked means stopped in the curve above. Nothing is cancelled '
        + 'until somebody cancels it. ' }),
      el('a', { href: '/allowance', text: 'The allowance' }),
      el('span', { text: ' is set on its own page.' }),
    ]),
    rows.length
      ? el('div', { class: 'card flush' }, rows)
      : el('p', { class: 'empty', text: 'Nothing has been judged optional yet. Say what is on the Spending page.' }),
  );
}

// --- spend less on these --------------------------------------------------

function renderTrim() {
  const plan = data.plan;
  const box = document.getElementById('trim');
  box.innerHTML = '';
  const rows = plan.chosen.trim_rows ?? [];
  if (!rows.length) return;

  const options = [0, 10, 20, 30, 40, 50];
  if (!options.includes(ticks.trim)) options.push(ticks.trim);
  const percent = el('select', {}, options.sort((a, b) => a - b).map((value) =>
    el('option', { value: String(value), text: value === 0 ? 'Not at all' : `${value} percent less`,
      selected: value === ticks.trim })));
  percent.addEventListener('change', () => { ticks.trim = Number(percent.value); refresh(); });

  box.append(
    el('div', { class: 'sec', text: 'Spend less on these' }),
    el('p', { class: 'muted small', style: 'margin:-4px 0 10px', text:
      'Food, fuel, pets and care stay in the plan, at a lower amount. These are the '
      + 'places marked could trim on the Spending page.' }),
    el('div', { class: 'card' }, [
      el('div', { class: 'row', style: 'gap:9px;flex-wrap:wrap;align-items:center' }, [
        el('span', { class: 't', text: 'Spend' }),
        percent,
        el('span', { class: 't', text: 'at these places' }),
      ]),
      el('div', { style: 'margin-top:10px' }, [
        ...rows.map((row) => el('div', { class: 'row spread', style: 'gap:10px;padding:5px 0' }, [
          el('span', { class: 'truncate grow', text: row.what }),
          el('span', { class: `amount ${cents(row.per_month) > 0 ? 'out' : 'muted'}`,
            text: `${money(row.per_month)} off ${money(row.from)}` }),
        ])),
        plan.chosen.trim_rows_more > 0
          ? el('div', { class: 's', text: `and ${plan.chosen.trim_rows_more} more` })
          : null,
      ]),
    ]),
  );
}

// --- all of it together ---------------------------------------------------

function renderFloor() {
  const plan = data.plan;
  const short = isShort(plan);
  const box = document.getElementById('floor');
  box.innerHTML = '';
  if (!plan.steps.length) return;
  box.append(el('div', { class: 'card' }, [
    el('div', { class: 'row spread' }, [
      el('span', { class: 'grow' }, [
        el('span', { class: 't', text: 'All of it together' }),
        el('span', { class: 's', text: !short
          ? 'every cut above, on top of what is already left over'
          : plan.floor.lasts ? 'covers what was short' : 'cutting cannot close this on its own' }),
      ]),
      el('span', { class: `amount ${plan.floor.lasts ? 'in' : 'out'}`, style: 'font-size:1.2rem',
        text: money(plan.floor.saves_per_month) }),
    ]),
    short && !plan.floor.lasts ? el('p', { class: 'warn small', style: 'margin:10px 0 0',
      text: `Still ${money(plan.floor.still_short_per_month)} a month short. The rest has to come from `
        + 'what comes in, from selling something, or from changing what the debts cost.' }) : null,
  ]));
}

// --- what this assumes ----------------------------------------------------

// The four figures the curve is built on, folded, because they are the answer
// to "where does that number come from" and not something to read every time.
// This lived on the Forecast page, which is gone; the curve it explained is
// the one at the top of this page now.
function renderAssumes() {
  const a = data.plan.assumes;
  const box = document.getElementById('assumes');
  box.innerHTML = '';
  if (!a) return;

  const row = (title, caption, amount, link = null) => el('div', { class: 'item' }, [
    el('span', { class: 'grow' }, [
      el('span', { class: 't', text: title }),
      el('span', { class: 's' }, [
        el('span', { text: link ? `${caption}. ` : caption }),
        link ? el('a', { href: link.href, text: link.text }) : null,
      ]),
    ]),
    el('span', { class: 'amount', text: amount }),
  ]);

  const notes = [];
  if (Number(a.irregular_essential) > 0) {
    notes.push(`${money(a.irregular_essential)} of the essential spending is at places seen on `
      + 'fewer than three dates: vets, registrations, repairs. It is in the projection anyway, '
      + 'because something in that shape happens most months even though it is never the same thing twice.');
  }
  // Two 2dp strings from the server, compared as strings: no arithmetic.
  if (a.optional_history_per_month !== a.allowance_per_month) {
    notes.push(`Optional day to day spending has actually been running at `
      + `${money(a.optional_history_per_month)} a month. The plan uses the allowance instead.`);
  }

  box.append(el('details', { class: 'card' }, [
    el('summary', { text: 'What this assumes' }),
    el('div', { class: 'card flush', style: 'margin-top:12px' }, [
      row('Money coming in', `${a.income.source}, ${a.cadence || 'each period'}`, money(a.income.amount)),
      row('Essential spending', `a day, from the last ${a.window_days} days`, money(a.essential_per_day)),
      row('Optional allowance',
        a.allowance_chosen ? 'a month, the figure you chose' : 'a month, following what optional spending has been',
        money(a.allowance_per_month), { href: '/allowance', text: 'Change it' }),
      row('Optional subscriptions', 'a month, judged optional on the Spending page', money(a.optional_subscriptions_per_month)),
    ]),
    ...notes.map((text) => el('p', { class: 'muted small', style: 'margin:10px 0 0', text })),
  ]));
}

// --- money coming later ---------------------------------------------------

function labelled(label, control) {
  return el('div', {}, [el('label', { text: label }), control]);
}

const SURE = [['confirmed', 'Confirmed'], ['likely', 'Likely'], ['possible', 'Possible']];

function renderExpecting() {
  const box = document.getElementById('expecting');
  box.innerHTML = '';
  const streams = data.expecting ?? [];

  const rows = streams.map((stream) => {
    const remove = el('button', { class: 'small', text: 'Remove' });
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await api(`/api/analyst/expected-income/${stream.id}`, { method: 'DELETE' });
        await load();
      } catch (err) { showError(err.message); remove.disabled = false; }
    });
    const when = stream.starts_on
      ? `from ${formatDay(stream.starts_on, { year: true })}`
      : 'no start date, so the forecast cannot use it yet';
    return el('div', { class: 'item' }, [
      el('span', { class: 'grow' }, [
        el('span', { class: 't truncate', text: stream.label }),
        el('span', { class: 's', text: `${howOften(stream.cadence_days)}, ${when}`
          + `${stream.ends_on ? ` to ${formatDay(stream.ends_on, { year: true })}` : ''}`
          + `${stream.active ? '' : ', switched off'}` }),
      ]),
      el('span', { style: 'text-align:right' }, [
        el('span', { class: 'amount in', text: money(stream.amount) }),
        el('span', { class: 's', text: SURE.find(([v]) => v === stream.confidence)?.[1].toLowerCase() ?? '' }),
      ]),
      remove,
    ]);
  });

  const label = el('input', { placeholder: 'A second wage, a new tenant' });
  const amount = el('input', { type: 'number', step: '0.01', placeholder: '2000.00' });
  const cadence = el('select', {}, [
    el('option', { value: '14', text: 'Fortnightly', selected: true }),
    el('option', { value: '30', text: 'Monthly' }),
    el('option', { value: '7', text: 'Weekly' }),
    el('option', { value: '91', text: 'Quarterly' }),
    el('option', { value: '365', text: 'Yearly' }),
  ]);
  const starts = el('input', { type: 'date' });
  const ends = el('input', { type: 'date' });
  const sure = el('select', {}, SURE.map(([value, text]) =>
    el('option', { value, text, selected: value === 'likely' })));
  const add = el('button', { class: 'primary', text: 'Add it' });
  add.addEventListener('click', async () => {
    add.disabled = true;
    try {
      await api('/api/analyst/expected-income', {
        method: 'POST',
        body: {
          label: label.value, amount: amount.value, cadence_days: Number(cadence.value),
          starts_on: starts.value || null, ends_on: ends.value || null, confidence: sure.value,
        },
      });
      showError('');
      await load();
    } catch (err) { showError(err.message); add.disabled = false; }
  });

  box.append(
    el('div', { class: 'sec', id: 'expecting-head', text: 'Money coming later' }),
    el('p', { class: 'muted small', style: 'margin:-4px 0 10px', text:
      'A wage that has not started, a second job. On the curve from the day it '
      + 'starts and not before, and not in today’s income until then.' }),
    rows.length
      ? el('div', { class: 'card flush' }, rows)
      : el('p', { class: 'empty', text: 'Nothing entered. A wage that starts in March belongs here.' }),
    el('details', { class: 'card' }, [
      el('summary', { text: 'Add income you expect' }),
      el('div', { class: 'stack', style: 'margin-top:14px' }, [
        el('div', { class: 'filters' }, [
          labelled('What it is', label), labelled('Amount each time', amount),
          labelled('How often', cadence), labelled('Starting', starts),
          labelled('Ending, if temporary', ends), labelled('How sure', sure),
        ]),
        el('p', { class: 'muted small', style: 'margin:0', text:
          'A start date is what makes it count. Anything marked possible stays off '
          + 'the monthly income figure, because a maybe is not a wage.' }),
        el('div', { class: 'row' }, [add]),
      ]),
    ]),
  );
}

// --- things we could sell -------------------------------------------------

function renderSell() {
  const box = document.getElementById('sell');
  box.innerHTML = '';
  const levers = data.levers ?? [];

  const rows = levers.map((lever) => {
    const remove = el('button', { class: 'small', text: 'Remove' });
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await api(`/api/analyst/assets/${lever.id}`, { method: 'DELETE' });
        await load();
      } catch (err) { showError(err.message); remove.disabled = false; }
    });
    return el('div', { class: 'item' }, [
      el('span', { class: 'grow' }, [
        el('span', { class: 't truncate', text: lever.name }),
        el('span', { class: 's', text: `with everything above, ${money(lever.with_everything_above)}` }),
      ]),
      el('span', { style: 'text-align:right' }, [
        el('span', { class: 'amount', text: money(lever.worth) }),
        lever.days_gained === null ? null
          : el('span', { class: 's good', text: `+${lever.days_gained} days` }),
      ]),
      remove,
    ]);
  });

  const name = el('input', { placeholder: 'Motorbike' });
  const value = el('input', { type: 'number', step: '0.01', placeholder: '10000.00' });
  const add = el('button', { class: 'primary', text: 'Add it' });
  add.addEventListener('click', async () => {
    add.disabled = true;
    try {
      await api('/api/analyst/assets', { method: 'POST', body: { name: name.value, estimated_value: value.value } });
      showError('');
      await load();
    } catch (err) { showError(err.message); add.disabled = false; }
  });

  box.append(
    el('div', { class: 'sec', text: 'Things we could sell' }),
    el('p', { class: 'muted small', style: 'margin:-4px 0 10px', text:
      'Buys time. It does not fix a gap, and the days each one buys come from the same projection as the curve.' }),
    rows.length ? el('div', { class: 'card flush' }, rows) : el('p', { class: 'empty', text: 'Nothing entered.' }),
    el('details', { class: 'card' }, [
      el('summary', { text: 'Add something you could sell' }),
      el('div', { class: 'stack', style: 'margin-top:14px' }, [
        el('div', { class: 'filters' }, [labelled('What it is', name), labelled('Worth about', value)]),
        el('div', { class: 'row' }, [add]),
      ]),
    ]),
  );
}

// --- what we said we would do ---------------------------------------------

// Checked against the transactions rather than against a tick box. A decision
// that names a place can be verified; one that does not is a note to self and
// the page says so rather than showing a green tick.
function renderDecisions() {
  const box = document.getElementById('decisions');
  box.innerHTML = '';
  const list = data.decisions ?? [];

  const what = el('input', { placeholder: 'What will change', style: 'flex:2;min-width:10rem' });
  const when = el('input', { placeholder: 'When exactly (the trigger)', style: 'flex:2;min-width:10rem' });
  const worth = el('input', { placeholder: '$ a month', style: 'flex:1;min-width:8rem' });
  const watch = el('select', { style: 'flex:2;min-width:10rem' }, [
    el('option', { value: '', text: 'Nothing to watch (a note to self)' }),
    ...(data.plan.optional ?? []).map((row) =>
      el('option', { value: row.match_key ?? '', text: `Watch: ${row.name}` })),
  ]);
  const add = el('button', { class: 'primary', text: 'Decide it', style: 'white-space:nowrap' });
  add.addEventListener('click', async () => {
    if (!what.value.trim()) return showError('Say what will change');
    add.disabled = true;
    try {
      await api('/api/today/intentions', {
        method: 'POST',
        body: {
          what: what.value, trigger_text: when.value || null,
          target_monthly: worth.value || null, merchant_key: watch.value || null,
        },
      });
      showError('');
      await load();
    } catch (err) { showError(err.message); } finally { add.disabled = false; }
  });

  const rows = list.map((item) => el('div', { class: 'item' }, [
    el('span', { class: 'grow' }, [
      el('span', { class: 't', text: item.what }),
      el('span', { class: 's', text: [item.trigger_text, item.merchant_key ? `watching ${item.merchant_key}` : null]
        .filter(Boolean).join(', ') }),
    ]),
    el('span', { style: 'text-align:right' }, [
      el('span', { class: item.verdict === 'held' ? 'good' : item.verdict === 'still being charged' ? 'warn' : 'muted',
        style: 'font-weight:600;font-size:0.9rem', text: item.verdict }),
      item.target_monthly ? el('span', { class: 's', text: `${money(item.target_monthly)} a month` }) : null,
    ]),
  ]));

  // Native append stringifies a null child into the word "null" on the page;
  // el() filters them, append does not.
  box.append(...[
    el('div', { class: 'sec', text: 'What we said we would do' }),
    el('p', { class: 'muted small', style: 'margin:-4px 0 10px', text:
      'What changes, and when exactly. "No delivery on weeknights" is a plan. "Spend less on takeaway" is a mood.' }),
    rows.length ? el('div', { class: 'card flush' }, rows) : null,
    el('details', { class: 'card', open: rows.length ? null : true }, [
      el('summary', { text: 'Decide something' }),
      el('div', { class: 'stack', style: 'margin-top:14px' }, [
        el('div', { class: 'row', style: 'flex-wrap:wrap' }, [what, when]),
        el('div', { class: 'row', style: 'flex-wrap:wrap' }, [watch, worth, add]),
      ]),
    ]),
  ].filter(Boolean));
}

// --- the rest -------------------------------------------------------------

function renderUndecided() {
  const box = document.getElementById('undecided');
  box.innerHTML = '';
  const undecided = data.plan.undecided ?? [];
  if (!undecided.length) return;
  box.append(el('div', { class: 'nudge' }, [
    el('h3', { text: undecided.length === 1
      ? 'One repeating cost has not been looked at'
      : `${undecided.length} repeating costs have not been looked at` }),
    el('p', { text: 'Nothing above offers to stop these, because nothing has said '
      + 'whether they are optional. Say so on Spending and they join the list.' }),
    el('div', { style: 'margin-top:9px' }, undecided.slice(0, 6).map((row) =>
      el('div', { class: 'row spread', style: 'padding:3px 0' }, [
        el('span', { class: 'grow truncate', text: row.what }),
        el('span', { class: 'amount', text: money(row.per_month) }),
      ]))),
    el('a', { class: 'btn', href: '/spending', text: 'Decide them', style: 'margin-top:11px' }),
  ]));
}

// What is not being touched, said out loud, because a page that only lists
// losses reads as though everything is going.
function renderKept() {
  const box = document.getElementById('kept');
  box.innerHTML = '';
  const kept = data.plan.kept ?? [];
  if (!kept.length) return;
  box.append(
    el('div', { class: 'sec', text: 'None of this changes' }),
    el('div', { class: 'card flush' }, kept.slice(0, 10).map((row) =>
      el('div', { class: 'item' }, [
        el('span', { class: 'av keep', style: 'width:26px;height:26px;border-radius:8px;font-size:0.7rem', text: '✓' }),
        el('span', { class: 'grow truncate t', text: row.what }),
        el('span', { class: 'amount', text: money(row.per_month) }),
      ]))),
  );
}

// --- wiring ---------------------------------------------------------------

// A tick changes the curve and the two cut sections. The forms further down
// keep what has been typed in them.
async function refresh() {
  try {
    data = await api(`/api/plan${query()}`);
    renderHead();
    renderStop();
    renderTrim();
    renderFloor();
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

async function load() {
  try {
    data = await api(`/api/plan${query()}`);
    if (!ticks) {
      const chosen = data.plan.chosen;
      ticks = { stop: new Set(chosen.stop.map(String)), allowance: chosen.allowance, trim: chosen.trim_percent };
    }
    renderHead();
    renderStop();
    renderTrim();
    renderFloor();
    renderAssumes();
    renderExpecting();
    renderSell();
    renderDecisions();
    renderUndecided();
    renderKept();
    showError('');
    // Arriving from a link to one section, land on it once it exists.
    if (window.location.hash === '#expecting') {
      document.getElementById('expecting-head')?.scrollIntoView({ block: 'start' });
    }
  } catch (err) {
    showError(err.message);
  }
}

await load();
