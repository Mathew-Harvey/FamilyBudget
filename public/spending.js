// Where the money went.
//
// The page leads with a picture rather than a paragraph. The bar across the top
// is the whole window split three ways by how hard each thing would be to stop,
// and the key under it is the same three colours in the same order, so the one
// diagram both answers "how much of this can we even change" and teaches what
// the tile beside every row below means. That replaced two sentences of
// explanation, which is what it was competing with.
import { api, el, formatAmount, formatDate, formatDay, initialsOf, renderNav, showError } from '/app.js';

renderNav('/spending');

let view = 'merchants';
let windowDays = 120;

// A place named by whoever linked here. The allowance breakdown names twelve
// places and this is where a place is judged, so the link has to land on the
// row rather than at the top of a list of two hundred. Read once and cleared,
// or every redraw after a save would drag the page back to it.
let landOn = new URLSearchParams(window.location.search).get('place');

// The one set of words for the three tiers, in the place the judgement is
// made. They were four sets: this page said "A choice", Forecast said
// "essential", the API error said "luxury" and the plan said "luxury
// allowance". "Optional" replaced "A choice" because it is the only one of the
// two that also reads inside a sentence, and the other pages need it there.
const TIERS = [
  ['keep', 'Must pay'],
  ['trim', 'Could trim'],
  ['cut', 'Optional'],
  // Not a fourth kind of spending, the absence of a judgement about it. Drawn
  // hatched for the same reason the unreachable part of the gap on Lasting is:
  // a solid colour there would read as a fourth thing you could decide about.
  ['unknown', 'Not looked at'],
];

// A merchant with no judgement on it gets no tier tile colour, for the same
// reason the diagram hatches its share: 'cut' here is a default, not a finding.
const tierOf = (row) => row.lean_tier ?? row.category_tier ?? 'unknown';

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
  // There is no --tier-unknown on purpose, so that tier takes the hatch rather
  // than a colour. Without this branch it took an undefined variable and the
  // bar simply did not draw, which on the biggest row on the page looked like a
  // rendering fault rather than a statement about it.
  return el('div', { class: 'track' }, [
    el('i', {
      class: tier === 'unknown' ? 'unreachable' : null,
      style: `width:${(share * 100).toFixed(1)}%`
        + (tier === 'unknown' ? '' : `;background:var(--tier-${tier})`),
    }),
  ]);
}

// --- the head ------------------------------------------------------------

function renderHead(data) {
  const head = document.getElementById('head');
  head.innerHTML = '';

  const total = data.by_tier.reduce((sum, row) => sum + Number(row.spent), 0);
  const days = data.days_of_history ?? data.window_days;
  const unknownRow = data.by_tier.find((row) => row.tier === 'unknown') ?? { spent: '0' };
  const unknown = Number(unknownRow.spent);

  head.append(el('div', { class: 'card' }, [
    el('span', { class: 'state' }, [
      el('span', { class: 'dot', style: 'background:var(--accent)' }),
      el('span', { text: `Last ${days} days` }),
    ]),
    el('div', { class: 'figure', text: formatAmount(data.total.per_month) }),
    el('div', { class: 'delta' }, [
      el('span', { class: 'q', text: 'a month, at the rate this is running at' }),
    ]),

    // The diagram. The segments are in tier order and the key below is the same
    // order, so it reads as one thing.
    el('div', { class: 'split', style: 'margin-top:18px' },
      TIERS.map(([tier, label]) => {
        const row = data.by_tier.find((r) => r.tier === tier);
        if (!row || Number(row.spent) <= 0) return null;
        return el('i', {
          class: tier === 'unknown' ? 'unreachable' : null,
          style: `flex:${Number(row.spent)}`
            + (tier === 'unknown' ? '' : `;background:var(--tier-${tier})`),
          title: `${label}: ${formatAmount(row.spent)}`,
        });
      })),
    el('div', { class: 'keys' }, TIERS.map(([tier, label]) => {
      const row = data.by_tier.find((r) => r.tier === tier) ?? { spent: '0' };
      const share = total > 0 ? Math.round((Number(row.spent) / total) * 100) : 0;
      if (tier === 'unknown' && share === 0) return null;
      return el('span', {}, [
        el('i', { class: tier === 'unknown' ? 'unreachable' : null,
          style: tier === 'unknown' ? null : `background:var(--tier-${tier})` }),
        el('span', { text: `${label} ` }),
        el('b', { text: `${share}%` }),
      ]);
    })),

    // What the hatching means, and where to go about it. Without this the page
    // was calling half the household's spending "a choice" on the strength of a
    // default nobody had chosen, which is the same mistake the allowance made.
    unknown > 0 ? el('p', { class: 'muted small', style: 'margin:14px 0 0' }, [
      el('span', { text: `${formatAmount(unknownRow.spent)} has never been categorised, `
        + 'so nothing here knows whether it was a choice. ' }),
      el('a', { href: '/transactions', text: 'File it' }),
      el('span', { text: ' and these shares become real.' }),
    ]) : null,

    // What left against what it runs at. A rate is not a total and this page was
    // printing one as the other: with an 11,000 dollar engine rebuild in the
    // window the headline read 6,339 a month, which was true of no month and
    // matched nothing else in the app.
    el('p', { class: 'muted small', style: 'margin:10px 0 0', text:
      `${formatAmount(data.total.spent)} actually left over ${days} days`
      + (Number(data.total.one_offs) > 0
        ? `, including ${formatAmount(data.total.one_offs)} marked as never happening again. `
          + 'That stays in the total and out of the rate.'
        : '.') }),
  ]));
}

function renderSwitch() {
  const box = document.getElementById('switch');
  box.innerHTML = '';
  box.append(
    segmented([[30, 'Month'], [90, '3 months'], [120, '4 months'], [365, 'Year']],
      windowDays, (value) => { windowDays = value; render(); }),
    segmented([['merchants', 'By place'], ['groups', 'By kind'], ['repeating', 'Repeating'], ['unexplained', 'Not named yet']],
      view, (value) => { view = value; render(); }),
  );
}

// --- the rows ------------------------------------------------------------

// One place. The tile carries the tier, the bar carries the size, the numbers
// carry the rest. Tapping opens what it actually charged.
function placeRow(row, max, { onOpen, amount, note, open = false }) {
  const body = el('div', { class: 'grow' }, [
    el('span', { class: 't truncate', text: row.merchant ?? row.title }),
    note ? el('span', { class: 's truncate', text: note }) : null,
    bar(amount.value, max, tierOf(row)),
  ]);

  const children = el('div', { style: 'display:none;padding:12px 16px;border-top:1px solid var(--line)' });
  let loaded = false;

  const toggle = async () => {
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
  };

  const line = el('div', {
    class: 'item',
    style: onOpen ? 'cursor:pointer' : null,
    onClick: onOpen ? toggle : null,
  }, [
    el('span', { class: `av ${tierOf(row)}`, text: initialsOf(row.merchant ?? row.title) }),
    body,
    el('span', { class: 'right' }, [
      el('span', { class: 'amount out', text: formatAmount(amount.value) }),
      el('span', { class: 's', text: amount.unit }),
    ]),
  ]);

  const wrap = el('div', {}, [line, children]);
  // Opened because a link named it. Marked so render can scroll to it once the
  // list is in the page: scrolling to a node that is not in the document yet
  // does nothing and looks like a dead link.
  if (open && onOpen) {
    wrap.setAttribute('data-landed', '');
    toggle();
  }
  return wrap;
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
    el('div', { class: 'stack', style: 'gap:6px' }, transactions.slice(0, 20).map((t) => {
      // Marking one here rather than only on the Forecast page, which lists the
      // large ones at rarely seen merchants. This is the one place in the app
      // that shows a merchant's payments next to what it is costing a month,
      // which is exactly when you notice one of them does not belong.
      const once = el('button', {
        class: 'small',
        style: 'flex:none;padding:3px 9px;font-size:0.72rem',
        text: t.one_off ? 'back in' : 'one off',
      });
      once.addEventListener('click', async (event) => {
        event.stopPropagation();
        once.disabled = true;
        try {
          await api('/api/spending/one-off', {
            method: 'POST',
            body: { ids: [t.id], one_off: !t.one_off },
          });
          showError('');
          render();
        } catch (err) {
          showError(err.message);
          once.disabled = false;
        }
      });
      return el('div', { class: 'row spread', style: 'gap:10px' }, [
        el('span', { class: `s truncate grow${t.one_off ? ' muted' : ''}`,
          text: `${t.display_description || t.description}${t.one_off ? ', out of the rate' : ''}` }),
        el('span', { class: `amount small ${t.one_off ? 'muted' : 'out'}`, text: formatAmount(t.amount) }),
        el('span', { class: 's', style: 'flex:none', text: formatDate(t.txn_date).slice(5) }),
        once,
      ]);
    })),
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
        // Either name identifies it, because the breakdown keys places by the
        // merchant key and the list groups them by display name.
        open: Boolean(landOn) && (m.merchant_key === landOn || m.merchant === landOn),
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

// --- the bills that repeat -------------------------------------------------

// The repeating costs, with whether each one must be paid. This lived on the
// Forecast page, which is gone: a repeating cost is a judgement about a place,
// and this is the page where places are judged. The tile is the merchant's
// initials in the tier's colour, the same tile as every other row here.
const REPEAT_WORD = {
  keep: 'must pay',
  trim: 'could trim',
  cut: 'optional',
  unknown: 'nothing has said whether this is optional',
};

function repeatTier(commitment) {
  if (!commitment.active) return 'unknown';
  if (commitment.tier === 'cut' && commitment.tier_source === 'default') return 'unknown';
  return ['keep', 'trim', 'cut'].includes(commitment.tier) ? commitment.tier : 'unknown';
}

function repeatRow(commitment) {
  const tier = repeatTier(commitment);
  const toggle = el('input', { type: 'checkbox' });
  toggle.checked = commitment.active;
  toggle.addEventListener('change', async () => {
    try {
      await api(`/api/forecast/commitments/${commitment.id}`, {
        method: 'POST', body: { active: toggle.checked },
      });
      showError('');
      render();
    } catch (err) {
      showError(err.message);
    }
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
      + `${commitment.is_debt ? '. Paying down one of our own debts, so it is a must whatever else says' : ''}.` }),
    commitment.name !== commitment.label
      ? el('p', { class: 'muted small', style: 'margin:6px 0 0', text: `The bank calls it: ${commitment.label}` })
      : null,
  ]);

  const line = el('div', { class: `item${commitment.active ? '' : ' muted'}`, style: 'cursor:pointer' }, [
    el('span', { class: `av ${tier}`, text: initialsOf(commitment.name) }),
    el('span', { class: 'grow' }, [
      el('span', { class: 't truncate', text: commitment.name }),
      el('span', { class: 's', text: commitment.active
        ? `${REPEAT_WORD[tier]}, next ${formatDay(commitment.next_due)}`
        : 'turned off, not in the projection' }),
    ]),
    el('span', { style: 'text-align:right' }, [
      el('span', { class: 'amount out', text: formatAmount(commitment.typical_amount) }),
      commitment.per_month
        ? el('span', { class: 's', text: `${formatAmount(commitment.per_month)} a month` })
        : null,
    ]),
  ]);
  line.addEventListener('click', () => {
    detail.style.display = detail.style.display === 'none' ? '' : 'none';
  });
  return el('div', {}, [line, detail]);
}

async function renderRepeating() {
  const { commitments, active_per_month: activePerMonth } = await api('/api/forecast/commitments');
  const out = [];
  if (!commitments.length) {
    out.push(el('p', { class: 'empty', text: 'Nothing repeating has been found yet.' }));
  } else {
    const active = commitments.filter((row) => row.active).length;
    out.push(
      el('p', { class: 'muted small', style: 'margin:-4px 0 10px', text:
        `${active} of them, ${formatAmount(activePerMonth)} a month between them. `
        + 'Open one to turn it off if it is not really a repeating cost, or to see what the bank calls it.' }),
      el('div', { class: 'card flush' }, commitments.map(repeatRow)),
    );
  }

  const run = el('button', { class: 'primary', text: 'Run it' });
  const state = el('span', { class: 'muted small' });
  run.addEventListener('click', async () => {
    run.disabled = true;
    state.textContent = 'Looking...';
    try {
      const { found } = await api('/api/forecast/commitments/detect', { method: 'POST' });
      state.textContent = `${found} repeating costs found.`;
      render();
    } catch (err) {
      showError(err.message);
      run.disabled = false;
    }
  });
  out.push(el('details', { class: 'card' }, [
    el('summary', { text: 'Look for new ones' }),
    el('div', { class: 'stack', style: 'margin-top:14px' }, [
      el('p', { class: 'muted small', style: 'margin:0', text:
        'Goes back over the transactions looking for outgoings that repeat at a regular '
        + 'interval. Worth running after a new direct debit starts, or after renaming a place. '
        + 'Anything you added by hand is left alone.' }),
      el('div', { class: 'row' }, [run, state]),
    ]),
  ]));
  return out;
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
      : view === 'repeating' ? await renderRepeating()
        : view === 'unexplained' ? await renderUnexplained()
          : await renderMerchants();
    body.append(...rows);
    if (landOn) {
      landOn = null;
      body.querySelector('[data-landed]')?.scrollIntoView({ block: 'center' });
    }
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

await render();
