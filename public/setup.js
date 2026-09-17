// The workshop. Eight of the old thirteen tabs were this: teaching the app what
// things are, rather than looking at what the money did. They are grouped by
// why you would come here, and the list itself lives in app.js so the nav and
// this page cannot disagree about what exists.
//
// Each row carries what that page would say. Eleven identical links cannot tell
// you which one needs you, so you read all eleven every time: 42 transfers
// waiting on a decision looked exactly like none waiting. A row that has
// something to say says it, and the ones with nothing to say stay quiet, which
// is most of them most of the time.
import { api, el, renderNav, showError, formatWhen, SETUP_PAGES } from '/app.js';

renderNav('/setup');

// What each page reports, given the counts. A tone of 'todo' is work someone
// has to do, 'off' is a feature switched off on purpose, and no tone at all is
// just a fact worth seeing on the way past.
function noteFor(href, s) {
  switch (href) {
    case '/transfers':
      return s.transfers_waiting
        ? { tone: 'todo', text: `${s.transfers_waiting} waiting on you` }
        : { text: 'all reviewed' };
    case '/transactions':
      return s.uncategorised
        ? { tone: 'todo', text: `${s.uncategorised.toLocaleString()} with no category` }
        : { text: 'all filed' };
    case '/accounts':
      return s.accounts_unset
        ? { tone: 'todo', text: `${s.accounts_unset} with no role set` }
        : null;
    case '/allowance':
      // Not a todo. Following the spending is the honest default rather than
      // an unfinished job, and Today stays quiet about it for the same reason:
      // there is nothing to warn about while the plan and the household agree.
      return s.allowance_chosen
        ? { text: 'a number you chose' }
        : { text: 'following what you spend' };
    case '/forecast':
      return s.commitments ? { text: `${s.commitments} repeating costs` } : null;
    case '/rules':
      return s.rules ? { text: `${s.rules} rules` } : null;
    case '/sync':
      if (!s.last_sync) return { tone: 'todo', text: 'never run' };
      return s.last_sync.status === 'success'
        ? { text: `read ${formatWhen(s.last_sync.at)}` }
        : { tone: 'bad', text: `last run failed, ${formatWhen(s.last_sync.at)}` };
    case '/alerts':
      return s.alerts_on ? { text: 'on' } : { tone: 'off', text: 'off' };
    case '/insights':
      return s.analysis_on ? { text: 'on' } : { tone: 'off', text: 'off' };
    default:
      return null;
  }
}

function render(status) {
  const groups = document.getElementById('groups');
  groups.innerHTML = '';
  for (const [title, rows] of SETUP_PAGES) {
    groups.append(el('div', { class: 'sec', text: title }));
    groups.append(el('div', { class: 'card flush' }, rows.map(([href, label, why]) => {
      const note = status ? noteFor(href, status) : null;
      return el('a', { class: 'item', href, style: 'text-decoration:none;color:inherit' }, [
        el('span', { class: 'grow' }, [
          el('span', { class: 't', text: label }),
          el('span', { class: 's', text: why }),
        ]),
        note ? el('span', { class: `note ${note.tone ?? ''}`, text: note.text }) : null,
        el('span', { class: 'muted', text: '›', style: 'font-size:1.2rem' }),
      ]);
    })));
  }
}

render(null);

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

try {
  const [me, status] = await Promise.all([
    api('/api/auth/me'),
    api('/api/setup'),
  ]);
  document.getElementById('who').textContent = me.email;
  render(status);

  // What is actually outstanding, said once at the top rather than left for
  // someone to find by opening each page in turn.
  const todo = SETUP_PAGES
    .flatMap(([, rows]) => rows)
    .map(([href, label]) => [label, href, noteFor(href, status)])
    .filter(([, , note]) => note && (note.tone === 'todo' || note.tone === 'bad'));

  const head = document.getElementById('head');
  head.innerHTML = '';
  if (todo.length) {
    head.append(el('div', { class: 'nudge' }, [
      el('h3', { text: todo.length === 1 ? 'One thing is waiting' : `${todo.length} things are waiting` }),
      el('div', { style: 'margin-top:8px' }, todo.map(([label, href, note]) =>
        el('a', { href, class: 'row spread', style: 'text-decoration:none;color:inherit;padding:4px 0' }, [
          el('span', { class: 'grow', text: label }),
          el('span', { class: `note ${note.tone}`, text: note.text }),
        ]))),
    ]));
  }
} catch (err) {
  showError(err.message);
}
