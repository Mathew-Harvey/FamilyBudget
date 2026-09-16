import { api, el, formatAmount, formatDate, renderNav, showError } from '/app.js';

renderNav('/spending');

let view = 'groups';
let categories = [];

const windowDays = () => document.getElementById('window').value || 60;

// A proportion bar. The width is the share of the biggest line, so the eye can
// compare rows without reading every number.
function bar(value, max, tone = 'var(--accent)') {
  const share = max > 0 ? Math.min(Math.max(Number(value) / max, 0), 1) : 0;
  return el('div', { style: 'height:4px;border-radius:999px;background:var(--line);overflow:hidden;margin-top:0.3rem' }, [
    el('div', { style: `height:100%;width:${(share * 100).toFixed(1)}%;background:${tone}` }),
  ]);
}

// One expandable line. Tapping it loads and shows its children underneath.
function row({ title, note, amount, perMonth, max, onOpen, badge, rateIsReal = true }) {
  const children = el('div', { class: 'stack', style: 'display:none;padding:0.5rem 0 0.25rem 0.75rem;border-left:2px solid var(--line);margin-left:0.25rem' });
  let loaded = false;

  const chevron = el('span', { class: 'muted', text: '+', style: 'width:1rem;display:inline-block' });
  const head = el('div', {
    class: 'row',
    style: 'cursor:pointer;align-items:baseline',
    onClick: async () => {
      const opening = children.style.display === 'none';
      children.style.display = opening ? '' : 'none';
      chevron.textContent = opening ? '−' : '+';
      if (opening && !loaded && onOpen) {
        loaded = true;
        children.innerHTML = '<p class="muted">Loading...</p>';
        try {
          const content = await onOpen();
          children.innerHTML = '';
          children.append(...[].concat(content));
        } catch (err) {
          children.innerHTML = '';
          showError(err.message);
        }
      }
    },
  }, [
    onOpen ? chevron : el('span', { style: 'width:1rem;display:inline-block' }),
    el('div', { class: 'grow', style: 'min-width:0' }, [
      el('div', { class: 'row', style: 'gap:0.35rem' }, [
        el('span', { class: 'truncate', text: title }),
        badge ? el('span', { class: 'badge', text: badge }) : null,
      ]),
      note ? el('div', { class: 'muted truncate', text: note }) : null,
    ]),
    el('div', { style: 'text-align:right;white-space:nowrap' }, [
      el('div', { class: 'amount out', text: formatAmount(perMonth) }),
      el('div', { class: 'muted', style: 'font-size:0.75rem', text: rateIsReal ? 'a month' : 'in this window' }),
    ]),
  ]);

  return el('div', { style: 'padding:0.45rem 0;border-bottom:1px solid var(--line)' }, [
    head,
    max !== undefined ? bar(perMonth, max) : null,
    children,
  ]);
}

// The deepest level: the transactions themselves, plus what this place is.
async function merchantDetail(key, displayName, whatItIs) {
  const { transactions } = await api(
    `/api/spending/merchants/${encodeURIComponent(key)}/transactions?window=${windowDays()}`,
  );

  const nameInput = el('input', { value: displayName ?? '', style: 'flex:1;min-width:8rem' });
  const whatInput = el('input', { value: whatItIs ?? '', placeholder: 'What is this place?', style: 'flex:2;min-width:10rem' });
  const save = el('button', { class: 'small primary', text: 'Save' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await api(`/api/spending/merchants/${encodeURIComponent(key)}`, {
        method: 'POST',
        body: { display_name: nameInput.value || null, what_it_is: whatInput.value || null },
      });
      save.textContent = 'Saved';
      showError('');
    } catch (err) {
      showError(err.message);
      save.disabled = false;
    }
  });

  return [
    el('div', { class: 'row', style: 'margin-bottom:0.4rem' }, [nameInput, whatInput, save]),
    el('table', { class: 'table-responsive' }, [
      el('tbody', {}, transactions.map((t) =>
        el('tr', {}, [
          el('td', { 'data-col': 'description', class: 'truncate', text: t.display_description || t.description }),
          el('td', { 'data-col': 'amount', class: 'right' }, [
            el('span', { class: 'amount out', text: formatAmount(t.amount) }),
          ]),
          el('td', { 'data-col': 'meta', class: 'muted', text: `${formatDate(t.txn_date)}, ${t.bank} ${t.masked_number || ''}` }),
        ]),
      )),
    ]),
  ];
}

async function merchantRows(categoryId = null) {
  const params = new URLSearchParams({ window: windowDays() });
  if (categoryId) params.set('category_id', categoryId);
  const { merchants } = await api(`/api/spending/merchants?${params}`);
  if (!merchants.length) return [el('p', { class: 'muted', text: 'Nothing here in this window.' })];

  const max = Math.max(...merchants.map((m) => Number(m.per_month)));
  return merchants.map((m) =>
    row({
      title: m.merchant,
      // Paid on one or two days in the whole window has no monthly rate. Saying
      // "171 a month" about a rates notice that arrives twice a year is how the
      // Bendigo card came to be reported at twelve times its real cost.
      note: (m.days_paid != null && m.days_paid < 3)
        ? `${formatAmount(m.spent)} over ${m.days_paid} day${m.days_paid === 1 ? '' : 's'} in this window, not a monthly cost`
        : m.what_it_is || `${m.transactions} payment${m.transactions === 1 ? '' : 's'}, ${formatAmount(m.spent)} in total`,
      perMonth: (m.days_paid != null && m.days_paid < 3) ? m.spent : m.per_month,
      rateIsReal: !(m.days_paid != null && m.days_paid < 3),
      max,
      badge: m.essential ? 'essential' : null,
      onOpen: () => merchantDetail(m.merchant_key ?? m.merchant, m.merchant, m.what_it_is),
    }),
  );
}

async function renderGroups() {
  const data = await api(`/api/spending?window=${windowDays()}`);
  document.getElementById('total').textContent = formatAmount(data.total.per_month);
  document.getElementById('totalNote').textContent =
    `a month, from ${formatAmount(data.total.spent)} over ${data.window_days} days`;

  const max = Math.max(...data.groups.map((g) => Number(g.per_month)));
  const body = document.getElementById('body');
  body.innerHTML = '';
  body.append(
    el('div', { class: 'card' }, data.groups.map((group) =>
      row({
        title: group.name,
        perMonth: group.per_month,
        max,
        onOpen: () => {
          const catMax = Math.max(...group.categories.map((c) => Number(c.per_month)));
          return group.categories.map((cat) =>
            row({
              title: cat.category ?? 'Uncategorised',
              note: `${cat.transactions} transaction${cat.transactions === 1 ? '' : 's'}`,
              perMonth: cat.per_month,
              max: catMax,
              onOpen: () => merchantRows(cat.category_id),
            }),
          );
        },
      }),
    )),
  );
}

async function renderMerchants() {
  const data = await api(`/api/spending?window=${windowDays()}`);
  document.getElementById('total').textContent = formatAmount(data.total.per_month);
  document.getElementById('totalNote').textContent =
    `a month, from ${formatAmount(data.total.spent)} over ${data.window_days} days`;

  const body = document.getElementById('body');
  body.innerHTML = '';
  body.append(el('div', { class: 'card' }, await merchantRows()));
}

async function renderUnexplained() {
  const { merchants } = await api(`/api/spending/unexplained?window=${windowDays()}`);
  const body = document.getElementById('body');
  body.innerHTML = '';

  const explain = el('button', { class: 'primary', text: 'Ask Claude what these are' });
  const state = el('span', { class: 'muted' });
  explain.addEventListener('click', async () => {
    explain.disabled = true;
    state.textContent = 'Working it out...';
    try {
      const { identified } = await api('/api/analyst/identify-merchants', {
        method: 'POST',
        body: { window: Number(windowDays()) },
      });
      state.textContent = `${identified} identified.`;
      await renderUnexplained();
    } catch (err) {
      showError(err.message);
      state.textContent = '';
      explain.disabled = false;
    }
  });

  body.append(
    el('div', { class: 'card stack' }, [
      el('div', { class: 'muted', text: 'Places the app has not been told about. Name them yourself, or have Claude work out what they are from the description and the amounts.' }),
      el('div', { class: 'row' }, [explain, state]),
    ]),
  );

  if (!merchants.length) {
    body.append(el('p', { class: 'empty', text: 'Everything in this window has been identified.' }));
    return;
  }

  const max = Math.max(...merchants.map((m) => Number(m.spent)));
  body.append(
    el('div', { class: 'card' }, merchants.map((m) =>
      row({
        title: m.display_name || m.merchant_key,
        note: (m.examples || []).slice(0, 2).join('  |  '),
        perMonth: m.spent,
        max,
        onOpen: () => merchantDetail(m.merchant_key, m.display_name, null),
      }),
    )),
  );
  // These are totals for the window, not monthly rates, so relabel honestly.
  for (const label of body.querySelectorAll('.muted')) {
    if (label.textContent === 'a month') label.textContent = 'in window';
  }
}

async function render() {
  try {
    document.getElementById('windowNote').textContent =
      Number(windowDays()) >= 365
        ? 'A year includes the 2025 renovation, which is not a guide to normal months.'
        : 'Recent months only, so last year’s renovation does not skew it.';
    if (view === 'groups') await renderGroups();
    else if (view === 'merchants') await renderMerchants();
    else await renderUnexplained();
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

for (const [id, name] of [['viewGroups', 'groups'], ['viewMerchants', 'merchants'], ['viewUnexplained', 'unexplained']]) {
  document.getElementById(id).addEventListener('click', () => {
    view = name;
    render();
  });
}
document.getElementById('window').addEventListener('change', render);

try {
  categories = (await api('/api/categories')).groups;
} catch {
  // The page still works without them, they only feed the category picker.
}
await render();
