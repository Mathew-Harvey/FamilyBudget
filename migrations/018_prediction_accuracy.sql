-- Prediction accuracy: three things the forecast was getting wrong.
--
-- 1. One off spending was setting the rate.
--    The 2025 renovation put about 55,000 dollars through the account over a
--    few months. Hiding it behind a short window was a blunt fix: it also threw
--    away the recent history that makes the rate stable, and it only worked
--    until the next large purchase. Backtesting the estimator against the next
--    60 days of real spending, marking one offs and keeping a longer window
--    beat a short window by about 19 percent. So a transaction can now be
--    marked as a one off. It stays in the history and in every total, because
--    it really happened, and it is excluded only where a rate is worked out.
--
-- 2. Unpaired internal transfers were counted as spending.
--    ING writes the destination account number into the description of a
--    transfer between two of our own accounts. When the other side had not been
--    synced yet, or the destination is not connected, the pair never formed and
--    budget_flows counted the money as gone. It was not gone, it was in the
--    next account along. That was about 710 dollars a month of phantom
--    spending, which shortened the runway for no reason.
--
--    The destination is resolved from the account number in the description
--    instead, so the pair does not have to exist. The liquid rule is unchanged:
--    money moving to another spendable account is not spending, money moving to
--    a loan or a card is.
--
-- 3. There was nowhere to record that a bill is annual.
--    Commitment detection ignores anything with a cadence over 200 days, so
--    rates, rego, insurance and health cover never reached the forecast. They
--    are real and predictable, so they get a flag that lets them be confirmed
--    by hand rather than guessed at from two occurrences.

alter table transactions
  add column if not exists one_off boolean not null default false,
  add column if not exists internal_to_account_id uuid references accounts(id);

comment on column transactions.one_off is
  'Excluded from spend rates and provisions, kept in every total. Set by a person.';
comment on column transactions.internal_to_account_id is
  'Destination account, resolved from the account number in the description when no counterpart row exists.';

create index if not exists transactions_one_off_idx on transactions (one_off) where one_off;

-- Long cadence commitments, confirmed rather than detected. The detector will
-- not create these, so they are never stood down for having gone quiet.
alter table commitments
  add column if not exists annual boolean not null default false;

comment on column commitments.annual is
  'A bill that repeats too rarely for detection to believe in. Entered or confirmed by a person.';

-- budget_flows gains one_off so callers can exclude it from a rate, and starts
-- respecting a resolved internal destination. New columns go on the end:
-- create or replace can append but cannot reorder.
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
    -- and not be a transfer between accounts we own, whether that was proved
    -- by a matched counterpart or read out of the description,
    and (not t.is_transfer or not coalesce(pa.is_liquid, true))
    and (t.internal_to_account_id is null or not coalesce(ia.is_liquid, false))
  )                           as counts,
  t.merchant_name,
  t.merchant_key,
  t.one_off,
  t.internal_to_account_id
from transactions t
join accounts a on a.id = t.account_id
left join transactions p on p.id = t.transfer_pair_id
left join accounts pa on pa.id = p.account_id
left join accounts ia on ia.id = t.internal_to_account_id;
