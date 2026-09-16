-- A charge that was refunded is not spending, and its refund is not income.
--
-- Real statements carry reversals: a contractor charged 1,419 dollars and
-- refunded it the same day, a subscription double billed and gave one back, a
-- card investigation reversed a disputed charge. Both halves were being counted.
-- The charge went into spending because it is a negative amount leaving a
-- spendable account, and the refund came back as "Other income" because the
-- provider categorises an unexplained credit that way. So a payment that never
-- really happened inflated spending AND income by the same amount, and the
-- household's biggest single "merchandise" merchant was a reversal.
--
-- This is the transfer problem again, in a different costume, so it gets the
-- same answer: pair the two sides and let budget_flows exclude the pair. That
-- needs no change at the twenty four places that filter on amount, because they
-- all go through counts already.
--
-- Pairing is deliberately strict. Same merchant, same amount to the cent,
-- refund on or after the charge and within thirty days, and each row used once.
-- A positive amount that finds no charge to cancel is left exactly as it was: it
-- might be a rebate, a cashback, or money someone sent us, and guessing is worse
-- than leaving it alone.
alter table transactions
  add column if not exists reversal_of_id uuid references transactions(id);

comment on column transactions.reversal_of_id is
  'This credit cancels that charge. Both sides stop counting as spending or income.';

create index if not exists transactions_reversal_of_idx on transactions (reversal_of_id)
  where reversal_of_id is not null;

-- counts gains one more condition: neither side of a reversal counts. The new
-- column goes on the end, since create or replace can append but not reorder.
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
    -- Not the credit that cancels a charge,
    and t.reversal_of_id is null
    -- and not the charge that a credit cancelled.
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
  t.reversal_of_id
from transactions t
join accounts a on a.id = t.account_id
left join transactions p on p.id = t.transfer_pair_id
left join accounts pa on pa.id = p.account_id
left join accounts ia on ia.id = t.internal_to_account_id
left join merchants mm on mm.match_key = t.merchant_key
left join accounts ma on ma.id = mm.pays_account_id;
