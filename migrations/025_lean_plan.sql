-- What it would take to last.
--
-- The runway answers "when does the money run out". The obvious next question
-- is "what would have to go for it not to", and answering that needs a view on
-- every cost of how much it would actually hurt to lose it.
--
-- Three tiers, because two is not enough and four is a form nobody fills in:
--
--   keep  stopping it costs you the house, the power, the cover or the food.
--   trim  you need it, but how much you spend on it is a choice.
--   cut   stopping it costs you nothing you need.
--
-- The tier lives on the category as a starting point and on the merchant where
-- it matters, because a category is not granular enough to decide with: this
-- household's "Services" holds health cover and drone parts, and its
-- "Merchandise" holds the dog's food and a code editor subscription. The
-- merchant wins when both are set, the same precedence as a category chosen by
-- hand beating one chosen by a rule.
--
-- Nothing here changes a forecast by itself. It is the input to a plan someone
-- chooses to follow.
do $$ begin
  create type lean_tier as enum ('keep', 'trim', 'cut');
exception when duplicate_object then null;
end $$;

alter table categories add column if not exists lean_tier lean_tier;
alter table merchants  add column if not exists lean_tier lean_tier;

comment on column categories.lean_tier is 'Starting point for everything in this category.';
comment on column merchants.lean_tier  is 'Beats the category. Set when the category is too blunt to decide with.';

-- A starting point, not a judgement that sticks: every one of these is editable
-- and the merchant overrides it.
update categories set lean_tier = 'keep'
 where name in ('Mortgage', 'Rent and utilities', 'Insurance', 'Loan payments', 'Bank fees', 'Kids');

update categories set lean_tier = 'trim'
 where name in ('Groceries and food', 'Fuel and car', 'Medical', 'Personal care', 'Public transport');

update categories set lean_tier = 'cut'
 where name in ('Merchandise', 'Entertainment', 'Home improvement', 'Travel and holidays',
                'Community and government', 'Services');

-- How much a trimmed cost is assumed to come down by, as a starting figure the
-- household can move. Thirty percent off the groceries is a real change to how
-- you shop, not a rounding.
insert into settings (key, value) values ('lean_trim_percent', '30')
  on conflict (key) do nothing;
