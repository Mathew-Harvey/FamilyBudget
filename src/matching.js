// Shared matching helpers used by pending to posted resolution and by transfer
// detection. Kept separate so both can be tested without a database.

// Strips punctuation and case so two descriptions of the same payment compare
// sensibly. Banks pad and reformat these between pending and posted.
export function normaliseDescription(text) {
  return (text || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(text) {
  const set = new Set();
  for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2));
  return set;
}

// Dice coefficient over character bigrams: 1 is identical, 0 shares nothing.
// Chosen because it tolerates the trailing reference numbers a bank bolts on
// when a pending transaction posts, without needing a dependency.
export function descriptionSimilarity(a, b) {
  const left = normaliseDescription(a);
  const right = normaliseDescription(b);
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  if (left === right) return 1;
  // One being the start of the other is the common posting case.
  if (left.startsWith(right) || right.startsWith(left)) return 0.95;

  const first = bigrams(left);
  const second = bigrams(right);
  if (!first.size || !second.size) return 0;
  let shared = 0;
  for (const gram of first) if (second.has(gram)) shared++;
  return (2 * shared) / (first.size + second.size);
}

export function daysBetween(a, b) {
  const left = a instanceof Date ? a : new Date(`${a}T00:00:00Z`);
  const right = b instanceof Date ? b : new Date(`${b}T00:00:00Z`);
  return Math.abs(Math.round((left.getTime() - right.getTime()) / 86_400_000));
}

export function toDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
