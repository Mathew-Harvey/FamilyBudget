-- A cost that has been cancelled should stop being forecast.
--
-- The household changed insurers. Six Youi policies worth about 614 a month are
-- still in the window, so the spend rate still expects them, and the forecast
-- will keep expecting them for as long as the window remembers. Nothing is
-- wrong with the history: those payments really happened. What is wrong is
-- treating them as a guide to next month, which is the same distinction
-- transactions.one_off already makes, but about a merchant rather than a
-- purchase, and about everything it charges from here on rather than one row.
--
-- The same thing is needed every time a subscription is cancelled, a gym is
-- quit, or a service is switched, and a decision on the Today page that is
-- verified as held is exactly this. Waiting for commitment detection to stand
-- it down takes two full cycles, which is two months of a forecast that is
-- knowably wrong.
alter table merchants
  add column if not exists ended_on date;

comment on column merchants.ended_on is
  'No longer expected from this date. Kept in history and in every total, left out of any rate.';

-- budget_flows gains one flag for it. New column on the end: create or replace
-- can append but cannot reorder.
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
    and t.reversal_of_id is null
    and not exists (select 1 from transactions r where r.reversal_of_id = t.id)
  )                           as counts,
  t.merchant_name,
  t.merchant_key,
  t.one_off,
  t.internal_to_account_id,
  (
    t.amount < 0
    and (
      (pa.id is not null and not pa.is_liquid)
      or (ia.id is not null and not ia.is_liquid)
      or (ma.id is not null and not ma.is_liquid)
    )
  )                           as to_own_debt,
  t.reversal_of_id,
  -- True once the merchant has been marked as finished with. Kept out of rates,
  -- never out of history.
  (mm.ended_on is not null)   as no_longer_expected
from transactions t
join accounts a on a.id = t.account_id
left join transactions p on p.id = t.transfer_pair_id
left join accounts pa on pa.id = p.account_id
left join accounts ia on ia.id = t.internal_to_account_id
left join merchants mm on mm.match_key = t.merchant_key
left join accounts ma on ma.id = mm.pays_account_id;
