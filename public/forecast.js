import { api, el, formatAmount, formatDate, renderNav, showError } from '/app.js';
import { cashChart } from '/chart.js';

renderNav('/forecast');

const excludedLuxuryCommitments = new Set();

function commitmentRow(commitment) {
  const toggle = el('input', {
    type: 'checkbox',
    checked: commitment.active,
    onChange: async (event) => {
      try {
        await api(`/api/forecast/commitments/${commitment.id}`, {
          method: 'POST',
          body: { active: event.target.checked },
        });
        await load();
        showError('');
      } catch (err) {
        showError(err.message);
      }
    },
  });

  return el('tr', {}, [
    el('td', { 'data-col': 'description' }, [
      el('div', { class: 'row' }, [toggle, el('span', { class: 'truncate', text: commitment.label })]),
      el('div', { class: 'muted', text: commitment.category_name ? `${commitment.group_name} / ${commitment.category_name}` : '' }),
    ]),
    el('td', { 'data-col': 'amount', class: 'right' }, [
      el('span', { class: 'amount out', text: formatAmount(commitment.typical_amount) }),
    ]),
    el('td', { 'data-col': 'meta', class: 'muted' }, [
      `every ${commitment.cadence_days} days, seen ${commitment.occurrences} times, next ${formatDate(commitment.next_due)}`,
      commitment.source === 'manual' ? el('span', { class: 'badge', text: 'added by hand' }) : null,
    ]),
  ]);
}

function renderLuxury(luxury) {
  const holder = document.getElementById('luxuryCommitments');
  holder.innerHTML = '';
  const rows = luxury?.active_commitments ?? [];
  if (!rows.length) {
    holder.append(el('p', { class: 'muted', text: 'No active optional commitments.' }));
    return;
  }

  holder.append(
    el('div', { class: 'muted', text:
      `${formatAmount(luxury.included_commitments_per_month)} a month is currently included in optional commitments.` }),
    el('div', { class: 'stack', style: 'gap:0.2rem' }, rows.map((commitment) => {
      const toggle = el('input', {
        type: 'checkbox',
        checked: commitment.included,
        onChange: async (event) => {
          if (event.target.checked) excludedLuxuryCommitments.delete(String(commitment.id));
          else excludedLuxuryCommitments.add(String(commitment.id));
          await load();
        },
      });
      return el('label', {
        class: 'row',
        style: 'display:flex;margin:0;padding:0.2rem 0',
      }, [
        toggle,
        el('span', { class: 'grow truncate', text: commitment.label }),
        el('span', { class: 'amount', text: `${formatAmount(commitment.per_month)} a month` }),
      ]);
    })),
  );
}

async function load() {
  try {
    const days = document.getElementById('days').value;
    const buffer = document.getElementById('buffer').value || 0;
    const params = new URLSearchParams({ days, buffer });
    if (excludedLuxuryCommitments.size) {
      params.set('exclude_commitments', [...excludedLuxuryCommitments].join(','));
    }
    const data = await api(`/api/forecast?${params}`);
    // Shown here, set on its own page. Two controls for one number is two
    // places for it to be wrong, and unticking the box that used to live here
    // wrote a deliberate zero, which is the one answer nobody means.
    const line = document.getElementById('allowanceLine');
    line.innerHTML = '';
    line.append(
      el('span', { class: 'grow' }, [
        el('span', { class: 't', text: `${formatAmount(data.luxury.allowance_per_month)} a month` }),
        el('span', { class: 's', text: 'the allowance this projection is built on' }),
      ]),
      el('a', { class: 'btn small', href: '/allowance', text: 'Change it' }),
    );
    renderLuxury(data.luxury);

    const summary = document.getElementById('summary');
    summary.innerHTML = '';
    summary.append(
      el('div', { class: 'spread' }, [
        el('div', {}, [
          el('div', { class: 'muted', text: 'Spendable cash today' }),
          el('div', { class: 'amount in', style: 'font-size:1.4rem', text: formatAmount(data.opening_balance) }),
        ]),
        el('div', { style: 'text-align:right' }, [
          el('div', {
            class: 'muted',
            text: excludedLuxuryCommitments.size ? 'Scenario runway' : 'Household runway',
          }),
          el('div', {
            class: `amount ${data.runway_date ? 'out' : 'in'}`,
            style: 'font-size:1.4rem',
            text: data.runway_date ? `${data.runway_days} days` : `beyond ${data.days} days`,
          }),
          el('div', { class: 'muted', text: data.runway_date ? `runs out ${data.runway_date}` : '' }),
        ]),
      ]),
    );
    summary.append(
      el('div', { class: 'muted' }, [
        `Income ${formatAmount(data.expected_income.amount)} each ${data.cycle?.cadence || 'period'} (${data.expected_income.source}). `,
        `Recurring essential spending ${formatAmount(data.projected_everyday_rate.essential_per_day)} a day from the last ${data.spend_window_days} days. `,
        `Discretionary allowance ${formatAmount(data.luxury.allowance_per_month)} a month. `,
        `Optional commitments included ${formatAmount(data.luxury.included_commitments_per_month)} a month.`,
      ]),
    );
    summary.append(el('div', {
      class: 'muted',
      text: `Recent optional day-to-day spending averaged ${formatAmount(data.luxury.historical_variable_per_month)} a month. The household plan replaces that history with the allowance above.`,
    }));
    if (Number(data.everyday_rate.irregular_essential) > 0) {
      summary.append(el('div', {
        class: 'muted',
        text: `${formatAmount(data.everyday_rate.irregular_essential)} of that is essential spending at places `
          + 'seen on fewer than three dates: vets, registrations, repairs. No single one of them is '
          + 'quoted a monthly rate, and the total is in the projection, because something in that shape '
          + 'happens most months even though it is never the same thing twice.',
      }));
    }
    summary.append(
      el('div', { class: 'muted', text: `Lowest point ${formatAmount(data.lowest_balance)} on ${data.lowest_date}.` }),
    );

    const chartHolder = document.getElementById('chart');
    chartHolder.innerHTML = '';
    chartHolder.append(cashChart(data.series, { height: 240, runwayDate: data.runway_date }));

    const upcoming = document.getElementById('upcoming');
    upcoming.innerHTML = '';
    const next = data.series.flatMap((point) => point.events.map((event) => ({ ...event, date: point.date }))).slice(0, 25);
    if (!next.length) {
      upcoming.append(el('p', { class: 'empty', text: 'Nothing scheduled in this window.' }));
    } else {
      upcoming.append(
        el('table', { class: 'table-responsive' }, [
          el('tbody', {}, next.map((event) =>
            el('tr', {}, [
              el('td', { 'data-col': 'description', class: 'truncate', text: event.label }),
              el('td', { 'data-col': 'amount', class: 'right' }, [
                el('span', {
                  class: `amount ${['income', 'expected_income'].includes(event.kind) ? 'in' : 'out'}`,
                  text: formatAmount(event.amount),
                }),
              ]),
              el('td', { 'data-col': 'meta', class: 'muted', text: event.date }),
            ]),
          )),
        ]),
      );
    }

    const { commitments } = await api('/api/forecast/commitments');
    const holder = document.getElementById('commitments');
    holder.innerHTML = '';
    holder.append(
      el('div', { class: 'card' }, [
        el('table', { class: 'table-responsive' }, [el('tbody', {}, commitments.map(commitmentRow))]),
      ]),
    );
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

document.getElementById('days').addEventListener('change', load);
document.getElementById('buffer').addEventListener('change', load);
// Large amounts at places barely seen. These are what a one off actually looks
// like, and marking one is the only thing that keeps it out of the rate now
// that being rare no longer does it by accident. The endpoint that finds them
// has always existed; the page that used it did not survive the redesign.
async function renderOneOffs() {
  const box = document.getElementById('oneOffs');
  try {
    const { candidates } = await api('/api/spending/one-off-candidates');
    box.innerHTML = '';
    if (!candidates.length) {
      box.append(el('p', { class: 'empty', text: 'Nothing large enough to ask about.' }));
      return;
    }
    box.append(el('div', { class: 'card flush' }, candidates.slice(0, 12).map((row) => {
      const mark = el('button', {
        class: row.one_off ? 'small' : 'primary small',
        text: row.one_off ? 'Put it back' : 'One off',
      });
      mark.addEventListener('click', async () => {
        mark.disabled = true;
        try {
          await api('/api/spending/one-off', {
            method: 'POST',
            body: { ids: [row.id], one_off: !row.one_off },
          });
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
          el('span', { class: 's', text: `${formatDate(row.txn_date)}, paid on ${row.days_paid} `
            + `day${row.days_paid === 1 ? '' : 's'}${row.category ? `, ${row.category}` : ''}`
            + `${row.one_off ? ', out of the rate' : ''}` }),
        ]),
        el('span', { class: 'right' }, [
          el('span', { class: `amount ${row.one_off ? 'muted' : 'out'}`, text: formatAmount(row.amount) }),
        ]),
        mark,
      ]);
    })));
  } catch (err) {
    showError(err.message);
  }
}
await renderOneOffs();

document.getElementById('redetect').addEventListener('click', async () => {
  document.getElementById('detectState').textContent = 'Looking...';
  try {
    const { found } = await api('/api/forecast/commitments/detect', { method: 'POST' });
    document.getElementById('detectState').textContent = `${found} recurring outgoings found.`;
    await load();
  } catch (err) {
    showError(err.message);
  }
});

await load();
