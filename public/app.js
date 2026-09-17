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

// Theme. Light is the default because this is looked at in daylight more often
// than not, and an OS level dark preference is usually about a phone at night
// rather than about a budget. The choice is remembered per browser.
const THEME_KEY = 'household-theme';

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  try {
    localStorage.setItem(THEME_KEY, theme === 'dark' ? 'dark' : 'light');
  } catch {
    // A browser with storage blocked still gets the theme, just not the memory.
  }
}

export function currentTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

// Four places to be, and everything the app needs taught once behind the last
// of them. There were thirteen, and eight of those were the workshop rather
// than the budget: nobody who is not maintaining this needs Rules or Transfers.
const PLACES = [
  ['/today', 'Home', 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5'],
  ['/spending', 'Spending', 'M3 6h18v13H3zM3 10.5h18'],
  ['/plan', 'Plan', 'M4 17l5-6 4 4 7-8M4 20h16'],
  ['/setup', 'Set up', 'M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6'],
];

// The pages that live under Set up. Kept here so the nav and that page cannot
// disagree about what exists.
export const SETUP_PAGES = [
  ['The money coming in', [
    ['/accounts', 'Accounts', 'What each one is for, and whether it counts as spendable cash'],
    ['/buckets', 'Pay cycle and envelopes', 'How often you are paid, and giving every dollar a job'],
    ['/forecast', 'Recurring costs and the allowance', 'What repeats, and how much optional spending the plan assumes'],
  ]],
  ['Teaching it what things are', [
    ['/categories', 'Categories', 'The taxonomy, and what the bank calls things'],
    ['/rules', 'Rules', 'Filing a description under a category, once'],
    ['/transactions', 'All transactions', 'Everything, filterable'],
    ['/transfers', 'Transfers to confirm', 'Two sides of one move between your own accounts'],
  ]],
  ['Running it', [
    ['/sync', 'Bank sync', 'Reading the accounts again'],
    ['/alerts', 'Email alerts', 'What is worth saying, and when'],
    ['/insights', 'Ask Claude about it', 'Periodic analysis, off until you switch it on'],
  ]],
];

function icon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const d = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  d.setAttribute('d', path);
  svg.append(d);
  return svg;
}

// Which of the four a page belongs to, so a page under Set up still lights the
// right tab rather than none of them.
function placeFor(current) {
  if (PLACES.some(([href]) => href === current)) return current;
  const owned = SETUP_PAGES.some(([, rows]) => rows.some(([href]) => href === current));
  return owned ? '/setup' : current;
}

// The shared header, so the nav lives in one place.
export function renderNav(current) {
  applyTheme(currentTheme());
  const here = placeFor(current);

  const rail = el('nav', { class: 'rail' }, PLACES.map(([href, label]) =>
    el('a', { href, text: label, 'aria-current': href === here ? 'page' : null }),
  ));

  const toggle = el('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Light or dark',
    'aria-label': 'Switch between light and dark',
    text: currentTheme() === 'dark' ? '\u2600' : '\u263D',
    onClick: (event) => {
      const next = currentTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      event.currentTarget.textContent = next === 'dark' ? '\u2600' : '\u263D';
    },
  });

  document.body.prepend(el('header', { class: 'bar' }, [
    el('div', { class: 'inner' }, [
      el('h1', { text: 'Household' }),
      rail,
      el('span', { class: 'spacer' }),
      toggle,
    ]),
  ]));

  document.body.append(el('nav', { class: 'tabbar' }, PLACES.map(([href, label, path]) =>
    el('a', { href, 'aria-current': href === here ? 'page' : null }, [
      icon(path),
      el('span', { text: label }),
    ]),
  )));
}
