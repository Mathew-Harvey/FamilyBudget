-- Fix: only money moving out of a spendable account is spending.
--
-- The previous rule counted any non transfer row, which swept in everything
-- charged to the mortgage itself: interest, package fees, rate adjustments.
-- Over a year that was about 35,700 dollars of "spending" that never left the
-- household's cash. It inflated the everyday spend rate and made the runway
-- look far shorter than it is.
--
-- Interest on a loan is real, and it does make the household poorer, but it is
-- a change in what is owed rather than cash going out of the door. The forecast
-- is about cash, so it belongs to the debt, not to the budget.
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
    -- It has to leave a spendable account at all,
    a.is_liquid
    and (
      -- and either not be a transfer between accounts we own,
      not t.is_transfer
      -- or be one that leaves for a loan, which really is cash gone.
      or not coalesce(pa.is_liquid, true)
    )
  )                           as counts
from transactions t
join accounts a on a.id = t.account_id
left join transactions p on p.id = t.transfer_pair_id
left join accounts pa on pa.id = p.account_id;
