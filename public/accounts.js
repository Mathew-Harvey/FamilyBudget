// What each account is for, and whether its money is actually spendable.
//
// That second question is the page's whole job and it used to be a tick box
// three quarters of the way down a card, with the answer, how much spendable
// cash there is, printed nowhere at all. It leads now, because a wrong tick
// here moves every figure in the app: the mortgage redraw counted as cash
// would add a hundred thousand dollars of runway that has to be borrowed back.
import { api, el, formatAmount, amountClass, formatDate, formatWhen, renderNav, showError, pageIntro } from '/app.js';

renderNav('/accounts');
pageIntro('Accounts',
  'Check these against your banking apps. Only what is ticked as spendable is '
  + 'counted as cash you have.');

const ROLES = [
  ['', 'Not set'],
  ['joint_everyday', 'Joint everyday'],
  ['personal_everyday', 'Personal everyday'],
  ['personal_savings', 'Personal savings'],
  ['mortgage', 'Mortgage'],
  ['credit_card', 'Credit card'],
  ['personal_loan', 'Personal loan'],
  ['other', 'Other'],
];

const cents = (value) => Math.round(Number(value ?? 0) * 100);

async function save(id, body) {
  try {
    await api(`/api/accounts/${id}`, { method: 'POST', body });
    showError('');
    await load();
  } catch (err) {
    showError(err.message);
  }
}

// One account, one line. The switch is the subject, so it sits at the end of
// the row where the eye lands, and the role picker only opens if you want it.
function row(account) {
  const balance = account.latest_balance;
  const liquid = el('input', {
    type: 'checkbox', class: 'switch',
    'aria-label': `Count ${account.name} as spendable cash`,
  });
  liquid.checked = Boolean(account.is_liquid);
  liquid.addEventListener('change', () => save(account.id, { is_liquid: liquid.checked }));

  const roles = el('select', {
    style: 'max-width:12rem',
    onChange: (event) => save(account.id, { role: event.target.value || null }),
  }, ROLES.map(([value, label]) =>
    el('option', { value, text: label, selected: (account.role || '') === value })));

  const detail = el('div', { style: 'display:none;padding:12px 16px;border-top:1px solid var(--line)' }, [
    el('div', { class: 'row', style: 'gap:10px;flex-wrap:wrap' }, [
      el('label', { style: 'flex:none', text: 'What it is for' }),
      roles,
    ]),
    el('p', { class: 'muted small', style: 'margin:10px 0 0', text:
      `${account.transaction_count} transactions`
      + (account.earliest_transaction
        ? `, ${formatDate(account.earliest_transaction)} to ${formatDate(account.latest_transaction)}`
        : ', none yet')
      + (account.latest_balance_date
        ? `. Balance ${account.source === 'manual' ? 'set by hand' : 'read'} `
          + formatWhen(account.latest_balance_date)
        : '') }),
    account.source === 'manual' ? manualBalance(account) : null,
  ]);

  const line = el('div', { class: 'item', style: 'cursor:pointer' }, [
    el('span', { class: 'grow' }, [
      el('span', { class: 't truncate', text: account.name }),
      el('span', { class: 's truncate', text: `${account.bank} ${account.masked_number || ''}`
        + `${account.role ? `, ${ROLES.find(([v]) => v === account.role)?.[1].toLowerCase()}` : ''}`
        + `${account.source === 'manual' ? ', entered by hand' : ''}` }),
    ]),
    el('span', { class: `amount ${amountClass(balance)}`,
      text: balance === null || balance === undefined ? 'no balance' : formatAmount(balance) }),
    liquid,
  ]);
  // The switch is inside a clickable row, so its own clicks must not also open
  // the row underneath it.
  for (const control of [liquid]) {
    control.addEventListener('click', (event) => event.stopPropagation());
  }
  line.addEventListener('click', () => {
    detail.style.display = detail.style.display === 'none' ? '' : 'none';
  });

  return el('div', {}, [line, detail]);
}

function group(title, note, accounts) {
  if (!accounts.length) return null;
  return el('div', {}, [
    el('div', { class: 'sec', text: title }),
    note ? el('p', { class: 'muted small', style: 'margin:-4px 0 8px', text: note }) : null,
    el('div', { class: 'card flush' }, accounts.map(row)),
  ]);
}

// A debt open banking cannot reach: a card or loan at a bank we are not
// connected to. It was entered on the Insights page, under "Debts and accounts
// we cannot see", beneath a switch about Claude. It has nothing to do with
// Claude, and an account belongs on the page about accounts.
function manualForm() {
  const bank = el('input', { placeholder: 'Bendigo' });
  const name = el('input', { placeholder: 'The other credit card' });
  const kind = el('select', {}, [
    el('option', { value: 'credit_card', text: 'Credit card' }),
    el('option', { value: 'personal_loan', text: 'Personal loan' }),
    el('option', { value: 'savings', text: 'Savings' }),
    el('option', { value: 'transaction', text: 'Everyday' }),
  ]);
  const balance = el('input', { type: 'number', step: '0.01', placeholder: '6500.00' });
  const add = el('button', { class: 'primary', text: 'Add it' });

  add.addEventListener('click', async () => {
    add.disabled = true;
    try {
      await api('/api/analyst/manual-accounts', {
        method: 'POST',
        body: {
          bank: bank.value,
          name: name.value,
          type: kind.value,
          balance: balance.value || null,
          // Savings and everyday accounts are cash; a card or a loan is a debt.
          is_liquid: ['savings', 'transaction'].includes(kind.value),
        },
      });
      showError('');
      await load();
    } catch (err) {
      showError(err.message);
      add.disabled = false;
    }
  });

  const field = (label, control) => el('div', {}, [el('label', { text: label }), control]);
  return el('details', { class: 'card' }, [
    el('summary', { text: 'Add an account the bank feed cannot see' }),
    el('div', { class: 'stack', style: 'margin-top:14px' }, [
      el('p', { class: 'muted small', style: 'margin:0', text:
        'A card or loan at a bank we are not connected to. Enter it so it counts, '
        + 'and update the balance yourself when you check it.' }),
      el('div', { class: 'filters' }, [
        field('Provider', bank),
        field('What it is', name),
        field('Type', kind),
        field('Amount owed', balance),
      ]),
      el('div', { class: 'row' }, [add]),
    ]),
  ]);
}

// A hand entered balance goes stale the moment it is typed, so it is editable
// here rather than being read only like the ones the bank sends.
function manualBalance(account) {
  const amount = el('input', {
    type: 'number', step: '0.01', style: 'max-width:9rem',
    value: Math.abs(Number(account.latest_balance ?? 0)).toFixed(2),
  });
  const save = el('button', { class: 'small', text: 'Update' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await api(`/api/analyst/manual-accounts/${account.id}/balance`, {
        method: 'POST',
        body: { balance: amount.value },
      });
      showError('');
      await load();
    } catch (err) {
      showError(err.message);
      save.disabled = false;
    }
  });
  const remove = el('button', { class: 'small', text: 'Remove' });
  remove.addEventListener('click', async () => {
    if (!window.confirm(`Remove ${account.name}? Its balance goes with it.`)) return;
    remove.disabled = true;
    try {
      await api(`/api/analyst/manual-accounts/${account.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      showError(err.message);
      remove.disabled = false;
    }
  });
  return el('div', { class: 'row', style: 'gap:8px;margin-top:10px;flex-wrap:wrap' }, [
    el('label', { style: 'flex:none', text: 'Amount owed' }),
    amount, save, remove,
  ]);
}

async function load() {
  const { accounts } = await api('/api/accounts');
  const spendable = accounts.filter((a) => a.is_liquid);
  const rest = accounts.filter((a) => !a.is_liquid);
  const total = spendable.reduce((sum, a) => sum + cents(a.latest_balance), 0);
  const owed = rest.reduce((sum, a) => sum + Math.min(cents(a.latest_balance), 0), 0);
  const oldest = spendable
    .map((a) => a.latest_balance_date)
    .filter(Boolean)
    .sort()[0];

  const head = document.getElementById('head');
  head.innerHTML = '';
  head.append(el('div', { class: 'card' }, [
    el('span', { class: 'state' }, [
      el('span', { class: 'dot', style: 'background:var(--accent)' }),
      el('span', { text: `${spendable.length} of ${accounts.length} count as spendable` }),
    ]),
    el('div', { class: 'figure', text: formatAmount((total / 100).toFixed(2)) }),
    el('div', { class: 'delta' }, [
      el('span', { class: 'q', text: oldest ? `of spendable cash, read ${formatWhen(oldest)}` : 'of spendable cash' }),
    ]),
    owed < 0 ? el('p', { class: 'muted small', style: 'margin:12px 0 0',
      text: `${formatAmount((-owed / 100).toFixed(2))} is owed on the accounts below that. `
        + 'That is a debt, not a negative balance you can spend against.' }) : null,
  ]));

  const list = document.getElementById('list');
  list.innerHTML = '';
  if (!accounts.length) {
    list.append(
      el('p', { class: 'empty', text: 'No accounts yet. Run a sync, or add one by hand.' }),
      manualForm(),
    );
    return;
  }
  list.append(
    group('Spendable cash', 'Everything the forecast is built from.', spendable),
    group('Not spendable', 'Debts, and money we would have to borrow back.', rest),
    manualForm(),
  );
}

try {
  await load();
} catch (err) {
  showError(err.message);
}
