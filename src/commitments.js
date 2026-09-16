// Stage 4, part one: find the outgoings that repeat.
//
// The forecast needs to know what is already committed: power, water, phone,
// insurance, the mortgage. Those look like any other transaction, so they are
// found by looking for a description that comes back at a regular interval.
//
// Regularity is what separates a commitment from ordinary shopping. Aldi shows
// up forty times a year but at no particular spacing, so it is not a
// commitment. Synergy shows up every two months, so it is.
import { withTransaction } from './db.js';
import { normaliseDescription } from './matching.js';
import { numericToCents, centsToNumeric } from './money.js';

const DAY_MS = 86_400_000;

// A commitment needs to have happened enough times to believe in.
const MIN_OCCURRENCES = 3;
// What fraction of the gaps must sit close to the typical gap.
const MIN_REGULARITY = 0.6;
// How far a gap can stray from the typical one and still count as regular.
const GAP_TOLERANCE = 0.3;

const toDate = (value) => new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
const iso = (date) => date.toISOString().slice(0, 10);

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// The median of amounts held as integer cents. An even count takes the lower
// of the two middle values rather than averaging them: the average of two
// amounts can be half a cent, which is not money, and the lower middle is a
// bill that actually happened.
export function medianCents(cents) {
  if (!cents.length) return 0;
  const sorted = [...cents].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

// The grouping key. Banks append receipt and reference numbers that differ on
// every occurrence, so a key that keeps them puts each occurrence in its own
// group and nothing ever looks recurring. Purely numeric words are dropped for
// that reason, and only the first few remaining words are used, because the
// tail of a description is where the noise lives.
export function matchKeyFor(description) {
  return normaliseDescription(description)
    .split(' ')
    .filter((word) => word.length > 1 && !/^\d+$/.test(word))
    .slice(0, 3)
    .join(' ');
}

// Given the dates a description occurred on, decide whether it repeats and how
// often. Returns null when it does not look like a commitment.
export function assessSchedule(dates) {
  if (dates.length < MIN_OCCURRENCES) return null;

  const sorted = [...dates].sort();
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(Math.round((toDate(sorted[i]).getTime() - toDate(sorted[i - 1]).getTime()) / DAY_MS));
  }
  // Same day repeats say nothing about spacing.
  const spacing = gaps.filter((gap) => gap > 0);
  if (spacing.length < MIN_OCCURRENCES - 1) return null;

  const typical = median(spacing);
  if (typical < 5 || typical > 200) return null; // ignore daily noise and once a year

  // Three occurrences give only two gaps, which a pair of coincidences can
  // satisfy. That is convincing enough for something monthly, where the
  // occurrences are close together, but not for a long cadence: two petrol
  // fills happening to be four months apart is not a quarterly bill.
  if (typical > 45 && spacing.length < 3) return null;

  const close = spacing.filter((gap) => Math.abs(gap - typical) <= typical * GAP_TOLERANCE).length;
  const regularity = close / spacing.length;
  if (regularity < MIN_REGULARITY) return null;

  const lastSeen = sorted[sorted.length - 1];
  return {
    cadence_days: Math.round(typical),
    regularity: Number(regularity.toFixed(3)),
    occurrences: sorted.length,
    last_seen: lastSeen,
    next_due: iso(new Date(toDate(lastSeen).getTime() + Math.round(typical) * DAY_MS)),
  };
}

// Scans history and upserts what it finds. Detected rows are refreshed every
// run, manual ones are never touched.
export async function detectCommitments(options = {}) {
  const run = async (client) => {
    const { rows } = await client.query(
      `select t.txn_date, t.amount, t.category_id,
              coalesce(t.display_description, t.description) as label
         from budget_flows t
        where t.counts
          and t.amount < 0
          and t.txn_date >= current_date - $1::integer
        order by t.txn_date`,
      [options.lookbackDays ?? 400],
    );

    const groups = new Map();
    for (const row of rows) {
      const key = matchKeyFor(row.label);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { label: row.label, entries: [] });
      groups.get(key).entries.push({
        date: String(row.txn_date).slice(0, 10),
        amount_cents: numericToCents(row.amount),
        category_id: row.category_id,
      });
    }

    const found = [];
    for (const [key, group] of groups) {
      const schedule = assessSchedule(group.entries.map((entry) => entry.date));
      if (!schedule) continue;

      // The typical amount, from the most recent occurrences only. A median
      // over the whole year lags a change: the mortgage went from 1655 to 1800
      // and the older figure would otherwise win for months. The median is
      // still used rather than the last value, so one unusual bill does not
      // become the forecast.
      const recent = group.entries.slice(-6).map((entry) => entry.amount_cents);
      const typicalAmount = centsToNumeric(medianCents(recent));
      // The commonest category among the occurrences.
      const categoryCounts = new Map();
      for (const entry of group.entries) {
        if (entry.category_id) categoryCounts.set(entry.category_id, (categoryCounts.get(entry.category_id) ?? 0) + 1);
      }
      const categoryId = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

      found.push({ match_key: key, label: group.label, category_id: categoryId, typical_amount: typicalAmount, ...schedule });
    }

    for (const commitment of found) {
      await client.query(
        `insert into commitments (match_key, label, category_id, typical_amount, cadence_days,
                                  occurrences, regularity, last_seen, next_due, source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'detected')
         on conflict (match_key) do update set
           label          = excluded.label,
           category_id    = excluded.category_id,
           typical_amount = excluded.typical_amount,
           cadence_days   = excluded.cadence_days,
           occurrences    = excluded.occurrences,
           regularity     = excluded.regularity,
           last_seen      = excluded.last_seen,
           next_due       = excluded.next_due,
           updated_at     = now()
         -- A commitment someone entered or edited by hand is theirs, so
         -- detection refreshes only the ones it created.
         where commitments.source = 'detected'`,
        [
          commitment.match_key,
          commitment.label,
          commitment.category_id,
          commitment.typical_amount,
          commitment.cadence_days,
          commitment.occurrences,
          commitment.regularity,
          commitment.last_seen,
          commitment.next_due,
        ],
      );
    }

    // Something that stopped happening should stop being forecast. Give it two
    // cycles of grace before standing it down, in case a bill is just late.
    await client.query(
      `update commitments
          set active = false, updated_at = now()
        where source = 'detected'
          and active
          and last_seen < current_date - (cadence_days * 2)`,
    );

    return found.length;
  };

  if (options.client) return run(options.client);
  return withTransaction(run, options.pool);
}

// Every occurrence of the active commitments between two dates, which is what
// the forecast subtracts.
export async function upcomingCommitments(from, to, client) {
  const { rows } = await client.query(
    'select * from commitments where active order by next_due nulls last, label',
  );
  const events = [];
  const end = toDate(to);

  for (const commitment of rows) {
    if (!commitment.next_due || !commitment.cadence_days) continue;
    let due = toDate(commitment.next_due);
    // A commitment whose due date has already passed is expected imminently
    // rather than in the past, so walk it forward to the window.
    const start = toDate(from);
    while (due < start) due = new Date(due.getTime() + commitment.cadence_days * DAY_MS);
    while (due <= end) {
      events.push({
        date: iso(due),
        label: commitment.label,
        amount: commitment.typical_amount,
        commitment_id: commitment.id,
      });
      due = new Date(due.getTime() + commitment.cadence_days * DAY_MS);
    }
  }
  return events.sort((a, b) => a.date.localeCompare(b.date));
}
