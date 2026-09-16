-- One definition of what counts as budget activity, so every stage agrees.
--
-- A transfer between two accounts we own is not spending: the money is still
-- ours. There is one exception. Money leaving a spendable account for a loan or
-- a mortgage really does leave our cash, and has to be budgeted for, so it
-- counts. Only the side that leaves the liquid account counts, otherwise the
-- same event would be counted twice.
create view budget_flows as
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
    not t.is_transfer
    or (coalesce(a.is_liquid, false) and not coalesce(pa.is_liquid, true))
  )                           as counts
from transactions t
join accounts a on a.id = t.account_id
left join transactions p on p.id = t.transfer_pair_id
left join accounts pa on pa.id = p.account_id;
