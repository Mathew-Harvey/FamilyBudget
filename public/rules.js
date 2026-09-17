import { api, el, formatAmount, amountClass, formatDate, renderNav, showError, pageIntro } from '/app.js';

renderNav('/rules');
pageIntro('Rules', 'Filing a description under a category once, so it stays filed. A rule never overwrites a category somebody set by hand.');

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

  return el('div', { class: 'card stack' }, [
    el('div', { class: 'spread' }, [
      el('div', { class: 'row' }, [toggle, el('strong', { text: rule.name })]),
      el('span', { class: 'muted', text: `${rule.matched_count} matched` }),
    ]),
    el('div', { class: 'muted', text: `If ${describe(rule)}` }),
    el('div', { class: 'muted', text: `Then ${actions.join(', ') || 'nothing'}` }),
    el('div', { class: 'row' }, [up, down, remove]),
  ]);
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
  const list = document.getElementById('list');
  list.innerHTML = '';
  if (!rules.length) {
    list.append(el('p', { class: 'empty', text: 'No rules yet. The bank labels are doing all the work.' }));
  } else {
    rules.forEach((rule, i) => list.append(ruleCard(rule, i)));
  }
}

document.getElementById('preview').addEventListener('click', async () => {
  const holder = document.getElementById('previewRows');
  holder.innerHTML = '';
  try {
    const result = await api('/api/rules/preview', { method: 'POST', body: formBody() });
    document.getElementById('previewState').textContent =
      `${result.total} of the last ${result.considered} transactions match.`;
    holder.append(
      el('table', { class: 'table-responsive' }, [
        el('tbody', {}, result.matched.map((t) =>
          el('tr', {}, [
            el('td', { 'data-col': 'description', class: 'truncate', text: t.description }),
            el('td', { 'data-col': 'amount', class: 'right' }, [
              el('span', { class: `amount ${amountClass(t.amount)}`, text: formatAmount(t.amount) }),
            ]),
            el('td', { 'data-col': 'meta', class: 'muted', text: `${formatDate(t.txn_date)}, ${t.bank} ${t.masked_number || ''}` }),
          ]),
        )),
      ]),
    );
    showError('');
  } catch (err) {
    showError(err.message);
    document.getElementById('previewState').textContent = '';
  }
});

document.getElementById('create').addEventListener('click', async () => {
  try {
    const { recategorised } = await api('/api/rules', { method: 'POST', body: formBody() });
    document.getElementById('previewState').textContent = `Created. ${recategorised} transactions recategorised.`;
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
