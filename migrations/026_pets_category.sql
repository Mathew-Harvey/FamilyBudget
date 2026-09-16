-- Pet food and care are necessities, but provider categories scatter them
-- across merchandise, services and medical. Give them a category whose
-- forecast treatment is explicit. Existing rows are left for a person to move,
-- because a merchant name alone cannot reliably identify what was purchased.
insert into categories (parent_id, name, kind, sort_order, lean_tier)
select id, 'Pets', 'expense', 50, 'trim'
  from categories
 where parent_id is null and name = 'Everyday'
on conflict (parent_id, name) do nothing;
