import { api, el, formatAmount, amountClass, formatDate, renderNav, showError } from '/app.js';

renderNav('/transactions');

const PAGE = 100;
let offset = 0;
let groups = [];

function filters() {
  const params = new URLSearchParams();
  const put = (key, id) => {
    const value = document.getElementById(id).value;
    if (value) params.set(key, value);
  };
  put('account_id', 'account');
  put('from', 'from');
  put('to', 'to');
  put('status', 'status');
  put('transfer', 'transfer');
  put('search', 'search');
  put('category_id', 'category');
  return params;
}

function row(txn) {
  const badges = [];
  if (txn.status === 'pending') badges.push(el('span', { class: 'badge pending', text: 'pending' }));
  if (txn.is_transfer) {
    // Jumps to the other side of the pair when it is on screen, and always says
    // which account and date it is paired with.
    badges.push(
      el('a', {
        class: 'badge transfer',
        href: `#${txn.transfer_pair_id}`,
        title: `Paired with ${txn.pair_account_name || ''} ${txn.pair_masked_number || ''} on ${formatDate(txn.pair_date)}`,
        text: `transfer ${txn.transfer_confidence || ''}`.trim(),
      }),
    );
  }

  // Changing this pins the category, so rules leave the row alone afterwards.
  const categorySelect = el(
    'select',
    {
      class: 'small',
      onChange: async (event) => {
        try {
          await api(`/api/transactions/${txn.id}/category`, {
            method: 'POST',
            body: { category_id: event.target.value || null },
          });
          showError('');
        } catch (err) {
          showError(err.message);
        }
      },
    },
    [
      el('option', { value: '', text: 'Uncategorised', selected: !txn.category_id }),
      ...groups.map((group) =>
        el(
          'optgroup',
          { label: group.name },
          group.categories.map((category) =>
            el('option', {
              value: category.id,
              text: category.name,
              selected: category.id === txn.category_id,
            }),
          ),
        ),
      ),
    ],
  );
  if (txn.category_source === 'manual') badges.push(el('span', { class: 'badge', text: 'set by hand' }));

  return el('tr', { id: txn.id }, [
    el('td', { 'data-col': 'description' }, [
      el('div', { class: 'truncate', text: txn.display_description || txn.description || '(no description)' }),
      txn.display_description
        ? el('div', { class: 'muted truncate', text: txn.description })
        : null,
    ]),
    el('td', { 'data-col': 'amount', class: 'right' }, [
      el('span', { class: `amount ${amountClass(txn.amount)}`, text: formatAmount(txn.amount) }),
    ]),
    el('td', { 'data-col': 'meta' }, [
      el('span', { class: 'muted' }, [
        `${formatDate(txn.txn_date)}, ${txn.bank} ${txn.masked_number || ''} `,
      ]),
      ...badges,
      categorySelect,
    ]),
  ]);
}

async function load(reset = false) {
  if (reset) offset = 0;
  const params = filters();
  params.set('limit', String(PAGE));
  params.set('offset', String(offset));

  try {
    const data = await api(`/api/transactions?${params}`);
    const list = document.getElementById('list');
    if (reset) list.innerHTML = '';

    let table = list.querySelector('table');
    if (!table) {
      table = el('table', { class: 'table-responsive' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: 'Description' }),
            el('th', { class: 'right', text: 'Amount' }),
            el('th', { text: 'Date and account' }),
          ]),
        ]),
        el('tbody'),
      ]);
      list.innerHTML = '';
      list.append(table);
    }

    const body = table.querySelector('tbody');
    for (const txn of data.transactions) body.append(row(txn));

    if (!data.total) list.innerHTML = '<p class="empty">Nothing matches those filters.</p>';

    document.getElementById('summary').textContent =
      `${data.total} transactions, net ${formatAmount(data.net)}`;
    offset += data.transactions.length;
    document.getElementById('more').style.display = offset < data.total ? '' : 'none';
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

try {
  const [{ accounts }, categoryData] = await Promise.all([api('/api/accounts'), api('/api/categories')]);
  groups = categoryData.groups;

  const categoryFilter = document.getElementById('category');
  categoryFilter.append(el('option', { value: '', text: 'All' }));
  for (const group of groups) {
    const optgroup = el('optgroup', { label: group.name });
    for (const category of group.categories) {
      optgroup.append(el('option', { value: category.id, text: category.name }));
    }
    categoryFilter.append(optgroup);
  }

  const select = document.getElementById('account');
  for (const account of accounts) {
    select.append(el('option', { value: account.id, text: `${account.bank} ${account.masked_number || ''} ${account.name}` }));
  }
  // Let another page link straight to a filtered view.
  const incoming = new URLSearchParams(window.location.search);
  for (const [key, id] of [['account_id', 'account'], ['status', 'status'], ['transfer', 'transfer'], ['category_id', 'category']]) {
    if (incoming.get(key)) document.getElementById(id).value = incoming.get(key);
  }
} catch (err) {
  showError(err.message);
}

document.getElementById('apply').addEventListener('click', () => load(true));
document.getElementById('more').addEventListener('click', () => load(false));
document.getElementById('reset').addEventListener('click', () => {
  for (const id of ['account', 'from', 'to', 'status', 'transfer', 'search', 'category']) {
    document.getElementById(id).value = '';
  }
  load(true);
});

await load(true);
