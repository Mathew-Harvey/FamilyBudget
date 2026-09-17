// Everything, and the one job anybody actually comes here to do.
//
// The Set up index says "483 with no category" and sends you here, where the
// page offered a hundred rows at a time, each with its own category dropdown.
// Filing 483 rows one dropdown at a time is nobody's afternoon.
//
// They are not 483 decisions. On this household they are fifteen: 65 of them
// are ALDI, 62 are Woolworths, 57 are Coles. So the unfiled spending is grouped
// by where it went, and filing a group writes a rule, which files every one of
// them and every future one too. The same shape as the transfers page, and for
// the same reason: the same judgement repeated is one judgement.
//
// The table is still here underneath, because sometimes you want one specific
// transaction, and that is what the filters are for.
import { api, el, formatAmount, amountClass, formatDate, renderNav, showError, pageIntro } from '/app.js';

renderNav('/transactions');
pageIntro('All transactions',
  'Everything the banks have sent, and a way to file what has not been filed.');

const PAGE = 100;
const FILTERS = ['search', 'account', 'category', 'from', 'to', 'status', 'transfer'];
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

// --- filing the unfiled ---------------------------------------------------

function categoryPicker(selected = '') {
  return el('select', { style: 'max-width:14rem' }, [
    el('option', { value: '', text: 'Pick a category', selected: !selected }),
    ...groups.map((group) => el('optgroup', { label: group.name },
      group.categories.map((category) => el('option', {
        value: category.id, text: category.name, selected: category.id === selected,
      })))),
  ]);
}

// One place with unfiled spending, and one decision that settles all of it.
function unfiledRow(place) {
  const picker = categoryPicker();
  const file = el('button', { class: 'primary small', text: `File all ${place.count}` });
  file.disabled = true;
  picker.addEventListener('change', () => { file.disabled = !picker.value; });

  file.addEventListener('click', async () => {
    file.disabled = true;
    try {
      // A rule rather than 65 individual writes: it files what is there and
      // what arrives next month, and it is visible and editable on the Rules
      // page afterwards rather than being an invisible bulk edit.
      const { recategorised } = await api('/api/rules', {
        method: 'POST',
        body: {
          name: place.merchant,
          match_field: 'description',
          match_type: 'contains',
          match_value: place.merchant,
          category_id: picker.value,
        },
      });
      showError('');
      await loadUnfiled();
      await load(true);
      file.textContent = `Filed ${recategorised}`;
    } catch (err) {
      showError(err.message);
      file.disabled = false;
    }
  });

  return el('div', { class: 'item', style: 'flex-wrap:wrap' }, [
    el('span', { class: 'grow', style: 'min-width:12rem' }, [
      el('span', { class: 't truncate', text: place.merchant }),
      el('span', { class: 's', text: `${place.count} transaction${place.count === 1 ? '' : 's'}, `
        + `${formatDate(place.first_seen)} to ${formatDate(place.last_seen)}` }),
    ]),
    el('span', { class: 'amount out', text: formatAmount(place.total) }),
    picker,
    file,
  ]);
}

async function loadUnfiled() {
  const head = document.getElementById('head');
  const box = document.getElementById('unfiled');
  head.innerHTML = '';
  box.innerHTML = '';

  const { places, total, rows } = await api('/api/transactions/unfiled');
  head.append(el('div', { class: 'card' }, [
    el('span', { class: `state ${rows ? 'warn' : 'ok'}` }, [
      el('span', { class: 'dot' }),
      el('span', { text: rows ? 'Not filed yet' : 'Everything is filed' }),
    ]),
    el('div', { class: 'figure', text: rows ? String(rows) : formatAmount('0') }),
    el('div', { class: 'delta' }, [
      el('span', { class: 'q', text: rows
        ? `transactions with no category, worth ${formatAmount(total)}, `
          + `and only ${places.length} decision${places.length === 1 ? '' : 's'} to make`
        : 'every transaction that counts has a category' }),
    ]),
  ]));

  if (!places.length) return;
  box.append(
    el('div', { class: 'sec', text: 'Where they went' }),
    el('p', { class: 'muted small', style: 'margin:-4px 0 10px', text:
      'Filing a place writes a rule, so these and everything that arrives from '
      + 'there later are filed too. Rules never overwrite a category you set by hand.' }),
    el('div', { class: 'card flush' }, places.map(unfiledRow)),
  );
}

// --- one transaction ------------------------------------------------------

function row(txn) {
  const marks = [];
  if (txn.status === 'pending') marks.push(el('span', { class: 'badge pending', text: 'pending' }));
  if (txn.is_transfer) {
    marks.push(el('span', {
      class: 'badge transfer',
      title: `Paired with ${txn.pair_account_name || ''} ${txn.pair_masked_number || ''} on ${formatDate(txn.pair_date)}`,
      text: 'transfer',
    }));
  }
  if (txn.one_off) marks.push(el('span', { class: 'badge', text: 'one off' }));
  if (txn.category_source === 'manual') marks.push(el('span', { class: 'badge', text: 'set by hand' }));

  // Changing this pins the category, so rules leave the row alone afterwards.
  const picker = categoryPicker(txn.category_id ?? '');
  picker.querySelector('option').textContent = 'Uncategorised';
  picker.addEventListener('change', async () => {
    try {
      await api(`/api/transactions/${txn.id}/category`, {
        method: 'POST',
        body: { category_id: picker.value || null },
      });
      showError('');
    } catch (err) {
      showError(err.message);
    }
  });

  // Marking a purchase as a one off keeps it in every total and out of every
  // rate. It could only be done from the Forecast page, which shows the large
  // ones at rare merchants; here you are already looking at the row.
  const once = el('button', { class: 'small', text: txn.one_off ? 'Put back in the rate' : 'A one off' });
  once.addEventListener('click', async () => {
    once.disabled = true;
    try {
      await api('/api/spending/one-off', {
        method: 'POST',
        body: { ids: [txn.id], one_off: !txn.one_off },
      });
      showError('');
      await load(true);
    } catch (err) {
      showError(err.message);
      once.disabled = false;
    }
  });

  const detail = el('div', { style: 'display:none;padding:12px 16px;border-top:1px solid var(--line)' }, [
    el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, [picker, txn.amount < 0 ? once : null]),
    txn.display_description && txn.display_description !== txn.description
      ? el('p', { class: 'muted small', style: 'margin:10px 0 0', text: `The bank called it: ${txn.description}` })
      : null,
  ]);

  const line = el('div', { class: 'item', id: txn.id, style: 'cursor:pointer' }, [
    el('span', { class: 'grow' }, [
      el('span', { class: 't truncate', text: txn.display_description || txn.description || 'Not described by the bank' }),
      el('span', { class: 's truncate', text: `${formatDate(txn.txn_date)}, ${txn.bank} ${txn.masked_number || ''}`
        + `${txn.category_name ? `, ${txn.category_name}` : ''}` }),
    ]),
    ...marks,
    el('span', { class: `amount ${amountClass(txn.amount)}`, text: formatAmount(txn.amount) }),
  ]);
  line.addEventListener('click', () => {
    detail.style.display = detail.style.display === 'none' ? '' : 'none';
  });

  return el('div', {}, [line, detail]);
}

// What the filters currently say, in words, so a collapsed panel still tells
// you whether you are looking at everything or at a slice.
function describeFilters(total, net) {
  const bits = [];
  const search = document.getElementById('search').value;
  const account = document.getElementById('account');
  const category = document.getElementById('category');
  const from = document.getElementById('from').value;
  const to = document.getElementById('to').value;
  if (search) bits.push(`"${search}"`);
  if (account.value) bits.push(account.selectedOptions[0].textContent.trim());
  if (category.value) bits.push(category.selectedOptions[0].textContent.trim());
  if (from || to) bits.push(`${from || 'the start'} to ${to || 'today'}`);
  if (document.getElementById('status').value) bits.push(document.getElementById('status').value);
  if (document.getElementById('transfer').value === 'true') bits.push('transfers only');
  if (document.getElementById('transfer').value === 'false') bits.push('no transfers');

  document.getElementById('filterSummary').textContent = bits.length
    ? `${bits.join(', ')} — ${total} found, net ${formatAmount(net)}`
    : `Everything, newest first — ${total} in total, net ${formatAmount(net)}`;
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

    let card = list.querySelector('.card');
    if (!card) {
      card = el('div', { class: 'card flush' });
      list.innerHTML = '';
      list.append(card);
    }
    for (const txn of data.transactions) card.append(row(txn));

    if (!data.total) list.innerHTML = '<p class="empty">Nothing matches that.</p>';
    describeFilters(data.total, data.net);

    offset += data.transactions.length;
    document.getElementById('more').style.display = offset < data.total ? '' : 'none';
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

// --- wiring ---------------------------------------------------------------

try {
  const [{ accounts }, categoryData] = await Promise.all([api('/api/accounts'), api('/api/categories')]);
  groups = categoryData.groups;

  const categoryFilter = document.getElementById('category');
  categoryFilter.append(el('option', { value: '', text: 'All' }));
  categoryFilter.append(el('option', { value: 'none', text: 'Uncategorised' }));
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

  // Another page linking straight to a slice. from, to and search were missing
  // from this list, so the allowance page's "find it" link, which passes a month
  // as from and to, landed on the unfiltered table and looked like it had done
  // nothing at all.
  const incoming = new URLSearchParams(window.location.search);
  const MAP = [
    ['account_id', 'account'], ['status', 'status'], ['transfer', 'transfer'],
    ['category_id', 'category'], ['from', 'from'], ['to', 'to'], ['search', 'search'],
  ];
  let filtered = false;
  for (const [key, id] of MAP) {
    if (incoming.get(key)) {
      document.getElementById(id).value = incoming.get(key);
      filtered = true;
    }
  }
  // A slice arrived from elsewhere, so show which one rather than hiding it
  // behind a summary the person did not choose.
  if (filtered) document.getElementById('filterBox').open = true;
} catch (err) {
  showError(err.message);
}

document.getElementById('apply').addEventListener('click', () => load(true));
document.getElementById('more').addEventListener('click', () => load(false));
document.getElementById('reset').addEventListener('click', () => {
  for (const id of FILTERS) document.getElementById(id).value = '';
  load(true);
});
document.getElementById('search').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') load(true);
});

await loadUnfiled();
await load(true);
