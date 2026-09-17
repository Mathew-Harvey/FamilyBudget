// What the app is waiting on you for.
//
// This was the Set up index: eleven identical rows, and you read all eleven to
// find the one that needed you. It counted what was waiting, which helped, but
// it was still a list of pages. It is a queue of decisions now. Each row is one
// kind of decision the app cannot take for you, with how many and why, and it
// links to where the decision is made, or makes it here when the decision is
// small enough. When nothing is waiting it says so, which is most of the time.
//
// The pages you set once, accounts, the pay cycle, categories, rules, the bank
// read, alerts, are still here, under the queue, quiet. You touch them a
// handful of times and then never, and they were taking the same space as the
// forty two transfers waiting on a decision.
import { api, el, renderNav, showError, formatWhen, formatAmount, formatDay, SETUP_PAGES } from '/app.js';

renderNav('/setup');

// --- one offs, decided here ------------------------------------------------

// Large amounts at places barely seen. A one off stays in every total and on
// every page, because it happened; it comes out of the rate only, and only
// when somebody marks it. Nothing else in the app will decide this, so the
// candidates are offered here with the one button, rather than behind a link.
async function oneOffs(holder) {
  holder.innerHTML = '';
  const { candidates } = await api('/api/spending/one-off-candidates');
  const waiting = candidates.filter((row) => !row.one_off);
  if (!waiting.length) return;
  holder.append(el('div', { class: 'inside' }, waiting.slice(0, 12).map((row) => {
    const mark = el('button', { class: 'primary small', text: 'A one off' });
    mark.addEventListener('click', async () => {
      mark.disabled = true;
      try {
        await api('/api/spending/one-off', { method: 'POST', body: { ids: [row.id], one_off: true } });
        showError('');
        await load();
      } catch (err) {
        showError(err.message);
        mark.disabled = false;
      }
    });
    return el('div', { class: 'item' }, [
      el('span', { class: 'grow' }, [
        el('span', { class: 't truncate', text: row.place }),
        el('span', { class: 's', text: `${formatDay(row.txn_date, { year: true })}, paid on ${row.days_paid} `
          + `day${row.days_paid === 1 ? '' : 's'}${row.category ? `, ${row.category}` : ''}` }),
      ]),
      el('span', { class: 'amount out', text: formatAmount(row.amount) }),
      mark,
    ]);
  })));
}

// --- the queue ------------------------------------------------------------

// Each kind of decision, from the counts. Only the ones with something waiting
// are rows; the rest are silence.
function queueRows(s) {
  const rows = [];
  const n = (count, one, many) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

  if (s.transfers_waiting) {
    rows.push({ href: '/transfers', title: n(s.transfers_waiting, 'transfer to confirm', 'transfers to confirm'),
      why: 'two sides of one move between your own accounts, grouped so the same standing transfer is one decision' });
  }
  if (s.unfiled_places) {
    rows.push({ href: '/transactions', title: n(s.unfiled_places, 'place to file', 'places to file'),
      why: `${s.uncategorised.toLocaleString()} transactions with no category. Filing a place writes a rule, so it stays filed.` });
  }
  if (s.unjudged) {
    rows.push({ href: '/spending', title: n(s.unjudged, 'repeating cost to judge', 'repeating costs to judge'),
      why: 'must pay, could trim or optional. The plan treats them as optional until you say, and will not offer to stop them.' });
  }
  if (s.one_off_candidates) {
    rows.push({ inline: oneOffs, title: n(s.one_off_candidates, 'large amount to look at', 'large amounts to look at'),
      why: 'at places barely seen. A one off stays in every total but comes out of the rate, and only you can say which it is.' });
  }
  if (s.accounts_unset) {
    rows.push({ href: '/accounts', title: n(s.accounts_unset, 'account with no role', 'accounts with no role'),
      why: 'whether it is a mortgage, a card or savings, and whether it counts as spendable cash' });
  }
  if (!s.last_sync) {
    rows.push({ href: '/sync', title: 'The banks have never been read', why: 'nothing on any page is real until they are' });
  } else if (s.last_sync.status !== 'success') {
    rows.push({ href: '/sync', title: 'The last bank read failed',
      why: `${formatWhen(s.last_sync.at)}. Everything is as of the read before it.` });
  }
  return rows;
}

async function renderQueue(s) {
  const rows = queueRows(s);
  const head = document.getElementById('head');
  head.innerHTML = '';
  head.append(el('div', { class: 'card' }, [
    el('span', { class: `state ${rows.length ? 'warn' : 'ok'}` }, [
      el('span', { class: 'dot' }),
      el('span', { text: rows.length ? 'Waiting on you' : 'Nothing is waiting on you' }),
    ]),
    el('div', { class: 'figure', text: String(rows.length) }),
    el('div', { class: 'delta' }, [
      el('span', { class: 'q', text: rows.length === 1
        ? 'kind of decision the app cannot take for you'
        : 'kinds of decision the app cannot take for you' }),
    ]),
  ]));

  const queue = document.getElementById('queue');
  queue.innerHTML = '';
  if (!rows.length) return;
  queue.append(el('div', { class: 'card flush' }, await Promise.all(rows.map(async (row) => {
    const line = el(row.href ? 'a' : 'div', {
      class: 'item', href: row.href ?? null, style: 'text-decoration:none;color:inherit',
    }, [
      el('span', { class: 'grow' }, [
        el('span', { class: 't', text: row.title }),
        el('span', { class: 's', text: row.why }),
      ]),
      el('span', { class: 'muted', text: row.href ? '›' : '', style: 'font-size:1.2rem' }),
    ]);
    if (!row.inline) return line;
    // Decided here. The row opens on the candidates with the one button each.
    const body = el('div');
    await row.inline(body);
    return el('div', {}, [line, body]);
  }))));
}

// --- set up once ----------------------------------------------------------

// The quiet facts about the pages you set once. Never a todo: anything that
// needs you is a row in the queue above, and the same thing must not be said
// twice in two tones.
function noteFor(href, s) {
  switch (href) {
    case '/allowance':
      return s.allowance_chosen ? 'a number you chose' : 'following what you spend';
    case '/rules':
      return s.rules ? `${s.rules} rules` : null;
    case '/sync':
      return s.last_sync?.status === 'success' ? `read ${formatWhen(s.last_sync.at)}` : null;
    case '/alerts':
      return s.alerts_on ? 'on' : 'off';
    case '/insights':
      return s.analysis_on ? 'on' : 'off';
    default:
      return null;
  }
}

// Pages that exist only as a decision in the queue. They stay in SETUP_PAGES,
// which is the registry the crumb and the nav highlight are built from, and
// are left out of this list so "28 transfers to confirm" is not followed by
// "Transfers to confirm" with no number under it.
const QUEUE_ONLY = new Set(['/transfers']);

function renderSettings(status) {
  const groups = document.getElementById('groups');
  groups.innerHTML = '';
  groups.append(el('div', { class: 'sec', text: 'Set up once' }));
  for (const [title, allRows] of SETUP_PAGES) {
    const rows = allRows.filter(([href]) => !QUEUE_ONLY.has(href));
    if (!rows.length) continue;
    groups.append(el('p', { class: 'muted small', style: 'margin:-2px 0 6px', text: title }));
    groups.append(el('div', { class: 'card flush' }, rows.map(([href, label, why]) => {
      const note = status ? noteFor(href, status) : null;
      return el('a', { class: 'item', href, style: 'text-decoration:none;color:inherit' }, [
        el('span', { class: 'grow' }, [
          el('span', { class: 't', text: label }),
          el('span', { class: 's', text: why }),
        ]),
        note ? el('span', { class: 'note', text: note }) : null,
        el('span', { class: 'muted', text: '›', style: 'font-size:1.2rem' }),
      ]);
    })));
  }
}

// --- wiring ---------------------------------------------------------------

async function load() {
  try {
    const [me, status] = await Promise.all([api('/api/auth/me'), api('/api/setup')]);
    await renderQueue(status);
    renderSettings(status);
    document.getElementById('who').textContent = me.email;
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

renderSettings(null);
document.getElementById('out').append(
  el('div', { class: 'sec', text: 'This browser' }),
  el('div', { class: 'card' }, [
    el('div', { class: 'row spread' }, [
      el('span', { class: 'grow' }, [
        el('span', { class: 't', text: 'Signed in' }),
        el('span', { class: 's', id: 'who', text: 'Checking...' }),
      ]),
      el('button', {
        text: 'Sign out',
        onClick: async () => {
          await api('/api/auth/logout', { method: 'POST' });
          window.location.href = '/login';
        },
      }),
    ]),
  ]),
);

await load();
