import { api, el, formatAmount, amountClass, formatDate, renderNav, showError } from '/app.js';

renderNav('/accounts');

const ROLES = [
  ['', 'Not set'],
  ['joint_everyday', 'Joint everyday'],
  ['personal_everyday', 'Personal everyday'],
  ['personal_savings', 'Personal savings'],
  ['mortgage', 'Mortgage'],
  ['other', 'Other'],
];

function card(account) {
  const roleSelect = el(
    'select',
    {
      onChange: async (event) => {
        try {
          await api(`/api/accounts/${account.id}`, {
            method: 'POST',
            body: { role: event.target.value || null },
          });
          showError('');
        } catch (err) {
          showError(err.message);
        }
      },
    },
    ROLES.map(([value, label]) =>
      el('option', { value, text: label, selected: (account.role || '') === value }),
    ),
  );

  const liquidToggle = el('input', {
    type: 'checkbox',
    checked: account.is_liquid,
    id: `liquid-${account.id}`,
    onChange: async (event) => {
      try {
        await api(`/api/accounts/${account.id}`, {
          method: 'POST',
          body: { is_liquid: event.target.checked },
        });
        showError('');
      } catch (err) {
        showError(err.message);
      }
    },
  });

  const balance = account.latest_balance;

  return el('div', { class: 'card stack' }, [
    el('div', { class: 'spread' }, [
      el('div', {}, [
        el('strong', { text: account.name }),
        el('div', { class: 'muted' }, [
          `${account.bank} ${account.masked_number || ''} `,
          el('span', { class: 'badge', text: account.type || 'unknown' }),
          account.source === 'manual' ? el('span', { class: 'badge', text: 'manual' }) : null,
        ]),
      ]),
      el('div', { style: 'text-align:right' }, [
        el('div', {
          class: `amount ${amountClass(balance)}`,
          text: balance === null || balance === undefined ? 'no balance yet' : formatAmount(balance),
        }),
        el('div', {
          class: 'muted',
          text: account.latest_balance_date
            ? `as at ${formatDate(account.latest_balance_date)}${account.balance_freshness ? ` (${account.balance_freshness})` : ''}`
            : '',
        }),
      ]),
    ]),
    el('div', { class: 'muted' }, [
      `${account.transaction_count} transactions`,
      account.earliest_transaction
        ? ` from ${formatDate(account.earliest_transaction)} to ${formatDate(account.latest_transaction)}`
        : ' (none yet)',
      account.latest_available_balance !== null && account.latest_available_balance !== undefined
        ? ` . available ${formatAmount(account.latest_available_balance)}`
        : '',
    ]),
    el('div', { class: 'row' }, [
      el('div', {}, [el('label', { for: `role-${account.id}`, text: 'Role' }), roleSelect]),
      el('div', {}, [
        el('label', { for: `liquid-${account.id}`, text: 'Spendable cash' }),
        el('div', { class: 'row' }, [liquidToggle, el('label', { for: `liquid-${account.id}`, text: 'is liquid', style: 'margin:0' })]),
      ]),
    ]),
  ]);
}

try {
  const { accounts } = await api('/api/accounts');
  const list = document.getElementById('list');
  list.innerHTML = '';
  if (!accounts.length) {
    list.append(el('p', { class: 'empty', text: 'No accounts yet. Run a sync.' }));
  } else {
    for (const account of accounts) list.append(card(account));
  }
} catch (err) {
  showError(err.message);
  document.getElementById('list').innerHTML = '';
}
