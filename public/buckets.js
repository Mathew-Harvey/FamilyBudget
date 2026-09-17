// How often you are paid, and giving each pay a job.
//
// Two features shared one page as two equal forms, and they are not equal. The
// pay cycle is load bearing: it cuts history into pay periods, it is what the
// fortnight card on Home is measured against, and it is the income the forecast
// projects. Envelopes are a method, and this household has never created one.
//
// So the cycle leads and says whether it still agrees with what the pay has
// actually been doing, which is the one question worth asking about it: the
// figure someone sets always wins over history, precisely because a job change
// makes the past a bad guide, and that is exactly when the app should say the
// two have parted company rather than quietly projecting the old wage forever.
//
// Envelopes come after, and an empty envelope list says what they are and that
// nothing is wrong with not using them. "No buckets yet. Add one below." reads
// like an unfinished setup.
import { api, el, formatAmount, formatDate, renderNav, showError, pageIntro } from '/app.js';

renderNav('/buckets');
pageIntro('Pay cycle and envelopes',
  'How often you are paid, which everything else is measured against, and '
  + 'optionally giving each pay a job before it is spent.');

const CADENCES = [['weekly', 'Weekly'], ['fortnightly', 'Fortnightly'], ['monthly', 'Monthly']];
const NAMED = Object.fromEntries(CADENCES);

let periods = [];
let groups = [];
let currentState = null;
let cycle = null;
let suggestion = null;

const cents = (value) => Math.round(Number(value ?? 0) * 100);

function addDays(iso, days) {
  const at = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`) + days * 86_400_000;
  return new Date(at).toISOString().slice(0, 10);
}

// --- the cycle ------------------------------------------------------------

function cycleForm() {
  const cadence = el('select', {}, CADENCES.map(([value, label]) =>
    el('option', { value, text: label, selected: cycle?.cadence === value })));
  const anchor = el('input', { type: 'date', value: cycle ? String(cycle.anchor_date).slice(0, 10) : '' });
  const expected = el('input', {
    type: 'number', step: '0.01', placeholder: 'optional',
    value: cycle?.expected_income ?? '',
  });
  const save = el('button', { class: 'primary', text: 'Save the cycle' });
  const state = el('span', { class: 'muted small' });

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const result = await api('/api/buckets/cycle', {
        method: 'POST',
        body: {
          cadence: cadence.value,
          anchor_date: anchor.value,
          expected_income: expected.value || null,
        },
      });
      // Changing the cadence removes periods of the old shape, or two periods
      // contain today and the wrong one wins. Said out loud, because it takes
      // allocations with it.
      state.textContent = result.periods?.removed
        ? `Saved. ${result.periods.removed} periods of the old shape were removed, `
          + `along with ${result.periods.allocations_removed} allocations.`
        : 'Saved.';
      showError('');
      await load();
    } catch (err) {
      showError(err.message);
      save.disabled = false;
    }
  });

  const field = (label, control, note) => el('div', {}, [
    el('label', { text: label }),
    control,
    note ? el('span', { class: 's', text: note }) : null,
  ]);

  return el('details', { class: 'card' }, [
    el('summary', { text: cycle ? 'Change the cycle' : 'Set the cycle' }),
    el('div', { class: 'stack', style: 'margin-top:14px' }, [
      el('div', { class: 'filters' }, [
        field('How often', cadence),
        field('A payday you are sure of', anchor, 'any one of them, past or future'),
        field('Expected each time', expected, 'what the forecast uses'),
      ]),
      el('p', { class: 'muted small', style: 'margin:0', text:
        'Changing how often you are paid rebuilds the pay periods and removes any '
        + 'allocations made against the old ones. The amount is what the projection '
        + 'counts on, so it wins over what history says.' }),
      el('div', { class: 'row' }, [save, state]),
    ]),
  ]);
}

function renderCycle() {
  const box = document.getElementById('cycle');
  box.innerHTML = '';

  if (!cycle) {
    box.append(
      el('div', { class: 'nudge' }, [
        el('h3', { text: 'No pay cycle set' }),
        el('p', { text: 'Without one there are no pay periods, Home cannot say how this '
          + 'fortnight is going, and the forecast has no income to project. '
          + (suggestion
            ? `Your history looks ${suggestion.cadence}, most recently ${formatDate(suggestion.anchor_date)}.`
            : 'Run a sync first and it can suggest one from your history.') }),
      ]),
      cycleForm(),
    );
    return;
  }

  const period = periods.find((p) => p.is_current) ?? null;
  const nextPay = period ? addDays(period.ends_on, 1) : null;

  // Does the configured cycle still describe what the pay is doing? The figure
  // someone set always wins, so this never changes anything: it says the two
  // have parted company and leaves the decision where it belongs.
  const agrees = suggestion ? suggestion.cadence === cycle.cadence : null;
  const streams = (suggestion?.streams ?? [])
    .map((s) => `${s.label} about ${formatAmount(s.typical_amount)}`)
    .join(', ');

  box.append(
    el('div', { class: 'card' }, [
      el('span', { class: `state ${agrees === false ? 'warn' : 'ok'}` }, [
        el('span', { class: 'dot' }),
        el('span', { text: agrees === false
          ? 'Set, but your pay looks different now'
          : 'Everything else is measured against this' }),
      ]),
      el('div', { class: 'figure', text: NAMED[cycle.cadence] ?? cycle.cadence }),
      el('div', { class: 'delta' }, [
        el('span', { class: 'q', text: cycle.expected_income
          ? `${formatAmount(cycle.expected_income)} expected each time`
          : 'no expected amount set, so the forecast has no income to project' }),
      ]),
      nextPay ? el('p', { class: 'muted small', style: 'margin:14px 0 0',
        text: `This period runs ${formatDate(period.starts_on)} to ${formatDate(period.ends_on)}. `
          + `Next payday ${formatDate(nextPay)}.` }) : null,
      suggestion ? el('p', { class: agrees === false ? 'warn small' : 'muted small', style: 'margin:8px 0 0',
        text: agrees === false
          ? `Your history looks ${suggestion.cadence}, most recently `
            + `${formatDate(suggestion.anchor_date)}${streams ? `, from ${streams}` : ''}. `
            + 'What you set here still wins, because only you know whether the pay has changed.'
          : `Your history agrees: ${suggestion.cadence}, most recently `
            + `${formatDate(suggestion.anchor_date)}${streams ? `, from ${streams}` : ''}.` }) : null,
    ]),
    cycleForm(),
  );
}

// --- envelopes ------------------------------------------------------------

function bucketRow(bucket) {
  const allocated = Number(bucket.allocated) + Number(bucket.carried_in);
  const spent = Number(bucket.spent);
  const share = allocated > 0 ? Math.min(Math.max(spent / allocated, 0), 1) : spent > 0 ? 1 : 0;
  const over = Number(bucket.remaining) < 0;

  const amount = el('input', {
    type: 'number', step: '0.01', value: bucket.allocated, style: 'max-width:8rem',
  });
  amount.addEventListener('change', async () => {
    try {
      const { state } = await api(`/api/buckets/periods/${currentState.period.id}/allocate`, {
        method: 'POST',
        body: { bucket_id: bucket.id, allocated: amount.value || '0' },
      });
      currentState = state;
      renderEnvelopes();
      showError('');
    } catch (err) {
      showError(err.message);
    }
  });

  // The endpoint has always existed and no page ever called it, so an envelope
  // could be made and never unmade.
  const remove = el('button', { class: 'small', text: 'Remove' });
  remove.addEventListener('click', async () => {
    if (!window.confirm(`Remove ${bucket.name}? Its allocations go with it. `
      + 'The spending stays, it just stops being counted against an envelope.')) return;
    remove.disabled = true;
    try {
      await api(`/api/buckets/${bucket.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      showError(err.message);
      remove.disabled = false;
    }
  });

  return el('div', { class: 'item', style: 'align-items:flex-start' }, [
    el('span', { class: 'grow' }, [
      el('span', { class: 'row spread' }, [
        el('span', { class: 't', text: bucket.name }),
        el('span', { class: `amount ${over ? 'out' : 'in'}`, text: formatAmount(bucket.remaining) }),
      ]),
      el('div', { class: 'track' }, [
        el('i', { style: `width:${(share * 100).toFixed(1)}%;background:var(--${over ? 'out' : 'accent'})` }),
      ]),
      el('span', { class: 's', text: `${formatAmount(bucket.spent)} spent of `
        + `${formatAmount(allocated.toFixed(2))}`
        + (Number(bucket.carried_in) ? `, ${formatAmount(bucket.carried_in)} carried in` : '')
        + (bucket.carry_over ? '' : ', resets each period')
        + `. Target ${formatAmount(bucket.target)}` }),
      el('div', { class: 'row', style: 'gap:8px;margin-top:8px;flex-wrap:wrap' }, [
        el('label', { style: 'flex:none', text: 'Give it' }),
        amount,
        remove,
      ]),
    ]),
  ]);
}

function createForm() {
  const name = el('input', { placeholder: 'Groceries' });
  const target = el('input', { type: 'number', step: '0.01', placeholder: '0.00' });
  const carry = el('select', {}, [
    el('option', { value: 'true', text: 'Rolls over' }),
    el('option', { value: 'false', text: 'Resets each period' }),
  ]);
  const picker = el('select', { multiple: 'multiple', size: '8' });
  for (const group of groups) {
    if (group.kind !== 'expense') continue;
    const optgroup = el('optgroup', { label: group.name });
    for (const category of group.categories) {
      optgroup.append(el('option', { value: category.id, text: category.name }));
    }
    picker.append(optgroup);
  }

  const create = el('button', { class: 'primary', text: 'Create it' });
  create.addEventListener('click', async () => {
    create.disabled = true;
    try {
      await api('/api/buckets', {
        method: 'POST',
        body: {
          name: name.value,
          target: target.value || 0,
          carry_over: carry.value === 'true',
          category_ids: [...picker.selectedOptions].map((option) => option.value),
        },
      });
      showError('');
      await load();
    } catch (err) {
      showError(err.message);
      create.disabled = false;
    }
  });

  const field = (label, control) => el('div', {}, [el('label', { text: label }), control]);
  return el('details', { class: 'card' }, [
    el('summary', { text: 'Create an envelope' }),
    el('div', { class: 'stack', style: 'margin-top:14px' }, [
      el('div', { class: 'filters' }, [
        field('Name', name),
        field('Target each period', target),
        field('Whatever is left over', carry),
      ]),
      el('div', {}, [
        el('label', { text: 'Categories it covers, hold to pick several' }),
        picker,
      ]),
      el('div', { class: 'row' }, [create]),
    ]),
  ]);
}

function renderEnvelopes() {
  const box = document.getElementById('envelopes');
  box.innerHTML = '';
  if (!cycle) return;

  const state = currentState;
  const buckets = state?.buckets ?? [];

  box.append(el('div', { class: 'sec', text: 'Envelopes' }));

  if (!buckets.length) {
    box.append(
      el('div', { class: 'card' }, [
        el('p', { style: 'margin:0', text: 'An envelope gives part of each pay a job: '
          + 'so much for groceries, so much for fuel. Spending in the categories it '
          + 'covers comes out of it, and what is left rolls over or resets.' }),
        el('p', { class: 'muted small', style: 'margin:10px 0 0', text:
          'You are not using these, and nothing needs them. Everything on Home, '
          + 'Spending and Lasting works without a single envelope.' }),
      ]),
      createForm(),
    );
    return;
  }

  // Which period is being looked at. Only worth showing once there is something
  // allocated to look at.
  const chooser = el('select', { style: 'max-width:18rem' }, periods.map((period) =>
    el('option', {
      value: period.id,
      text: `${formatDate(period.starts_on)} to ${formatDate(period.ends_on)}${period.is_current ? ', now' : ''}`,
      selected: period.id === state.period.id,
    })));
  chooser.addEventListener('change', async () => {
    await loadPeriod(chooser.value);
  });

  const fill = el('button', { text: 'Fill from targets' });
  fill.addEventListener('click', async () => {
    fill.disabled = true;
    try {
      await api(`/api/buckets/periods/${state.period.id}/apply-targets`, { method: 'POST' });
      await loadPeriod(state.period.id);
      showError('');
    } catch (err) {
      showError(err.message);
    }
    fill.disabled = false;
  });

  const left = cents(state.to_allocate);
  const income = cents(state.income);
  const allocated = cents(state.total_allocated);

  box.append(el('div', { class: 'card' }, [
    el('div', { class: 'row spread' }, [
      el('span', { class: 'grow' }, [
        el('span', { class: 't', text: `${formatAmount(state.total_allocated)} of `
          + `${formatAmount(state.income)} has a job` }),
        el('span', { class: 's', text: left === 0 ? 'every dollar is spoken for'
          : left > 0 ? 'the rest is unallocated' : 'more is allocated than came in' }),
      ]),
      el('span', { class: `amount ${left === 0 ? '' : left < 0 ? 'out' : 'in'}`,
        text: formatAmount(state.to_allocate) }),
    ]),
    income > 0 ? el('div', { class: 'track', style: 'height:8px;margin-top:12px' }, [
      el('i', { style: `width:${Math.min((allocated / income) * 100, 100).toFixed(1)}%;`
        + `background:var(--${left < 0 ? 'out' : 'accent'})` }),
    ]) : null,
    Number(state.unbucketed_spend) !== 0 || Number(state.uncategorised_spend) !== 0
      ? el('p', { class: 'muted small', style: 'margin:12px 0 0', text:
          [
            Number(state.unbucketed_spend) !== 0
              ? `${formatAmount(state.unbucketed_spend)} went on categories no envelope covers`
              : null,
            Number(state.uncategorised_spend) !== 0
              ? `${formatAmount(state.uncategorised_spend)} is still uncategorised`
              : null,
          ].filter(Boolean).join(', ') + '.' })
      : null,
    el('div', { class: 'row', style: 'gap:8px;margin-top:14px;flex-wrap:wrap' }, [chooser, fill]),
  ]));

  box.append(el('div', { class: 'card flush' }, buckets.map(bucketRow)), createForm());
}

// --- loading --------------------------------------------------------------

async function loadPeriod(periodId) {
  const { state } = await api(`/api/buckets/periods/${periodId}`);
  currentState = state;
  renderEnvelopes();
}

async function load() {
  const cycleData = await api('/api/buckets/cycle');
  cycle = cycleData.cycle;
  suggestion = cycleData.suggestion;

  periods = [];
  currentState = null;
  if (cycle) {
    const data = await api('/api/buckets/periods');
    periods = data.periods;
    const chosen = periods.find((period) => period.is_current) ?? periods[0];
    if (chosen) {
      const { state } = await api(`/api/buckets/periods/${chosen.id}`);
      currentState = state;
    }
  }

  renderCycle();
  renderEnvelopes();
}

try {
  const categoryData = await api('/api/categories');
  groups = categoryData.groups;
  await load();
} catch (err) {
  showError(err.message);
}
