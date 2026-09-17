// The workshop. Eight of the old thirteen tabs were this: teaching the app what
// things are, rather than looking at what the money did. They are grouped by
// why you would come here, and the list itself lives in app.js so the nav and
// this page cannot disagree about what exists.
import { api, el, renderNav, showError, SETUP_PAGES } from '/app.js';

renderNav('/setup');

const groups = document.getElementById('groups');
for (const [title, rows] of SETUP_PAGES) {
  groups.append(el('div', { class: 'sec', text: title }));
  groups.append(el('div', { class: 'card flush' }, rows.map(([href, label, why]) =>
    el('a', { class: 'item', href, style: 'text-decoration:none;color:inherit' }, [
      el('span', { class: 'grow' }, [
        el('span', { class: 't', text: label }),
        el('span', { class: 's', text: why }),
      ]),
      el('span', { class: 'muted', text: '›', style: 'font-size:1.2rem' }),
    ]),
  )));
}

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
  const me = await api('/api/auth/me');
  document.getElementById('who').textContent = me.email;
} catch (err) {
  showError(err.message);
}
