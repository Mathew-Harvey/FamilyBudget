#!/usr/bin/env node
// Moves hand entered commitments onto the one key namespace.
//
//   node scripts/rekey-commitments.js          say what would change
//   node scripts/rekey-commitments.js --apply  do it
//
// A hand entered commitment used to be keyed "manual:<label>" so that it and a
// detected one could never collide. That is backwards. costs.js keeps a
// commitment's spending out of the everyday rate by looking up
// matchKeyFor(description), which cannot produce a key in that namespace, so
// every manual commitment for a merchant that has real history was counted
// twice: once projected as a commitment, and again as everyday spending. A cafe
// costing 122 a month was carried at 296.
//
// This is a script rather than a migration because the key is defined in
// JavaScript and there is exactly one definition of it. Writing matchKeyFor
// again in SQL is the thing CLAUDE.md forbids, and for good reason: the two
// copies drift and commitments silently stop matching.
//
// Run it once, after deploying the code that writes the new keys. Until it has
// been run, `npm run reconcile` reports the rows that are still double counted.
import { query, closePool } from '../src/db.js';
import { matchKeyFor } from '../src/commitments.js';

const apply = process.argv.includes('--apply');

const { rows } = await query(
  `select id, match_key, label, source, active, typical_amount, cadence_days
     from commitments where match_key like 'manual:%' order by label`,
);

if (!rows.length) {
  console.log('Nothing to do: no commitment is still on the old key namespace.');
  await closePool();
  process.exit(0);
}

console.log(`${rows.length} hand entered commitment${rows.length === 1 ? '' : 's'} to move.\n`);

let moved = 0;
let collisions = 0;
for (const row of rows) {
  const key = matchKeyFor(String(row.label));
  if (!key) {
    console.log(`  SKIP  ${row.label}`);
    console.log('        its name has nothing to match on, so it would match no transactions.');
    console.log('        Rename it to the name as it appears on the statement, then run this again.');
    continue;
  }

  // Someone else already holds the key. Detection creates those, and a person
  // entering a commitment by hand outranks one the detector guessed, so the
  // manual row takes the key and the detected row is stood down rather than
  // deleted: its history is still worth having.
  const { rows: [clash] } = await query(
    'select id, label, source from commitments where match_key = $1 and id <> $2',
    [key, row.id],
  );

  if (clash) {
    collisions++;
    console.log(`  CLASH ${row.label}  ->  ${key}`);
    console.log(`        already held by "${clash.label}" (${clash.source}).`);
    if (clash.source !== 'detected') {
      console.log('        Both were entered by hand, so this one is a duplicate of the other.');
      console.log('        Nothing changed. Delete whichever is wrong on the Forecast page.');
      continue;
    }
    console.log('        The detected one is the same cost found automatically. Standing it down.');
    if (apply) {
      await query('update commitments set active = false, updated_at = now() where id = $1', [clash.id]);
      await query('delete from commitments where id = $1', [clash.id]);
      await query('update commitments set match_key = $2, updated_at = now() where id = $1', [row.id, key]);
    }
    moved++;
    continue;
  }

  console.log(`  MOVE  ${row.label}  ->  ${key}`);
  if (apply) {
    await query('update commitments set match_key = $2, updated_at = now() where id = $1', [row.id, key]);
  }
  moved++;
}

console.log(`\n${moved} to move, ${collisions} collision${collisions === 1 ? '' : 's'}.`);
console.log(apply ? 'Done. Run npm run reconcile to check the totals.' : 'Nothing changed. Re-run with --apply to do it.');
await closePool();
