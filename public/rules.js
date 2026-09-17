import { api, el, formatAmount, amountClass, formatDate, renderNav, showError, pageIntro } from '/app.js';

renderNav('/rules');
pageIntro('Rules',
  'Filing a description under a category once, so it stays filed. Order matters: '
  + 'the first rule that matches wins. A rule never overwrites a category you set '
  + 'by hand.');

let groups = [];
let rules = [];

function formBody() {
  const value = (id) => document.getElementById(id).value.trim();
  const amount = (id) => (value(id) === '' ? undefined : Number(value(id)));
  return {
    name: value('name'),
    match_field: value('field'),
    match_type: value('type'),
    match_value: value('value') || null,
    account_id: value('account') || null,
    direction: value('direction') || null,
    min_amount: amount('min'),
    max_amount: amount('max'),
    category_id: value('category') || null,
    rename_to: value('rename') || null,
  };
}

function describe(rule) {
  const bits = [];
  if (rule.match_value) {
    const where = rule.match_field === 'any' ? 'anything' : rule.match_field.replace(/_/g, ' ');
    bits.push(`${where} ${rule.match_type.replace(/_/g, ' ')} "${rule.match_value}"`);
  }
  if (rule.bank) bits.push(`on ${rule.bank} ${rule.masked_number || ''}`);
  if (rule.direction) bits.push(rule.direction === 'debit' ? 'money out' : 'money in');
  if (rule.min_amount) bits.push(`at least ${formatAmount(rule.min_amount)}`);
  if (rule.max_amount) bits.push(`at most ${formatAmount(rule.max_amount)}`);
  return bits.join(', ') || 'matches everything';
}

function ruleCard(rule, index) {
  const toggle = el('input', {
    type: 'checkbox',
    checked: rule.enabled,
    onChange: async (e) => {
      await act(() => api(`/api/rules/${rule.id}`, { method: 'POST', body: { enabled: e.target.checked } }));
    },
  });

  const up = el('button', { class: 'small', text: 'Up', disabled: index === 0 });
  up.addEventListener('click', () => move(index, index - 1));
  const down = el('button', { class: 'small', text: 'Down', disabled: index === rules.length - 1 });
  down.addEventListener('click', () => move(index, index + 1));

  const remove = el('button', { class: 'small', text: 'Delete' });
  remove.addEventListener('click', async () => {
    if (!confirm(`Delete "${rule.name}"?`)) return;
    await act(() => api(`/api/rules/${rule.id}`, { method: 'DELETE' }));
  });

  const actions = [];
  if (rule.category_name) actions.push(`category ${rule.group_name} / ${rule.category_name}`);
  if (rule.rename_to) actions.push(`rename to "${rule.rename_to}"`);
  if (rule.set_note) actions.push('adds a note');

  toggle.className = 'switch';
  toggle.setAttribute('aria-label', `Turn "${rule.name}" on or off`);

  const detail = el('div', { style: 'display:none;padding:12px 16px;border-top:1px solid var(--line)' }, [
    el('p', { class: 'muted small', style: 'margin:0', text: `If ${describe(rule)}` }),
    el('p', { class: 'muted small', style: 'margin:4px 0 0', text: `Then ${actions.join(', ') || 'nothing'}` }),
    el('div', { class: 'row', style: 'gap:8px;margin-top:12px;flex-wrap:wrap' }, [up, down, remove]),
  ]);

  const line = el('div', { class: 'item', style: 'cursor:pointer' }, [
    // The number is the rule's place in the order, which is the one thing about
    // a rule list that is not obvious from reading the rules.
    el('span', { class: 'av trim', style: 'width:26px;height:26px;border-radius:8px;font-size:0.72rem',
      text: String(index + 1) }),
    el('span', { class: 'grow' }, [
      el('span', { class: 't truncate', text: rule.name }),
      el('span', { class: 's truncate', text: `${describe(rule)} \u2192 ${actions.join(', ') || 'nothing'}` }),
    ]),
    el('span', { class: rule.matched_count ? 'amount' : 'muted small',
      text: rule.matched_count ? `${rule.matched_count}` : 'catches nothing' }),
    toggle,
  ]);
  toggle.addEventListener('click', (event) => event.stopPropagation());
  line.addEventListener('click', () => {
    detail.style.display = detail.style.display === 'none' ? '' : 'none';
  });

  return el('div', { style: rule.enabled ? null : 'opacity:0.55' }, [line, detail]);
}

async function move(from, to) {
  const ids = rules.map((r) => r.id);
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved);
  await act(() => api('/api/rules/reorder', { method: 'POST', body: { ids } }));
}

async function act(fn) {
  try {
    await fn();
    await load();
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

async function load() {
  const data = await api('/api/rules');
  rules = data.rules;

  const on = rules.filter((rule) => rule.enabled);
  const caught = rules.reduce((total, rule) => total + Number(rule.matched_count || 0), 0);
  const idle = on.filter((rule) => !Number(rule.matched_count));

  const head = document.getElementById('head');
  head.innerHTML = '';
  head.append(el('div', { class: 'card' }, [
    el('span', { class: 'state' }, [
      el('span', { class: 'dot', style: `background:var(--${rules.length ? 'accent' : 'neutral'})` }),
      el('span', { text: rules.length
        ? `${on.length} of ${rules.length} switched on`
        : 'Nothing but the bank labels' }),
    ]),
    el('div', { class: 'figure', text: String(caught) }),
    el('div', { class: 'delta' }, [
      el('span', { class: 'q', text: rules.length
        ? 'transactions filed by a rule'
        : 'transactions filed by a rule, which is every one the banks got right on their own' }),
    ]),
    // A rule that catches nothing is either waiting for a merchant that has not
    // appeared yet or quietly broken, and the two look identical from here.
    idle.length ? el('p', { class: 'muted small', style: 'margin:12px 0 0', text:
      `${idle.length} switched on and catching nothing. Either the merchant has not `
      + 'turned up yet, or the text does not match what the bank actually sends.' }) : null,
  ]));

  const list = document.getElementById('list');
  list.innerHTML = '';
  if (!rules.length) {
    list.append(el('div', { class: 'card' }, [
      el('p', { style: 'margin:0', text: 'A rule files a description under a category '
        + 'once and keeps it filed, including everything that arrives later.' }),
      el('p', { class: 'muted small', style: 'margin:10px 0 0' }, [
        el('span', { text: 'The quickest way to write them is not here: ' }),
        el('a', { href: '/transactions', text: 'the transactions page' }),
        el('span', { text: ' groups what has no category by where it went and writes '
          + 'the rule for you, one place at a time.' }),
      ]),
    ]));
    return;
  }
  list.append(
    el('div', { class: 'sec', text: 'In order, first match wins' }),
    el('div', { class: 'card flush' }, rules.map((rule, index) => ruleCard(rule, index))),
  );
}

document.getElementById('preview').addEventListener('click', async () => {
  const holder = document.getElementById('previewRows');
  holder.innerHTML = '';
  try {
    const result = await api('/api/rules/preview', { method: 'POST', body: formBody() });
    document.getElementById('previewState').textContent =
      `${result.total} of the last ${result.considered} transactions match.`;
    holder.append(result.matched.length
      ? el('div', { class: 'card flush' }, result.matched.map((t) =>
          el('div', { class: 'item' }, [
            el('span', { class: 'grow' }, [
              el('span', { class: 't truncate', text: t.description }),
              el('span', { class: 's', text: `${formatDate(t.txn_date)}, ${t.bank} ${t.masked_number || ''}` }),
            ]),
            el('span', { class: `amount ${amountClass(t.amount)}`, text: formatAmount(t.amount) }),
          ])))
      : el('p', { class: 'empty', text: 'Nothing matches that, so the rule would sit there doing nothing.' }));
    showError('');
  } catch (err) {
    showError(err.message);
    document.getElementById('previewState').textContent = '';
  }
});

document.getElementById('create').addEventListener('click', async () => {
  try {
    const { recategorised } = await api('/api/rules', { method: 'POST', body: formBody() });
    document.getElementById('previewState').textContent =
      `Created, and it filed ${recategorised} transaction${recategorised === 1 ? '' : 's'}.`;
    for (const id of ['name', 'value', 'rename', 'min', 'max']) document.getElementById(id).value = '';
    document.getElementById('previewRows').innerHTML = '';
    await load();
    showError('');
  } catch (err) {
    showError(err.message);
  }
});

try {
  const [{ accounts }, categoryData] = await Promise.all([api('/api/accounts'), api('/api/categories')]);
  groups = categoryData.groups;

  const accountSelect = document.getElementById('account');
  for (const account of accounts) {
    accountSelect.append(el('option', { value: account.id, text: `${account.bank} ${account.masked_number || ''}` }));
  }

  const categorySelect = document.getElementById('category');
  categorySelect.append(el('option', { value: '', text: 'Leave alone' }));
  for (const group of groups) {
    const optgroup = el('optgroup', { label: group.name });
    for (const category of group.categories) {
      optgroup.append(el('option', { value: category.id, text: category.name }));
    }
    categorySelect.append(optgroup);
  }

  await load();
} catch (err) {
  showError(err.message);
}
