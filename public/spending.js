// Where the money went.
//
// The page leads with a picture rather than a paragraph. The bar across the top
// is the whole window split three ways by how hard each thing would be to stop,
// and the key under it is the same three colours in the same order, so the one
// diagram both answers "how much of this can we even change" and teaches what
// the tile beside every row below means. That replaced two sentences of
// explanation, which is what it was competing with.
import { api, el, formatAmount, formatDate, renderNav, showError } from '/app.js';

renderNav('/spending');

let view = 'merchants';
let windowDays = 120;

const TIERS = [
  ['keep', 'Must pay'],
  ['trim', 'Could trim'],
  ['cut', 'A choice'],
];

// Two letters from the name, the same tile the Home page uses.
function initialsOf(label) {
  const words = String(label || '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/);
  if (!words[0]) return '??';
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}

const tierOf = (row) => row.lean_tier ?? row.category_tier ?? 'cut';

// A segmented control. Three or four choices, no dropdown, no label.
function segmented(options, selected, onPick) {
  const wrap = el('div', { class: 'seg' });
  for (const [value, label] of options) {
    wrap.append(el('button', {
      type: 'button',
      text: label,
      'aria-current': value === selected ? 'true' : null,
      onClick: () => onPick(value),
    }));
  }
  return wrap;
}

// The proportion bar beside a row. Length is the share of the biggest row,
// colour is the tier, so one mark carries both without a second column.
function bar(value, max, tier) {
  const share = max > 0 ? Math.min(Math.max(Number(value) / max, 0), 1) : 0;
  return el('div', { class: 'track' }, [
    el('i', { style: `width:${(share * 100).toFixed(1)}%;background:var(--tier-${tier})` }),
  ]);
}

// --- the head ------------------------------------------------------------

function renderHead(data) {
  const head = document.getElementById('head');
  head.innerHTML = '';

  const total = data.by_tier.reduce((sum, row) => sum + Number(row.spent), 0);
  const days = data.days_of_history ?? data.window_days;

  head.append(el('div', { class: 'card' }, [
    el('span', { class: 'state' }, [
      el('span', { class: 'dot', style: 'background:var(--accent)' }),
      el('span', { text: `Last ${days} days` }),
    ]),
    el('div', { class: 'figure', text: formatAmount(data.total.per_month) }),
    el('div', { class: 'delta' }, [
      el('span', { class: 'q', text: `a month, from ${formatAmount(data.total.spent)} in total` }),
    ]),

    // The diagram. Three segments in tier order, and the key below is the same
    // three in the same order, so it reads as one thing.
    el('div', { class: 'split', style: 'margin-top:18px' },
      data.by_tier
        .filter((row) => Number(row.spent) > 0)
        .map((row) => el('i', {
          style: `flex:${Number(row.spent)};background:var(--tier-${row.tier})`,
          title: `${TIERS.find(([t]) => t === row.tier)[1]}: ${formatAmount(row.spent)}`,
        }))),
    el('div', { class: 'keys' }, TIERS.map(([tier, label]) => {
      const row = data.by_tier.find((r) => r.tier === tier) ?? { spent: '0' };
      const share = total > 0 ? Math.round((Number(row.spent) / total) * 100) : 0;
      return el('span', {}, [
        el('i', { style: `background:var(--tier-${tier})` }),
        el('span', { text: `${label} ` }),
        el('b', { text: `${share}%` }),
      ]);
    })),
  ]));
}

function renderSwitch() {
  const box = document.getElementById('switch');
  box.innerHTML = '';
  box.append(
    segmented([[30, 'Month'], [90, '3 months'], [120, '4 months'], [365, 'Year']],
      windowDays, (value) => { windowDays = value; render(); }),
    segmented([['merchants', 'By place'], ['groups', 'By kind'], ['unexplained', 'Not named yet']],
      view, (value) => { view = value; render(); }),
  );
}

// --- the rows ------------------------------------------------------------

// One place. The tile carries the tier, the bar carries the size, the numbers
// carry the rest. Tapping opens what it actually charged.
function placeRow(row, max, { onOpen, amount, note }) {
  const body = el('div', { class: 'grow' }, [
    el('span', { class: 't truncate', text: row.merchant ?? row.title }),
    note ? el('span', { class: 's truncate', text: note }) : null,
    bar(amount.value, max, tierOf(row)),
  ]);

  const children = el('div', { style: 'display:none;padding:12px 16px;border-top:1px solid var(--line)' });
  let loaded = false;

  const line = el('div', {
    class: 'item',
    style: onOpen ? 'cursor:pointer' : null,
    onClick: onOpen ? async () => {
      const opening = children.style.display === 'none';
      children.style.display = opening ? '' : 'none';
      if (opening && !loaded) {
        loaded = true;
        children.textContent = 'Loading...';
        children.className = 'muted small';
        try {
          children.innerHTML = '';
          children.className = '';
          children.style.padding = '12px 16px';
          children.style.borderTop = '1px solid var(--line)';
          children.append(...[].concat(await onOpen()));
        } catch (err) {
          showError(err.message);
        }
      }
    } : null,
  }, [
    el('span', { class: `av ${tierOf(row)}`, text: initialsOf(row.merchant ?? row.title) }),
    body,
    el('span', { class: 'right' }, [
      el('span', { class: 'amount out', text: formatAmount(amount.value) }),
      el('span', { class: 's', text: amount.unit }),
    ]),
  ]);

  return el('div', {}, [line, children]);
}

// The deepest level: what this place actually charged, and what it is.
async function merchantDetail(row) {
  const key = row.merchant_key ?? row.merchant;
  const { transactions } = await api(
    `/api/spending/merchants/${encodeURIComponent(key)}/transactions?window=${windowDays}`,
  );

  const name = el('input', { value: row.merchant ?? '', style: 'flex:2;min-width:9rem' });
  const what = el('input', { value: row.what_it_is ?? '', placeholder: 'What is this place?', style: 'flex:3;min-width:11rem' });
  const tier = el('select', { style: 'flex:2;min-width:9rem' }, [
    el('option', { value: '', text: 'Use the category', selected: !row.lean_tier }),
    ...TIERS.map(([value, label]) =>
      el('option', { value, text: label, selected: row.lean_tier === value })),
  ]);
  // Cancelled or switched away from. The spending stays in every total because
  // it really happened, it just stops being a guide to next month.
  const ended = el('input', { type: 'checkbox' });
  ended.checked = Boolean(row.ended_on);
  const save = el('button', { class: 'primary small', text: 'Save' });

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await api(`/api/spending/merchants/${encodeURIComponent(key)}`, {
        method: 'POST',
        body: {
          display_name: name.value || null,
          what_it_is: what.value || null,
          ended: ended.checked,
          lean_tier: tier.value || null,
        },
      });
      save.textContent = 'Saved';
      showError('');
      render();
    } catch (err) {
      showError(err.message);
      save.disabled = false;
    }
  });

  return [
    el('div', { class: 'row', style: 'flex-wrap:wrap;margin-bottom:10px' }, [name, what]),
    el('div', { class: 'row', style: 'flex-wrap:wrap;margin-bottom:12px' }, [
      tier,
      el('label', { class: 'row', style: 'gap:7px;flex:none' }, [ended, el('span', { class: 's', text: 'Finished with' })]),
      save,
    ]),
    el('div', { class: 'stack', style: 'gap:6px' }, transactions.slice(0, 20).map((t) =>
      el('div', { class: 'row spread', style: 'gap:10px' }, [
        el('span', { class: 's truncate grow', text: t.display_description || t.description }),
        el('span', { class: 'amount out small', text: formatAmount(t.amount) }),
        el('span', { class: 's', style: 'flex:none', text: formatDate(t.txn_date).slice(5) }),
      ]))),
  ];
}

async function renderMerchants() {
  const { merchants } = await api(`/api/spending/merchants?window=${windowDays}`);
  if (!merchants.length) return [el('p', { class: 'empty', text: 'Nothing in this window.' })];

  // Two lists, because they are two different measures and a bar length can
  // only mean one thing at a time.
  //
  // A place paid on fewer than three days has no monthly rate: saying "171 a
  // month" about a notice that arrives twice a year is how the Bendigo card
  // came to be reported at twelve times its real cost. Those rows carry a
  // window total instead, and a total and a rate cannot share a scale. Plotting
  // both against one max put an 11,000 dollar engine rebuild at full width and
  // squashed every monthly rate to a stub.
  const regular = merchants.filter((m) => m.days_paid == null || m.days_paid >= 3);
  const irregular = merchants.filter((m) => m.days_paid != null && m.days_paid < 3);

  const list = (rows, unit, pick) => {
    const max = Math.max(...rows.map((m) => Number(pick(m))), 0);
    return el('div', { class: 'card flush' }, rows.slice(0, 40).map((m) =>
      placeRow(m, max, {
        amount: { value: pick(m), unit },
        note: m.ended_on ? 'finished with' : m.what_it_is
          || `${m.transactions} payment${m.transactions === 1 ? '' : 's'}`,
        onOpen: () => merchantDetail(m),
      })));
  };

  const out = [];
  if (regular.length) {
    out.push(list(
      [...regular].sort((a, b) => Number(b.per_month) - Number(a.per_month)),
      'a month', (m) => m.per_month,
    ));
  }
  if (irregular.length) {
    out.push(
      el('div', { class: 'sec', text: 'Paid too rarely to be a monthly cost' }),
      list([...irregular].sort((a, b) => Number(b.spent) - Number(a.spent)),
        'in total', (m) => m.spent),
    );
  }
  return out;
}

async function renderGroups() {
  const data = await api(`/api/spending?window=${windowDays}`);
  const max = Math.max(...data.groups.map((g) => Number(g.per_month)));
  return [el('div', { class: 'card flush' }, data.groups.map((group) =>
    placeRow({ title: group.name, merchant: group.name }, max, {
      amount: { value: group.per_month, unit: 'a month' },
      note: group.categories.map((c) => c.category ?? 'Uncategorised').slice(0, 3).join(', '),
      onOpen: async () => {
        const catMax = Math.max(...group.categories.map((c) => Number(c.per_month)));
        return group.categories.map((cat) =>
          el('div', { class: 'row spread', style: 'gap:10px;padding:5px 0' }, [
            el('span', { class: 'truncate grow', text: cat.category ?? 'Uncategorised' }),
            el('span', { class: 'amount out small', text: formatAmount(cat.per_month) }),
          ]));
      },
    })))];
}

async function renderUnexplained() {
  const { merchants } = await api(`/api/spending/unexplained?window=${windowDays}`);
  const ask = el('button', { class: 'primary', text: 'Ask Claude what these are' });
  const state = el('span', { class: 'muted small' });
  ask.addEventListener('click', async () => {
    ask.disabled = true;
    state.textContent = 'Working it out...';
    try {
      const { identified } = await api('/api/analyst/identify-merchants', {
        method: 'POST', body: { window: Number(windowDays) },
      });
      state.textContent = `${identified} identified.`;
      render();
    } catch (err) {
      showError(err.message);
      state.textContent = '';
      ask.disabled = false;
    }
  });

  const out = [el('div', { class: 'card' }, [el('div', { class: 'row' }, [ask, state])])];
  if (!merchants.length) {
    out.push(el('p', { class: 'empty', text: 'Everything here has a name.' }));
    return out;
  }
  const max = Math.max(...merchants.map((m) => Number(m.spent)));
  out.push(el('div', { class: 'card flush' }, merchants.map((m) =>
    placeRow({ merchant: m.display_name || m.merchant_key, merchant_key: m.merchant_key }, max, {
      amount: { value: m.spent, unit: 'in total' },
      note: (m.examples || []).slice(0, 1).join(''),
      onOpen: () => merchantDetail({ merchant_key: m.merchant_key, merchant: m.display_name }),
    }))));
  return out;
}

async function render() {
  renderSwitch();
  const body = document.getElementById('body');
  try {
    // The head always comes from the overview, so the split and the total agree
    // whichever view is showing.
    renderHead(await api(`/api/spending?window=${windowDays}`));
    body.innerHTML = '';
    const rows = view === 'groups' ? await renderGroups()
      : view === 'unexplained' ? await renderUnexplained()
        : await renderMerchants();
    body.append(...rows);
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

await render();
