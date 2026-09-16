// Shared helpers for every page. Plain browser JavaScript, no build step.

export async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 401) {
    window.location.href = '/login';
    throw new Error('Not signed in');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

// Amounts arrive from Postgres numeric as strings, for example "-159.70", and
// are formatted as strings. No number parsing, so no rounding surprises.
export function formatAmount(value) {
  const text = String(value ?? '0');
  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  const [whole, fraction = '00'] = digits.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${grouped}.${fraction.padEnd(2, '0')}`;
}

export function amountClass(value) {
  return String(value ?? '0').startsWith('-') ? 'out' : 'in';
}

export function formatDate(value) {
  if (!value) return '';
  return String(value).slice(0, 10);
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

export function showError(message) {
  const holder = document.getElementById('notice');
  if (!holder) return;
  holder.innerHTML = '';
  if (message) holder.append(el('div', { class: 'notice error', text: message }));
}

export function accountLabel(account) {
  if (!account) return '';
  return `${account.bank} ${account.masked_number || ''}`.trim();
}

// The shared header, so the nav lives in one place.
export function renderNav(current) {
  const pages = [
    ['/today', 'Today'],
    ['/accounts', 'Accounts'],
    ['/spending', 'Spending'],
    ['/transactions', 'Transactions'],
    ['/categories', 'Categories'],
    ['/rules', 'Rules'],
    ['/buckets', 'Buckets'],
    ['/forecast', 'Forecast'],
    ['/insights', 'Insights'],
    ['/alerts', 'Alerts'],
    ['/transfers', 'Transfers'],
    ['/sync', 'Sync'],
  ];
  const nav = el('nav', {}, pages.map(([href, label]) =>
    el('a', { href, text: label, 'aria-current': href === current ? 'page' : null }),
  ));
  nav.append(
    el('a', {
      href: '#',
      text: 'Sign out',
      onClick: async (event) => {
        event.preventDefault();
        await api('/api/auth/logout', { method: 'POST' });
        window.location.href = '/login';
      },
    }),
  );

  const header = el('header', { class: 'bar' }, [
    el('div', { class: 'inner' }, [el('h1', { text: 'Household budget' }), nav]),
  ]);
  document.body.prepend(header);
}
