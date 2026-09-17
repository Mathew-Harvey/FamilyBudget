// Money moving between our own accounts is not spending.
//
// The detector pairs the unambiguous ones and a person confirms them. On this
// household that was 42 pairs, offered one at a time down a page eight thousand
// pixels long, each as a two column card with its own two buttons. Forty two
// identical judgements about the same handful of standing transfers.
//
// So they are grouped by what they are: the two accounts and the amount. A
// fortnightly 500 dollars from the everyday account to savings is one decision
// that happened thirteen times, and deciding it once is what the person was
// really doing each of those thirteen times. The individual pairs are still
// there to open and still confirmable on their own, because a group is a
// convenience and never a claim that the rows are interchangeable.
import { api, el, formatAmount, formatDate, renderNav, showError, pageIntro } from '/app.js';

renderNav('/transfers');
pageIntro('Transfers to confirm',
  'Money moving between your own accounts is not spending, so it is kept out of '
  + 'the budget. These were paired automatically and are waiting on you.');

const ARROW = '→';

const accountOf = (bank, masked) => `${bank || ''} ${masked || ''}`.trim();

async function act(path, body, buttons) {
  for (const button of buttons) button.disabled = true;
  try {
    await api(path, { method: 'POST', body });
    await refresh();
  } catch (err) {
    showError(err.message);
    for (const button of buttons) button.disabled = false;
  }
}

// The same two accounts and the same amount is the same standing transfer.
// Amounts are grouped on their 2dp text, never as a number: these are exact
// decimals out of the database and comparing them as text cannot round.
function groupPairs(pairs) {
  const groups = new Map();
  for (const pair of pairs) {
    // Which side is "from" is the side the money left, not whichever uuid
    // sorted first. The query picks one row per pair with t.id < p.id, so
    // without this the same standing transfer forms two groups pointing at
    // each other: six kinds of move on this household where there are three.
    const out = String(pair.amount).startsWith('-');
    const from = accountOf(
      out ? pair.bank : pair.pair_bank,
      out ? pair.masked_number : pair.pair_masked_number,
    );
    const to = accountOf(
      out ? pair.pair_bank : pair.bank,
      out ? pair.pair_masked_number : pair.masked_number,
    );
    const amount = String(pair.amount).replace('-', '');
    // Encoded rather than joined with a separator: account names contain
    // spaces, so a space delimited key can be split more than one way.
    const key = JSON.stringify([from, to, amount]);
    if (!groups.has(key)) groups.set(key, { from, to, amount, pairs: [] });
    groups.get(key).pairs.push(pair);
  }
  return [...groups.values()].sort((a, b) => b.pairs.length - a.pairs.length);
}

function pairLine(pair) {
  const yes = el('button', { class: 'small', text: 'Yes' });
  const no = el('button', { class: 'small', text: 'No' });
  const body = { id: pair.id, pair_id: pair.pair_id };
  yes.addEventListener('click', () => act('/api/transfers/confirm', body, [yes, no]));
  no.addEventListener('click', () => act('/api/transfers/reject', body, [yes, no]));
  return el('div', { class: 'item' }, [
    el('span', { class: 'grow' }, [
      el('span', { class: 't', text: formatDate(pair.txn_date) }),
      el('span', { class: 's truncate',
        text: `${pair.description || ''} ${ARROW} ${pair.pair_description || ''}` }),
    ]),
    yes,
    no,
  ]);
}

// One standing transfer: what it is, how many times, and one decision.
function groupCard(group) {
  const body = { pairs: group.pairs.map((pair) => ({ id: pair.id, pair_id: pair.pair_id })) };
  const many = group.pairs.length > 1;
  const yes = el('button', { class: 'primary small', text: many ? `Confirm all ${group.pairs.length}` : 'Confirm' });
  const no = el('button', { class: 'small', text: many ? 'None are transfers' : 'Not a transfer' });
  yes.addEventListener('click', () => act('/api/transfers/confirm-many', body, [yes, no]));
  no.addEventListener('click', () => act('/api/transfers/reject-many', body, [yes, no]));

  const dates = group.pairs.map((pair) => formatDate(pair.txn_date)).sort();
  const detail = el('div', { style: 'display:none;border-top:1px solid var(--line)' },
    group.pairs.map(pairLine));
  const open = el('button', {
    class: 'small',
    text: many ? 'Show each one' : 'Show it',
    onClick: () => { detail.style.display = detail.style.display === 'none' ? '' : 'none'; },
  });

  return el('div', { class: 'card', style: 'padding:0;overflow:hidden' }, [
    el('div', { style: 'padding:15px 17px' }, [
      el('div', { class: 'row spread', style: 'gap:10px' }, [
        el('span', { class: 'grow' }, [
          el('span', { class: 't truncate', text: `${group.from} ${ARROW} ${group.to}` }),
          el('span', { class: 's', text: many
            ? `${group.pairs.length} times, ${dates[0]} to ${dates.at(-1)}`
            : `once, ${dates[0]}` }),
        ]),
        el('span', { class: 'amount', text: formatAmount(group.amount) }),
      ]),
      el('div', { class: 'row', style: 'gap:8px;margin-top:12px;flex-wrap:wrap' }, [yes, no, open]),
    ]),
    detail,
  ]);
}

function candidateCard(candidate) {
  const dollars = (value) => (value / 100).toFixed(2);
  const link = el('button', { class: 'primary small', text: 'These two are a pair' });
  const no = el('button', { class: 'small', text: 'Not a pair' });
  const body = { id: candidate.a.id, pair_id: candidate.b.id };
  link.addEventListener('click', () => act('/api/transfers/link', body, [link, no]));
  no.addEventListener('click', () => act('/api/transfers/reject', body, [link, no]));

  const side = (row) => el('div', { class: 'row spread', style: 'gap:10px;padding:4px 0' }, [
    el('span', { class: 'grow' }, [
      el('span', { class: 't truncate', text: row.description || 'Not described by the bank' }),
      el('span', { class: 's', text: `${formatDate(row.txn_date)}, `
        + accountOf(row.account?.bank, row.account?.masked_number) }),
    ]),
    el('span', { class: 'amount', text: formatAmount(dollars(row.amount_cents)) }),
  ]);

  return el('div', { class: 'card' }, [
    side(candidate.a),
    side(candidate.b),
    el('p', { class: 'muted small', style: 'margin:8px 0 0',
      text: `${candidate.days_apart} day${candidate.days_apart === 1 ? '' : 's'} apart` }),
    el('div', { class: 'row', style: 'gap:8px;margin-top:12px' }, [link, no]),
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

    const waiting = auto.pairs.length;
    const groups = groupPairs(auto.pairs);
    const head = document.getElementById('head');
    head.innerHTML = '';
    head.append(el('div', { class: 'card' }, [
      el('span', { class: `state ${waiting ? 'warn' : 'ok'}` }, [
        el('span', { class: 'dot' }),
        el('span', { text: waiting ? 'Waiting on you' : 'All reviewed' }),
      ]),
      el('div', { class: 'figure', text: String(waiting) }),
      el('div', { class: 'delta' }, [
        el('span', { class: 'q', text: waiting
          ? `pair${waiting === 1 ? '' : 's'} to confirm, and only `
            + `${groups.length} decision${groups.length === 1 ? '' : 's'} to make`
          : `every detected transfer has been reviewed, ${confirmed.pairs.length} confirmed` }),
      ]),
    ]));

    const pairsHolder = document.getElementById('pairs');
    pairsHolder.innerHTML = '';
    if (groups.length) {
      pairsHolder.append(el('div', { class: 'sec', text: 'Grouped by what they are' }));
      for (const group of groups) pairsHolder.append(groupCard(group));
    }

    const candidatesHolder = document.getElementById('candidates');
    candidatesHolder.innerHTML = '';
    if (candidateData.candidates.length) {
      candidatesHolder.append(
        el('div', { class: 'sec', text: 'Could pair more than one way' }),
        el('p', { class: 'muted small', style: 'margin:-4px 0 10px',
          text: 'Nothing was linked automatically because a tie goes to a person. '
            + 'Pick the matching pair, or leave them alone.' }),
      );
      for (const candidate of candidateData.candidates) {
        candidatesHolder.append(candidateCard(candidate));
      }
    }

    const confirmedHolder = document.getElementById('confirmed');
    confirmedHolder.innerHTML = '';
    if (confirmed.pairs.length) {
      confirmedHolder.append(
        el('div', { class: 'sec', text: `Already confirmed, ${confirmed.pairs.length}` }),
        el('div', { class: 'card flush' }, groupPairs(confirmed.pairs).map((group) =>
          el('div', { class: 'item' }, [
            el('span', { class: 'grow' }, [
              el('span', { class: 't truncate', text: `${group.from} ${ARROW} ${group.to}` }),
              el('span', { class: 's', text: `${group.pairs.length} time${group.pairs.length === 1 ? '' : 's'}` }),
            ]),
            el('span', { class: 'amount muted', text: formatAmount(group.amount) }),
          ]))),
      );
    }
  } catch (err) {
    showError(err.message);
  }
}

await refresh();
