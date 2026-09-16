-- "Transport" read as public transport. It was almost entirely fuel. Relabel
-- so the numbers say what they are, and give public transport its own line.
-- Buckets and the provider map follow by id, so nothing else moves.

update categories set name = 'Getting around', updated_at = now()
 where name = 'Transport' and parent_id is null;

update categories set name = 'Fuel and car', updated_at = now()
 where name = 'Transport' and parent_id is not null;

update categories set name = 'Travel and holidays', updated_at = now()
 where name = 'Travel' and parent_id is not null;

insert into categories (parent_id, name, kind, sort_order)
select g.id, 'Public transport', 'expense', 15
  from categories g
 where g.name = 'Getting around' and g.parent_id is null
on conflict (parent_id, name) do nothing;

-- The one rule worth shipping: the Perth transport card is public transport,
-- not fuel, whatever the bank's category says. Delete it if it is unwanted.
insert into rules (position, name, match_field, match_type, match_value, category_id)
select 5, 'SmartRider is public transport', 'any', 'contains', 'SMARTRIDER', c.id
  from categories c
 where c.name = 'Public transport' and c.parent_id is not null
   and not exists (select 1 from rules where name = 'SmartRider is public transport');
