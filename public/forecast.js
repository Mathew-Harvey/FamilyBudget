import { api, el, formatAmount, formatDate, renderNav, showError } from '/app.js';

renderNav('/forecast');

// A plain inline SVG line chart. No chart library, and it reads in both themes
// because it uses the same custom properties as everything else.
function chart(series, bufferText) {
  const width = 720;
  const height = 220;
  const pad = { top: 12, right: 12, bottom: 22, left: 8 };

  const values = series.map((point) => Number(point.balance_cents));
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;

  const x = (i) => pad.left + (i / (series.length - 1)) * (width - pad.left - pad.right);
  const y = (value) => pad.top + (1 - (value - min) / span) * (height - pad.top - pad.bottom);

  const line = values.map((value, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(values.length - 1).toFixed(1)},${y(Math.max(min, 0)).toFixed(1)} L${x(0).toFixed(1)},${y(Math.max(min, 0)).toFixed(1)} Z`;

  const zeroY = y(0).toFixed(1);
  const firstNegative = values.findIndex((value) => value < 0);

  const svg = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img"
         aria-label="Projected spendable cash. ${bufferText}">
      <defs>
        <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#fill)"/>
      <line x1="${pad.left}" y1="${zeroY}" x2="${width - pad.right}" y2="${zeroY}"
            stroke="var(--out)" stroke-width="1" stroke-dasharray="3 3" opacity="0.8"/>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"
            stroke-linejoin="round" stroke-linecap="round"/>
      ${firstNegative > 0 ? `<circle cx="${x(firstNegative).toFixed(1)}" cy="${y(values[firstNegative]).toFixed(1)}" r="4" fill="var(--out)"/>` : ''}
      <text x="${pad.left}" y="${height - 6}" font-size="11" fill="var(--ink-soft)">${series[0].date}</text>
      <text x="${width - pad.right}" y="${height - 6}" font-size="11" fill="var(--ink-soft)"
            text-anchor="end">${series[series.length - 1].date}</text>
      <text x="${pad.left}" y="${Number(zeroY) - 4}" font-size="11" fill="var(--out)">zero</text>
    </svg>`;

  const holder = el('div');
  holder.innerHTML = svg;
  return holder;
}

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

async function load() {
  try {
    const days = document.getElementById('days').value;
    const buffer = document.getElementById('buffer').value || 0;
    const data = await api(`/api/forecast?days=${days}&buffer=${buffer}`);

    const summary = document.getElementById('summary');
    summary.innerHTML = '';
    summary.append(
      el('div', { class: 'spread' }, [
        el('div', {}, [
          el('div', { class: 'muted', text: 'Spendable cash today' }),
          el('div', { class: 'amount in', style: 'font-size:1.4rem', text: formatAmount(data.opening_balance) }),
        ]),
        el('div', { style: 'text-align:right' }, [
          el('div', { class: 'muted', text: 'Runway' }),
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
        `Everyday spending ${formatAmount(data.everyday_rate.per_day)} a day. `,
        `Committed ${formatAmount(data.everyday_rate.committed)} over the last ${data.everyday_rate.days} days.`,
      ]),
    );
    summary.append(
      el('div', { class: 'muted', text: `Lowest point ${formatAmount(data.lowest_balance)} on ${data.lowest_date}.` }),
    );

    const chartHolder = document.getElementById('chart');
    chartHolder.innerHTML = '';
    chartHolder.append(chart(data.series, `Runway ${data.runway_days ?? 'beyond the window'}`));

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
                el('span', { class: `amount ${event.kind === 'income' ? 'in' : 'out'}`, text: formatAmount(event.amount) }),
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
