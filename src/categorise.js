// Stage 2: categories and rules.
//
// Precedence, strongest first:
//   manual    a person chose it in the UI, and nothing overwrites it
//   rule      the first matching rule, evaluated top to bottom
//   provider  the Redbark provider category, mapped onto our taxonomy
//
// Recategorising is safe to run as often as you like. It only ever touches rows
// whose category came from a rule or the provider, or that have none yet.
import { query, withTransaction } from './db.js';
import { numericToCents } from './money.js';

// Fields a rule can look at. 'any' searches all of them at once, which is what
// people usually mean.
const MATCH_FIELDS = ['description', 'merchant_name', 'reference', 'extended_description'];

function haystackFor(txn, field) {
  if (field === 'any') {
    return MATCH_FIELDS.map((f) => txn[f] || '')
      .join(' ')
      .toLowerCase();
  }
  return String(txn[field] || '').toLowerCase();
}

// A rule matches when every condition it sets is satisfied. Conditions left
// null are simply not checked.
export function ruleMatches(rule, txn) {
  if (rule.enabled === false) return false;

  if (rule.match_value) {
    const haystack = haystackFor(txn, rule.match_field || 'any');
    const needle = String(rule.match_value).toLowerCase();
    let hit;
    switch (rule.match_type) {
      case 'equals':
        hit = haystack.trim() === needle.trim();
        break;
      case 'starts_with':
        hit = haystack.trimStart().startsWith(needle);
        break;
      case 'regex':
        try {
          hit = new RegExp(rule.match_value, 'i').test(haystackFor(txn, rule.match_field || 'any'));
        } catch {
          // A rule with a broken pattern should never match, and never throw
          // mid sync. The Rules page validates before saving.
          hit = false;
        }
        break;
      default:
        hit = haystack.includes(needle);
    }
    if (!hit) return false;
  }

  if (rule.account_id && rule.account_id !== txn.account_id) return false;

  const cents = txn.amount_cents;
  if (rule.direction === 'debit' && cents > 0) return false;
  if (rule.direction === 'credit' && cents < 0) return false;

  // Amount bounds compare magnitudes, because people think in sizes, not signs.
  const size = Math.abs(cents);
  if (rule.min_amount !== null && rule.min_amount !== undefined && size < numericToCents(rule.min_amount)) {
    return false;
  }
  if (rule.max_amount !== null && rule.max_amount !== undefined && size > numericToCents(rule.max_amount)) {
    return false;
  }

  return true;
}

export function firstMatchingRule(rules, txn) {
  for (const rule of rules) {
    if (ruleMatches(rule, txn)) return rule;
  }
  return null;
}

// Recategorises everything that is not manually set.
// Returns how many rows ended up with a different category than they had.
export async function categoriseAll(options = {}) {
  const run = async (client) => {
    const rules = (
      await client.query('select * from rules where enabled order by position, created_at')
    ).rows;

    const providerMap = new Map(
      (await client.query('select provider_category, category_id from provider_category_map')).rows.map(
        (row) => [row.provider_category, row.category_id],
      ),
    );

    const { rows: transactions } = await client.query(
      `select id, account_id, description, merchant_name, reference, extended_description,
              provider_category, category_id, category_source, categorised_by_rule_id,
              display_description, note,
              (amount * 100)::bigint as amount_cents
         from transactions
        where category_source is distinct from 'manual'`,
    );

    let changed = 0;
    for (const txn of transactions) {
      const rule = firstMatchingRule(rules, txn);

      let categoryId = null;
      let source = null;
      let ruleId = null;
      let rename = null;
      let note = null;

      if (rule) {
        ruleId = rule.id;
        rename = rule.rename_to ?? null;
        note = rule.set_note ?? null;
        if (rule.category_id) {
          categoryId = rule.category_id;
          source = 'rule';
        }
      }

      // No rule set a category, so fall back to what the bank called it.
      if (!categoryId && txn.provider_category && providerMap.has(txn.provider_category)) {
        categoryId = providerMap.get(txn.provider_category);
        source = 'provider';
      }

      const same =
        txn.category_id === categoryId &&
        txn.category_source === source &&
        txn.categorised_by_rule_id === ruleId &&
        txn.display_description === rename &&
        txn.note === note;
      if (same) continue;

      await client.query(
        `update transactions
            set category_id            = $2,
                category_source        = $3,
                categorised_by_rule_id = $4,
                display_description    = $5,
                note                   = $6,
                updated_at             = now()
          where id = $1`,
        [txn.id, categoryId, source, ruleId, rename, note],
      );
      changed++;
    }
    return changed;
  };

  if (options.client) return run(options.client);
  return withTransaction(run, options.pool);
}

// Sets a category by hand. This pins the row: later rule runs leave it alone.
export async function setCategoryManually(transactionId, categoryId, client) {
  const run = (c) =>
    c.query(
      `update transactions
          set category_id     = $2,
              category_source = case when $2::uuid is null then null else 'manual' end,
              categorised_by_rule_id = null,
              updated_at      = now()
        where id = $1
        returning id, category_id, category_source`,
      [transactionId, categoryId],
    );
  const result = await (client ? run(client) : run({ query }));
  return result.rows[0];
}

// Previews what a ruleset would do, without writing anything.
export async function previewRule(rule, { limit = 25 } = {}) {
  const { rows } = await query(
    `select t.id, t.txn_date, t.description, t.merchant_name, t.reference,
            t.extended_description, t.provider_category, t.account_id, t.amount,
            (t.amount * 100)::bigint as amount_cents,
            a.bank, a.masked_number
       from transactions t
       join accounts a on a.id = t.account_id
      order by t.txn_date desc
      limit 2000`,
  );
  const matched = rows.filter((txn) => ruleMatches({ ...rule, enabled: true }, txn));
  return { matched: matched.slice(0, limit), total: matched.length, considered: rows.length };
}
