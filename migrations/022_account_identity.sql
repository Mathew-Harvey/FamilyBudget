-- An account is identified by its number at its bank, not by a Redbark id.
--
-- Relinking a connection, which happens whenever consent is renewed and CDR
-- consent expires every twelve months, issues brand new account ids for every
-- account behind it. Adding the personal loan to the ING connection did exactly
-- that: all four ING accounts came back with ids we had never seen.
--
-- upsertAccounts only knew how to conflict on redbark_account_id, so that would
-- have inserted four new accounts and left the originals orphaned, still
-- holding every transaction, every balance, and the is_liquid and role settings
-- that the whole forecast depends on. Spendable cash would have been read off
-- the new empty rows. Nothing would have errored.
--
-- The stable identity is the institution plus the masked number, so that is
-- what gets the unique index. A manually created account can then be adopted by
-- the connection that later starts serving it, keeping its balance and its role,
-- which is what happened to the personal loan here.
--
-- Partial, because accounts entered by hand for debts open banking cannot reach
-- have no masked number at all and several of them would otherwise collide on
-- null.
create unique index if not exists accounts_bank_number_idx
  on accounts (bank, masked_number)
  where masked_number is not null;
