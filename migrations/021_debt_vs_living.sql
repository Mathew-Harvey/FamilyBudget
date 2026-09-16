-- Paying down what you owe is not the same as spending it.
--
-- Cash leaving a spendable account for a loan or a card really is cash gone, so
-- it belongs in the runway exactly as it is. But it is not consumption: it buys
-- down a liability rather than buying anything. Lumping the two together makes
-- "going out 17,900 a month" true and useless, because a third of that figure
-- is not a choice anyone makes each month and none of it is trimmable in the
-- way the rest is.
--
-- On this household the split is about 12,500 a month of living and 5,400 a
-- month of debt servicing.
--
-- Two ways a payment is known to be servicing our own debt:
--
--   1. It is a transfer whose far side is one of our non liquid accounts. That
--      already worked, through a matched counterpart or through the account
--      number in the description.
--
--   2. It is paid to a merchant that exists to service one of those accounts:
--      the card issuer, the finance company. Those accounts are entered by hand
--      because open banking cannot reach them, so there is no counterpart row to
--      pair with and the only link is the payee. That link is what
--      merchants.pays_account_id records.
--
-- The savings shuffle is neither of these and stays excluded from everything, as
-- it already was: money moved between two spendable accounts we own has not
-- gone anywhere.
alter table merchants
  add column if not exists pays_account_id uuid references accounts(id);

comment on column merchants.pays_account_id is
  'This payee services that account. Set through the UI, never from a literal in source.';

-- to_own_debt goes on the end: create or replace can append to a view but cannot
-- reorder or rename what is already there.
create or replace view budget_flows as
select
  t.id,
  t.account_id,
  t.txn_date,
  t.posted_date,
  t.amount,
  t.status,
  t.description,
  t.display_description,
  t.category_id,
  t.is_transfer,
  t.transfer_pair_id,
  a.is_liquid                 as from_liquid,
  pa.is_liquid                as to_liquid,
  (
    a.is_liquid
    and (not t.is_transfer or not coalesce(pa.is_liquid, true))
    and (t.internal_to_account_id is null or not coalesce(ia.is_liquid, false))
  )                           as counts,
  t.merchant_name,
  t.merchant_key,
  t.one_off,
  t.internal_to_account_id,
  (
    -- Money out, landing on one of our own non liquid accounts.
    t.amount < 0
    and (
      (pa.id is not null and not pa.is_liquid)
      or (ia.id is not null and not ia.is_liquid)
      or (ma.id is not null and not ma.is_liquid)
    )
  )                           as to_own_debt
from transactions t
join accounts a on a.id = t.account_id
left join transactions p on p.id = t.transfer_pair_id
left join accounts pa on pa.id = p.account_id
left join accounts ia on ia.id = t.internal_to_account_id
left join merchants mm on mm.match_key = t.merchant_key
left join accounts ma on ma.id = mm.pays_account_id;
