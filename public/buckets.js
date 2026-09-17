import { api, el, formatAmount, amountClass, renderNav, showError, pageIntro } from '/app.js';

renderNav('/buckets');
pageIntro('Pay cycle and envelopes', 'How often you are paid, and giving every dollar a job before it is spent.');

let periods = [];
let groups = [];
let currentState = null;

function bar(remaining, allocated) {
  // A simple proportion bar, drawn with a div rather than a chart library.
  const alloc = Number(allocated) || 0;
  const left = Number(remaining) || 0;
  const usedFraction = alloc > 0 ? Math.min(Math.max((alloc - left) / alloc, 0), 1) : left < 0 ? 1 : 0;
  const over = left < 0;
  return el('div', {
    style:
      'height:6px;border-radius:999px;background:var(--line);overflow:hidden;margin-top:0.35rem',
  }, [
    el('div', {
      style: `height:100%;width:${Math.round(usedFraction * 100)}%;background:${over ? 'var(--out)' : 'var(--accent)'}`,
    }),
  ]);
}

function bucketCard(bucket) {
  const input = el('input', {
    type: 'number',
    step: '0.01',
    value: bucket.allocated,
    style: 'width:7rem',
    onChange: async (event) => {
      try {
        const { state } = await api(`/api/buckets/periods/${currentState.period.id}/allocate`, {
          method: 'POST',
          body: { bucket_id: bucket.id, allocated: event.target.value || '0' },
        });
        currentState = state;
        render();
        showError('');
      } catch (err) {
        showError(err.message);
      }
    },
  });

  return el('div', { class: 'card stack' }, [
    el('div', { class: 'spread' }, [
      el('div', {}, [
        el('strong', { text: bucket.name }),
        bucket.carry_over ? null : el('span', { class: 'badge', text: 'resets' }),
      ]),
      el('span', { class: `amount ${Number(bucket.remaining) < 0 ? 'out' : 'in'}`, text: formatAmount(bucket.remaining) }),
    ]),
    bar(bucket.remaining, Number(bucket.allocated) + Number(bucket.carried_in)),
    el('div', { class: 'row muted' }, [
      el('span', { text: 'Allocate' }),
      input,
      el('span', { text: `spent ${formatAmount(bucket.spent)}` }),
      Number(bucket.carried_in) !== 0 ? el('span', { text: `carried in ${formatAmount(bucket.carried_in)}` }) : null,
      el('span', { text: `target ${formatAmount(bucket.target)}` }),
    ]),
  ]);
}

function render() {
  const state = currentState;
  const summary = document.getElementById('summary');
  summary.innerHTML = '';
  if (!state) {
    summary.append(el('p', { class: 'muted', text: 'Set a pay cycle to get started.' }));
    return;
  }

  const left = Number(state.to_allocate);
  summary.append(
    el('div', { class: 'spread' }, [
      el('div', {}, [
        el('strong', { text: `${state.period.starts_on} to ${state.period.ends_on}` }),
        el('div', { class: 'muted', text: `income ${formatAmount(state.income)}, allocated ${formatAmount(state.total_allocated)}` }),
      ]),
      el('div', { style: 'text-align:right' }, [
        el('div', {
          class: `amount ${left === 0 ? '' : left < 0 ? 'out' : 'in'}`,
          text: formatAmount(state.to_allocate),
        }),
        el('div', { class: 'muted', text: left === 0 ? 'every dollar has a job' : left > 0 ? 'left to allocate' : 'over allocated' }),
      ]),
    ]),
  );
  if (Number(state.unbucketed_spend) !== 0) {
    summary.append(
      el('div', { class: 'muted', text: `${formatAmount(state.unbucketed_spend)} was spent in categories no bucket covers.` }),
    );
  }
  if (Number(state.uncategorised_spend) !== 0) {
    summary.append(
      el('div', { class: 'muted', text: `${formatAmount(state.uncategorised_spend)} is still uncategorised.` }),
    );
  }

  const list = document.getElementById('list');
  list.innerHTML = '';
  if (!state.buckets.length) {
    list.append(el('p', { class: 'empty', text: 'No buckets yet. Add one below.' }));
  } else {
    for (const bucket of state.buckets) list.append(bucketCard(bucket));
  }
}

async function loadPeriod(periodId) {
  const { state } = await api(`/api/buckets/periods/${periodId}`);
  currentState = state;
  render();
}

async function loadCycle() {
  const { cycle, suggestion } = await api('/api/buckets/cycle');
  if (cycle) {
    document.getElementById('cadence').value = cycle.cadence;
    document.getElementById('anchor').value = String(cycle.anchor_date).slice(0, 10);
    if (cycle.expected_income) document.getElementById('expected').value = cycle.expected_income;
  }
  const holder = document.getElementById('suggestion');
  holder.textContent = '';
  if (suggestion) {
    const streams = (suggestion.streams || []).map((s) => `${s.label} about ${formatAmount(s.typical_amount)}`).join(', ');
    holder.textContent =
      `From your history: ${suggestion.cadence}, most recent payday ${suggestion.anchor_date}` +
      (streams ? `, from ${streams}.` : '.') +
      ' This reads the past, so change it if your pay has changed.';
  }
}

async function loadPeriods() {
  const data = await api('/api/buckets/periods');
  periods = data.periods;
  const select = document.getElementById('period');
  select.innerHTML = '';
  for (const period of periods) {
    select.append(
      el('option', {
        value: period.id,
        text: `${period.starts_on} to ${period.ends_on}${period.is_current ? ' (now)' : ''}`,
        selected: period.is_current,
      }),
    );
  }
  const chosen = periods.find((p) => p.is_current) ?? periods[0];
  if (chosen) await loadPeriod(chosen.id);
}

document.getElementById('period').addEventListener('change', (e) => loadPeriod(e.target.value));

document.getElementById('applyTargets').addEventListener('click', async () => {
  try {
    await api(`/api/buckets/periods/${currentState.period.id}/apply-targets`, { method: 'POST' });
    await loadPeriod(currentState.period.id);
    showError('');
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById('saveCycle').addEventListener('click', async () => {
  try {
    const result = await api('/api/buckets/cycle', {
      method: 'POST',
      body: {
        cadence: document.getElementById('cadence').value,
        anchor_date: document.getElementById('anchor').value,
        expected_income: document.getElementById('expected').value || null,
      },
    });
    const removed = result.periods?.removed
      ? ` ${result.periods.removed} periods from the old cycle were removed, along with ${result.periods.allocations_removed} allocations.`
      : '';
    document.getElementById('cycleState').textContent = `Saved.${removed}`;
    await loadPeriods();
    showError('');
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById('createBucket').addEventListener('click', async () => {
  const selected = [...document.getElementById('newCategories').selectedOptions].map((o) => o.value);
  try {
    await api('/api/buckets', {
      method: 'POST',
      body: {
        name: document.getElementById('newName').value,
        target: document.getElementById('newTarget').value || 0,
        carry_over: document.getElementById('newCarry').value === 'true',
        category_ids: selected,
      },
    });
    document.getElementById('newName').value = '';
    document.getElementById('newTarget').value = '';
    await loadPeriod(currentState.period.id);
    showError('');
  } catch (err) {
    showError(err.message);
  }
});

try {
  const categoryData = await api('/api/categories');
  groups = categoryData.groups;
  const picker = document.getElementById('newCategories');
  for (const group of groups) {
    if (group.kind !== 'expense') continue;
    const optgroup = el('optgroup', { label: group.name });
    for (const category of group.categories) {
      optgroup.append(el('option', { value: category.id, text: category.name }));
    }
    picker.append(optgroup);
  }
  await loadCycle();
  await loadPeriods();
} catch (err) {
  showError(err.message);
}
