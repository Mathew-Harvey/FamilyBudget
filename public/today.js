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

renderNav('/today');

const money = (value) => formatAmount(value);
const abs = (value) => formatAmount(String(value).replace('-', ''));

// The opening. One sentence someone can repeat to the other person in the
// house without opening the app.
function headline(position) {
  const box = document.getElementById('headline');
  box.innerHTML = '';
  box.className = 'card stack';

  if (!position.going_backwards) {
    box.append(
      el('div', { class: 'muted', text: 'Where you stand' }),
      el('div', { style: 'font-size:1.6rem;font-weight:600', text: `${money(position.in_per_month)} in, ${money(position.out_per_month)} out` }),
      el('p', { text: 'More is coming in than going out. The gap is going the right way.' }),
    );
    return;
  }

  box.append(
    el('div', { class: 'muted', text: 'Spendable cash runs out on' }),
    // The biggest thing on the page, and it is a date. Everything else is
    // context for this.
    el('div', { style: 'font-size:2.6rem;font-weight:700;line-height:1.1', text: position.runway_date_friendly ?? 'no date in range' }),
    el('div', { class: 'muted', text: `${position.runway_days} days from today, at the current rate` }),
    el('hr'),
    el('div', { class: 'row', style: 'gap:1.5rem;flex-wrap:wrap' }, [
      el('div', {}, [
        el('div', { class: 'muted', text: 'Coming in' }),
        el('div', { class: 'amount', style: 'font-size:1.1rem', text: `${money(position.in_per_month)} a month` }),
      ]),
      el('div', {}, [
        el('div', { class: 'muted', text: 'Going out' }),
        el('div', { class: 'amount out', style: 'font-size:1.1rem', text: `${money(position.out_per_month)} a month` }),
      ]),
      el('div', {}, [
        el('div', { class: 'muted', text: 'Short by' }),
        el('div', { class: 'amount out', style: 'font-size:1.1rem;font-weight:700', text: `${money(position.gap_per_month)} a month` }),
      ]),
    ]),
    el('p', { class: 'muted', style: 'margin-bottom:0' , text:
      `That is ${money(String(position.daily_gap_cents / 100))} a day more going out than coming in. `
      + `Worked out from the last ${position.window_days} days of spending, one off purchases left out.` }),
  );

  for (const warning of position.warnings ?? []) {
    box.append(el('p', { class: 'warn', text: warning.message }));
  }
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
    el('div', { class: 'muted', text: `Comparing the ${data.days_since} days since ${changePoint.date} against the ${data.compared_against_days} days before it. Based on ${changePoint.source}.` }),
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
    el('div', { class: 'muted', text: 'The places that took more than they used to. This is where the cuts went.' }),
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
      const moved = await api('/api/today/trade-off', {
        method: 'POST',
        body: { monthly, commitment_ids: [...chosen] },
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
      style: 'display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:0.15rem 0.6rem;'
        + 'align-items:baseline;padding:0.55rem 0;border-bottom:1px solid var(--line);cursor:pointer',
    }, [
      el('div', { style: 'grid-row:1/span 2' }, [tick]),
      el('div', { class: 'truncate', style: 'font-weight:500', text: item.label }),
      // The year figure is the loud one. A subscription is priced monthly
      // because a small monthly number is easy to say yes to, and showing the
      // year next to it undoes exactly that framing.
      el('div', { class: 'amount out', style: 'text-align:right;white-space:nowrap', text: `${money(item.per_year)} a year` }),
      el('div', { class: 'muted truncate', style: 'font-size:0.8rem', text: item.what_it_is || item.category || '' }),
      el('div', { class: 'muted', style: 'text-align:right;white-space:nowrap;font-size:0.8rem' }, [
        el('span', { text: `${money(item.per_month)} a month` }),
        item.clears_the_gap || item.runway_days
          ? el('span', { class: 'good', style: 'margin-left:0.4rem', text: item.clears_the_gap ? 'closes the gap' : `+${item.runway_days} days` })
          : null,
      ]),
    ]);
  };

  const choice = data.items.filter((item) => !item.fixed);
  const fixed = data.items.filter((item) => item.fixed);

  const card = el('div', { class: 'card stack' }, [
    el('h3', { style: 'margin:0', text: 'What each one is really costing' }),
    el('div', { class: 'muted', text: 'Priced by the year, and by how many days it buys back. Tick things to see what stopping them does to the date. Ticking changes nothing.' }),
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
  const worth = el('input', { placeholder: '$ a month', style: 'flex:1;min-width:6rem' });

  // Naming the place is what makes the decision checkable. Without it this is a
  // note to self, and the app says so rather than pretending otherwise.
  const watch = el('select', { style: 'flex:2;min-width:10rem' }, [
    el('option', { value: '', text: 'Nothing to watch (a note to self)' }),
    ...(watchable ?? []).map((item) =>
      el('option', { value: item.merchant_key ?? '', text: `Watch: ${item.label}` })),
  ]);

  const add = el('button', { class: 'primary', text: 'Decide it' });
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
    // The "when" is not decoration. A decision paired with the situation that
    // triggers it is acted on far more often than the same decision on its own.
    el('div', { class: 'muted', text: 'A decision with a "when" attached gets done. "Spend less on takeaway" does not. "No delivery on weeknights, we cook what is in the fridge" does.' }),
    el('div', { class: 'row' }, [what, when]),
    el('div', { class: 'row' }, [watch, worth, add]),
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
    headline(data.position);
    stuck(data.stuck, data.change_point);
    moversSection(data.movers);
    // The costs double as the list of things a decision can watch, so they are
    // fetched before the decisions box is drawn.
    const costs = await api('/api/today/what-to-stop?limit=40');
    decisions(data.intentions, costs.items.filter((item) => !item.fixed));
    await whatToStop(costs);
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

await load();
