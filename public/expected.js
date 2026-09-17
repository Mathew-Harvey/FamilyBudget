// Income that has not started yet, and things that could be sold.
//
// Both of these were on the Insights page, under a heading called "Levers",
// beneath a switch that says analysis is off. Neither has anything to do with
// analysis: buildForecastContext reads expected_income straight out of the
// database on every projection, whether or not anybody has ever turned Claude
// on. A core forecast input was filed under an optional feature the Set up
// index now labels "off", so it read as switched off too, and the one person
// who needed it could not find it.
//
// It belongs with the money coming in, next to the pay cycle, because that is
// what it is: a second wage that starts in March is the pay cycle's future.
//
// The endpoints are still under /api/analyst. That path is wrong too, but it is
// invisible from here and moving it would touch the analyst for no gain.
import { api, el, formatAmount, formatDate, renderNav, showError, pageIntro } from '/app.js';

renderNav('/expected');
pageIntro('Changes you expect',
  'Money you think is coming but that has not started, and things you could '
  + 'sell. Neither has happened, and the forecast counts expected income only '
  + 'from the date you give it.');

const SURE = [
  ['confirmed', 'Confirmed'],
  ['likely', 'Likely'],
  ['possible', 'Possible'],
];

// A stream a person can picture. "every 14 days" is arithmetic; a fortnight is
// a thing that happens.
function howOften(days) {
  const n = Number(days);
  if (n === 7) return 'weekly';
  if (n === 14) return 'fortnightly';
  if (n >= 28 && n <= 31) return 'monthly';
  if (n >= 88 && n <= 95) return 'quarterly';
  if (n >= 360 && n <= 370) return 'yearly';
  return `every ${n} days`;
}

// What the runway says right now. The whole reason for entering a second wage
// is to see what it does to the date the money runs out, so the date is on the
// page and moves when something is added.
async function renderHead() {
  const head = document.getElementById('head');
  head.innerHTML = '';
  try {
    const { position } = await api('/api/today');
    const runsOut = Boolean(position.runway_date_friendly);
    head.append(el('div', { class: 'card' }, [
      el('span', { class: `state ${runsOut ? 'bad' : 'ok'}` }, [
        el('span', { class: 'dot' }),
        el('span', { text: runsOut ? 'As things stand, the money runs out' : 'As things stand, nothing runs out' }),
      ]),
      el('div', { class: `figure ${runsOut ? 'date' : ''}`,
        text: runsOut ? position.runway_date_friendly : formatAmount(position.spendable) }),
      el('div', { class: 'delta' }, [
        el('span', { class: 'q', text: runsOut
          ? 'anything added below moves this date'
          : 'spendable cash, and more comes in than goes out' }),
      ]),
    ]));
  } catch (err) {
    showError(err.message);
  }
}

function labelled(label, control) {
  return el('div', {}, [el('label', { text: label }), control]);
}

async function renderIncome(streams) {
  const box = document.getElementById('income');
  box.innerHTML = '';

  const rows = streams.map((stream) => {
    const remove = el('button', { class: 'small', text: 'Remove' });
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await api(`/api/analyst/expected-income/${stream.id}`, { method: 'DELETE' });
        await load();
      } catch (err) {
        showError(err.message);
        remove.disabled = false;
      }
    });
    const when = stream.starts_on
      ? `from ${formatDate(stream.starts_on)}`
      : 'no start date, so the forecast cannot use it yet';
    return el('div', { class: 'item' }, [
      el('span', { class: 'grow' }, [
        el('span', { class: 't truncate', text: stream.label }),
        el('span', { class: 's', text: `${howOften(stream.cadence_days)}, ${when}`
          + `${stream.ends_on ? ` to ${formatDate(stream.ends_on)}` : ''}`
          + `${stream.active ? '' : ', switched off'}` }),
      ]),
      el('span', { class: 'right' }, [
        el('span', { class: 'amount in', text: formatAmount(stream.amount) }),
        el('span', { class: 's', text: SURE.find(([v]) => v === stream.confidence)?.[1].toLowerCase() ?? '' }),
      ]),
      remove,
    ]);
  });

  const label = el('input', { placeholder: 'A second wage, a new tenant, maintenance' });
  const amount = el('input', { type: 'number', step: '0.01', placeholder: '4800.00' });
  const cadence = el('select', {}, [
    el('option', { value: '14', text: 'Fortnightly' }),
    el('option', { value: '30', text: 'Monthly', selected: true }),
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
          label: label.value,
          amount: amount.value,
          cadence_days: Number(cadence.value),
          starts_on: starts.value || null,
          ends_on: ends.value || null,
          confidence: sure.value,
        },
      });
      showError('');
      await load();
    } catch (err) {
      showError(err.message);
      add.disabled = false;
    }
  });

  box.append(
    el('div', { class: 'sec', text: 'Income you expect' }),
    rows.length
      ? el('div', { class: 'card flush' }, rows)
      : el('p', { class: 'empty', text: 'Nothing entered. A wage that starts in March belongs here.' }),
    el('details', { class: 'card' }, [
      el('summary', { text: 'Add income you expect' }),
      el('div', { class: 'stack', style: 'margin-top:14px' }, [
        el('div', { class: 'filters' }, [
          labelled('What it is', label),
          labelled('Amount each time', amount),
          labelled('How often', cadence),
          labelled('Starting', starts),
          labelled('Ending, if temporary', ends),
          labelled('How sure', sure),
        ]),
        el('p', { class: 'muted small', style: 'margin:0', text:
          'A start date is what makes it count: the forecast adds it from that day '
          + 'and not before. Anything marked possible stays off the monthly income '
          + 'figure, because a maybe is not a wage.' }),
        el('div', { class: 'row' }, [add]),
      ]),
    ]),
  );
}

async function renderAssets(assets) {
  const box = document.getElementById('assets');
  box.innerHTML = '';

  const live = assets.filter((asset) => asset.sellable && !asset.sold_on);
  const total = live.reduce((sum, asset) => sum + Math.round(Number(asset.estimated_value) * 100), 0);

  const rows = assets.map((asset) => {
    const remove = el('button', { class: 'small', text: 'Remove' });
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await api(`/api/analyst/assets/${asset.id}`, { method: 'DELETE' });
        await load();
      } catch (err) {
        showError(err.message);
        remove.disabled = false;
      }
    });
    return el('div', { class: 'item' }, [
      el('span', { class: 'grow' }, [
        el('span', { class: 't truncate', text: asset.name }),
        el('span', { class: 's', text: asset.sold_on
          ? `sold ${formatDate(asset.sold_on)}`
          : 'could be sold' }),
      ]),
      el('span', { class: 'amount', text: formatAmount(asset.estimated_value) }),
      remove,
    ]);
  });

  const name = el('input', { placeholder: 'Motorbike' });
  const value = el('input', { type: 'number', step: '0.01', placeholder: '10000.00' });
  const add = el('button', { class: 'primary', text: 'Add it' });
  add.addEventListener('click', async () => {
    add.disabled = true;
    try {
      await api('/api/analyst/assets', {
        method: 'POST',
        body: { name: name.value, estimated_value: value.value },
      });
      showError('');
      await load();
    } catch (err) {
      showError(err.message);
      add.disabled = false;
    }
  });

  box.append(
    el('div', { class: 'sec', text: 'Things you could sell' }),
    el('p', { class: 'muted small', style: 'margin:-4px 0 10px', text:
      'These buy time, they do not fix a gap. The plan on Lasting says so in '
      + 'those words and prices each one in days.' }),
    rows.length
      ? el('div', { class: 'card flush' }, [
          ...rows,
          total > 0 ? el('div', { class: 'item' }, [
            el('span', { class: 'grow t', text: 'Could be raised by selling' }),
            el('span', { class: 'amount in', text: formatAmount((total / 100).toFixed(2)) }),
          ]) : null,
        ])
      : el('p', { class: 'empty', text: 'Nothing entered.' }),
    el('details', { class: 'card' }, [
      el('summary', { text: 'Add something you could sell' }),
      el('div', { class: 'stack', style: 'margin-top:14px' }, [
        el('div', { class: 'filters' }, [
          labelled('What it is', name),
          labelled('Worth about', value),
        ]),
        el('div', { class: 'row' }, [add]),
      ]),
    ]),
  );
}

async function load() {
  try {
    const { assets, expected_income: income } = await api('/api/analyst/levers');
    await renderIncome(income);
    await renderAssets(assets);
    await renderHead();
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

await load();
