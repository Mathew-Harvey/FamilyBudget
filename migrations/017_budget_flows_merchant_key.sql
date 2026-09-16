-- budget_flows was created before merchant_key existed, and a view does not
-- pick up columns added to its table afterwards. Spending by merchant is a
-- question about flows, so the key belongs on the view rather than every caller
-- joining back to transactions for it.
--
-- The new columns go on the end. create or replace can append to a view but
-- cannot reorder or rename what is already there, so inserting them next to the
-- other transaction fields fails with "cannot change name of view column".
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
  )                           as counts,
  t.merchant_name,
  t.merchant_key
from transactions t
join accounts a on a.id = t.account_id
left join transactions p on p.id = t.transfer_pair_id
left join accounts pa on pa.id = p.account_id;
