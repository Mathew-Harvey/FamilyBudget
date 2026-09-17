// The taxonomy everything is filed under.
//
// The page used to be twenty five editable text boxes, each squeezed to half a
// word by the kind dropdown beside it: "Groceries an", "Home improv", "Personal
// car". Nobody renames a category twice a year, and the field that mattered had
// the least room of anything on the screen.
//
// A name is text now and becomes a field when you click it. What takes the
// space instead is how much each category is actually carrying, because that is
// the only question this page can answer that nothing else can: whether the
// taxonomy fits the spending, or whether half of it has never been used.
import { api, el, formatAmount, renderNav, showError, pageIntro } from '/app.js';

renderNav('/categories');
pageIntro('Categories',
  'What everything is filed under. Most of this is set up already, and it only '
  + 'needs you when the bank starts sending something that fits nowhere.');

const KINDS = ['expense', 'income', 'transfer', 'ignore'];
let groups = [];
let busiest = 1;

function categorySelect(selectedId, onChange) {
  const options = [el('option', { value: '', text: 'Not mapped' })];
  for (const group of groups) {
    const optgroup = el('optgroup', { label: group.name });
    for (const category of group.categories) {
      optgroup.append(
        el('option', { value: category.id, text: category.name, selected: category.id === selectedId }),
      );
    }
    options.push(optgroup);
  }
  return el('select', { onChange, style: 'max-width:15rem' }, options);
}

// The name reads as text until somebody wants to change it. An input that is
// always an input invites edits nobody came here to make, and costs the width
// that the name needs to be readable at all.
function editableName(category) {
  const label = el('span', { class: 't', text: category.name, style: 'cursor:text' });
  label.addEventListener('click', (event) => {
    event.stopPropagation();
    const field = el('input', { value: category.name, style: 'max-width:16rem' });
    const commit = async () => {
      const name = field.value.trim();
      if (!name || name === category.name) {
        field.replaceWith(label);
        return;
      }
      await act(() => api(`/api/categories/${category.id}`, { method: 'POST', body: { name } }));
    };
    field.addEventListener('blur', commit);
    field.addEventListener('keydown', (key) => {
      if (key.key === 'Enter') field.blur();
      if (key.key === 'Escape') field.replaceWith(label);
    });
    label.replaceWith(field);
    field.focus();
    field.select();
  });
  return label;
}

function categoryRow(category) {
  const count = Number(category.transaction_count) || 0;
  const share = busiest > 0 ? Math.min(count / busiest, 1) : 0;

  const kind = el('select', {
    style: 'max-width:8rem',
    onChange: (event) => save(category.id, { kind: event.target.value }),
  }, KINDS.map((value) => el('option', { value, text: value, selected: value === category.kind })));

  const remove = el('button', { class: 'small', text: 'Delete' });
  remove.addEventListener('click', async () => {
    if (count > 0 && !window.confirm(
      `${category.name} is filing ${count} transactions. They go back to having no `
      + 'category at all. Continue?')) return;
    await act(() => api(`/api/categories/${category.id}`, { method: 'DELETE' }));
  });

  const detail = el('div', { style: 'display:none;padding:10px 16px 14px;border-top:1px solid var(--line)' }, [
    el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, [
      el('label', { style: 'flex:none', text: 'Counts as' }),
      kind,
      remove,
    ]),
  ]);

  const line = el('div', { class: 'item', style: 'cursor:pointer' }, [
    el('span', { class: 'grow' }, [
      editableName(category),
      // Length says how busy this one is against the busiest in the household,
      // so a taxonomy with a long tail of unused categories looks like one.
      count > 0 ? el('div', { class: 'track' }, [
        el('i', { style: `width:${(share * 100).toFixed(1)}%;background:var(--accent)` }),
      ]) : null,
    ]),
    el('span', { class: count ? 'amount' : 'muted small',
      text: count ? `${count}` : 'unused' }),
  ]);
  line.addEventListener('click', () => {
    detail.style.display = detail.style.display === 'none' ? '' : 'none';
  });

  return el('div', {}, [line, detail]);
}

function groupCard(group) {
  const name = el('input', { placeholder: 'A new one', style: 'max-width:16rem' });
  const add = el('button', { class: 'small primary', text: 'Add' });
  add.addEventListener('click', async () => {
    if (!name.value.trim()) return;
    add.disabled = true;
    await act(() => api('/api/categories', {
      method: 'POST',
      body: { parent_id: group.id, name: name.value.trim(), kind: group.kind },
    }));
  });

  const used = group.categories.filter((c) => Number(c.transaction_count) > 0).length;

  return el('div', {}, [
    el('div', { class: 'sec', style: 'display:flex;gap:8px;align-items:baseline' }, [
      el('span', { text: group.name }),
      el('span', { class: 'note', text: `${used} of ${group.categories.length} in use` }),
    ]),
    el('div', { class: 'card flush' }, [
      ...group.categories.map(categoryRow),
      el('div', { class: 'item' }, [
        el('span', { class: 'grow' }, [name]),
        add,
      ]),
    ]),
  ]);
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

async function save(id, body) {
  try {
    await api(`/api/categories/${id}`, { method: 'POST', body });
    showError('');
    await load();
  } catch (err) {
    showError(err.message);
  }
}

async function saveProvider(providerCategory, categoryId) {
  try {
    await api('/api/categories/provider-map', {
      method: 'POST',
      body: { provider_category: providerCategory, category_id: categoryId },
    });
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

async function loadProviderMap() {
  const { mappings } = await api('/api/categories/provider-map');
  const mapped = mappings.filter((m) => m.category_id).length;
  document.getElementById('providerSummary').textContent =
    `${mappings.length} bank labels, ${mapped} pointed at a category`;

  const holder = document.getElementById('provider');
  holder.innerHTML = '';
  holder.append(el('div', { class: 'card flush' }, mappings.map((mapping) =>
    el('div', { class: 'item', style: 'flex-wrap:wrap' }, [
      el('span', { class: 'grow', style: 'min-width:11rem' }, [
        el('span', { class: 't', text: mapping.provider_category }),
        el('span', { class: 's', text: Number(mapping.transaction_count)
          ? `${mapping.transaction_count} transactions arrived with this label`
          : 'never seen yet' }),
      ]),
      categorySelect(mapping.category_id, (event) =>
        saveProvider(mapping.provider_category, event.target.value || null)),
    ]))));
}

async function load() {
  const data = await api('/api/categories');
  groups = data.groups;

  const all = groups.flatMap((group) => group.categories);
  busiest = Math.max(...all.map((c) => Number(c.transaction_count) || 0), 1);
  const used = all.filter((c) => Number(c.transaction_count) > 0).length;

  // What this page can say that no other can: whether the taxonomy fits. A long
  // tail of categories nothing has ever been filed under usually means the
  // filing has not been done rather than that the categories are wrong, so it
  // says which, and where to go.
  const { rows: unfiled } = await api('/api/transactions/unfiled');
  const head = document.getElementById('head');
  head.innerHTML = '';
  head.append(el('div', { class: 'card' }, [
    el('span', { class: 'state' }, [
      el('span', { class: 'dot', style: 'background:var(--accent)' }),
      el('span', { text: `${all.length} categories in ${groups.length} groups` }),
    ]),
    el('div', { class: 'figure', text: `${used}` }),
    el('div', { class: 'delta' }, [
      el('span', { class: 'q', text: 'of them have anything filed under them' }),
    ]),
    unfiled > 0 ? el('p', { class: 'muted small', style: 'margin:12px 0 0' }, [
      el('span', { text: `${unfiled} transactions have no category yet, which is why `
        + 'most of these look unused. ' }),
      el('a', { href: '/transactions', text: 'File them' }),
    ]) : null,
  ]));

  const tree = document.getElementById('tree');
  tree.innerHTML = '';
  for (const group of groups) tree.append(groupCard(group));
  await loadProviderMap();
}

document.getElementById('recategorise').addEventListener('click', async () => {
  const button = document.getElementById('recategorise');
  const state = document.getElementById('state');
  button.disabled = true;
  state.textContent = 'Working...';
  try {
    const { changed } = await api('/api/categories/recategorise', { method: 'POST' });
    state.textContent = changed
      ? `${changed} transactions moved.`
      : 'Nothing moved, everything was already where the rules put it.';
    await load();
  } catch (err) {
    showError(err.message);
  } finally {
    button.disabled = false;
  }
});

try {
  await load();
} catch (err) {
  showError(err.message);
}
