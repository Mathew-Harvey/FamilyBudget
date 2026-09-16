import { api, el, renderNav, showError } from '/app.js';

renderNav('/categories');

const KINDS = ['expense', 'income', 'transfer', 'ignore'];
let groups = [];

function categorySelect(selectedId, onChange, { includeBlank = true } = {}) {
  const options = includeBlank ? [el('option', { value: '', text: 'Not mapped' })] : [];
  for (const group of groups) {
    const optgroup = el('optgroup', { label: group.name });
    for (const category of group.categories) {
      optgroup.append(
        el('option', { value: category.id, text: category.name, selected: category.id === selectedId }),
      );
    }
    options.push(optgroup);
  }
  return el('select', { onChange }, options);
}

function categoryRow(category) {
  const kindSelect = el(
    'select',
    {
      class: 'small',
      onChange: async (e) => save(category.id, { kind: e.target.value }),
    },
    KINDS.map((k) => el('option', { value: k, text: k, selected: k === category.kind })),
  );

  const nameInput = el('input', {
    value: category.name,
    onChange: async (e) => save(category.id, { name: e.target.value }),
    style: 'flex:1;min-width:8rem',
  });

  const remove = el('button', { class: 'small', text: 'Delete' });
  remove.addEventListener('click', async () => {
    if (category.transaction_count > 0 &&
        !confirm(`${category.name} is used by ${category.transaction_count} transactions. They will become uncategorised. Continue?`)) {
      return;
    }
    await act(() => api(`/api/categories/${category.id}`, { method: 'DELETE' }));
  });

  return el('div', { class: 'row', style: 'padding:0.3rem 0' }, [
    nameInput,
    kindSelect,
    el('span', { class: 'muted', text: `${category.transaction_count}` }),
    remove,
  ]);
}

function groupCard(group) {
  const addName = el('input', { placeholder: 'New category', style: 'flex:1;min-width:8rem' });
  const add = el('button', { class: 'small primary', text: 'Add' });
  add.addEventListener('click', async () => {
    if (!addName.value.trim()) return;
    await act(() =>
      api('/api/categories', {
        method: 'POST',
        body: { parent_id: group.id, name: addName.value.trim(), kind: group.kind },
      }),
    );
  });

  return el('div', { class: 'card stack' }, [
    el('div', { class: 'spread' }, [
      el('strong', { text: group.name }),
      el('span', { class: 'badge', text: group.kind }),
    ]),
    ...group.categories.map(categoryRow),
    el('div', { class: 'row' }, [addName, add]),
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
  } catch (err) {
    showError(err.message);
  }
}

async function loadProviderMap() {
  const { mappings } = await api('/api/categories/provider-map');
  const holder = document.getElementById('provider');
  holder.innerHTML = '';
  holder.append(
    el('table', { class: 'table-responsive' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Bank label' }),
          el('th', { text: 'Goes to' }),
          el('th', { class: 'right', text: 'Rows' }),
        ]),
      ]),
      el(
        'tbody',
        {},
        mappings.map((m) =>
          el('tr', {}, [
            el('td', { 'data-col': 'description', text: m.provider_category }),
            el('td', { 'data-col': 'meta' }, [
              categorySelect(m.category_id, async (e) => {
                await save_provider(m.provider_category, e.target.value || null);
              }),
            ]),
            el('td', { 'data-col': 'amount', class: 'right muted', text: String(m.transaction_count) }),
          ]),
        ),
      ),
    ]),
  );
}

async function save_provider(providerCategory, categoryId) {
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

async function load() {
  const data = await api('/api/categories');
  groups = data.groups;
  const tree = document.getElementById('tree');
  tree.innerHTML = '';
  for (const group of groups) tree.append(groupCard(group));
  await loadProviderMap();
}

document.getElementById('recategorise').addEventListener('click', async () => {
  const button = document.getElementById('recategorise');
  button.disabled = true;
  document.getElementById('state').textContent = 'Working...';
  try {
    const { changed } = await api('/api/categories/recategorise', { method: 'POST' });
    document.getElementById('state').textContent = `${changed} transactions changed.`;
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
