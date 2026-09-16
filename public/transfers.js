import { api, el, formatAmount, amountClass, formatDate, renderNav, showError } from '/app.js';

renderNav('/transfers');

function side(label, date, amount, account, description) {
  return el('div', { class: 'grow' }, [
    el('div', { class: 'muted', text: label }),
    el('div', { class: 'row' }, [
      el('span', { class: `amount ${amountClass(amount)}`, text: formatAmount(amount) }),
      el('span', { class: 'muted', text: `${formatDate(date)}, ${account}` }),
    ]),
    el('div', { class: 'truncate', text: description || '' }),
  ]);
}

async function act(path, body, button) {
  button.disabled = true;
  try {
    await api(path, { method: 'POST', body });
    await refresh();
  } catch (err) {
    showError(err.message);
    button.disabled = false;
  }
}

function pairCard(pair, { showActions }) {
  const confirmButton = el('button', { class: 'primary small', text: 'Confirm' });
  confirmButton.addEventListener('click', () =>
    act('/api/transfers/confirm', { id: pair.id, pair_id: pair.pair_id }, confirmButton),
  );
  const rejectButton = el('button', { class: 'small', text: 'Not a transfer' });
  rejectButton.addEventListener('click', () =>
    act('/api/transfers/reject', { id: pair.id, pair_id: pair.pair_id }, rejectButton),
  );

  return el('div', { class: 'card stack' }, [
    el('div', { class: 'row' }, [
      side('From', pair.txn_date, pair.amount, `${pair.bank} ${pair.masked_number || ''}`, pair.description),
      side('To', pair.pair_date, pair.pair_amount, `${pair.pair_bank} ${pair.pair_masked_number || ''}`, pair.pair_description),
    ]),
    showActions ? el('div', { class: 'row' }, [confirmButton, rejectButton]) : null,
  ]);
}

function candidateCard(candidate) {
  const linkButton = el('button', { class: 'primary small', text: 'Link these two' });
  linkButton.addEventListener('click', () =>
    act('/api/transfers/link', { id: candidate.a.id, pair_id: candidate.b.id }, linkButton),
  );
  const rejectButton = el('button', { class: 'small', text: 'Not a pair' });
  rejectButton.addEventListener('click', () =>
    act('/api/transfers/reject', { id: candidate.a.id, pair_id: candidate.b.id }, rejectButton),
  );

  const cents = (value) => (value / 100).toFixed(2);

  return el('div', { class: 'card stack' }, [
    el('div', { class: 'row' }, [
      side(
        'One side',
        candidate.a.txn_date,
        cents(candidate.a.amount_cents),
        `${candidate.a.account?.bank || ''} ${candidate.a.account?.masked_number || ''}`,
        candidate.a.description,
      ),
      side(
        'Other side',
        candidate.b.txn_date,
        cents(candidate.b.amount_cents),
        `${candidate.b.account?.bank || ''} ${candidate.b.account?.masked_number || ''}`,
        candidate.b.description,
      ),
    ]),
    el('div', { class: 'muted', text: `${candidate.days_apart} day(s) apart` }),
    el('div', { class: 'row' }, [linkButton, rejectButton]),
  ]);
}

async function refresh() {
  showError('');
  try {
    const [auto, confirmed, candidateData] = await Promise.all([
      api('/api/transfers/pairs?confidence=auto'),
      api('/api/transfers/pairs?confidence=confirmed'),
      api('/api/transfers/candidates'),
    ]);

    const pairsHolder = document.getElementById('pairs');
    pairsHolder.innerHTML = '';
    if (!auto.pairs.length) {
      pairsHolder.append(el('p', { class: 'empty', text: 'Nothing waiting. Every detected transfer has been reviewed.' }));
    } else {
      for (const pair of auto.pairs) pairsHolder.append(pairCard(pair, { showActions: true }));
    }

    const candidatesHolder = document.getElementById('candidates');
    candidatesHolder.innerHTML = '';
    if (!candidateData.candidates.length) {
      candidatesHolder.append(el('p', { class: 'empty', text: 'Nothing ambiguous.' }));
    } else {
      for (const candidate of candidateData.candidates) candidatesHolder.append(candidateCard(candidate));
    }

    const confirmedHolder = document.getElementById('confirmed');
    confirmedHolder.innerHTML = '';
    if (!confirmed.pairs.length) {
      confirmedHolder.append(el('p', { class: 'muted', text: 'None yet.' }));
    } else {
      confirmedHolder.append(el('p', { class: 'muted', text: `${confirmed.pairs.length} confirmed.` }));
      for (const pair of confirmed.pairs.slice(0, 25)) confirmedHolder.append(pairCard(pair, { showActions: false }));
    }
  } catch (err) {
    showError(err.message);
  }
}

await refresh();
