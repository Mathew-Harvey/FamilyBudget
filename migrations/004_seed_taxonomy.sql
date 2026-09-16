-- A starting taxonomy for an Australian household, and a mapping from every
-- top level Redbark provider category onto it, so transactions land somewhere
-- sensible before a single rule is written. All of it is editable in the UI.

insert into categories (parent_id, name, kind, sort_order) values
  (null, 'Income',     'income',   10),
  (null, 'Home',       'expense',  20),
  (null, 'Everyday',   'expense',  30),
  (null, 'Transport',  'expense',  40),
  (null, 'Health',     'expense',  50),
  (null, 'Lifestyle',  'expense',  60),
  (null, 'Money',      'expense',  70),
  (null, 'Transfers',  'transfer', 80);

insert into categories (parent_id, name, kind, sort_order)
select g.id, c.name, c.kind, c.sort_order
from (values
  ('Income',    'Pay',                    'income',   10),
  ('Income',    'Other income',           'income',   20),
  ('Home',      'Mortgage',               'expense',  10),
  ('Home',      'Rent and utilities',     'expense',  20),
  ('Home',      'Home improvement',       'expense',  30),
  ('Home',      'Insurance',              'expense',  40),
  ('Everyday',  'Groceries and food',     'expense',  10),
  ('Everyday',  'Merchandise',            'expense',  20),
  ('Everyday',  'Personal care',          'expense',  30),
  ('Everyday',  'Kids',                   'expense',  40),
  ('Transport', 'Transport',              'expense',  10),
  ('Transport', 'Travel',                 'expense',  20),
  ('Health',    'Medical',                'expense',  10),
  ('Lifestyle', 'Entertainment',          'expense',  10),
  ('Lifestyle', 'Services',               'expense',  20),
  ('Lifestyle', 'Community and government', 'expense', 30),
  ('Money',     'Bank fees',              'expense',  10),
  ('Money',     'Loan payments',          'expense',  20),
  ('Transfers', 'Internal transfer',      'transfer', 10)
) as c(group_name, name, kind, sort_order)
join categories g on g.name = c.group_name and g.parent_id is null;

-- Every top level provider category Redbark serves, mapped onto the above.
insert into provider_category_map (provider_category, category_id)
select m.provider_category, c.id
from (values
  ('INCOME',                    'Other income'),
  ('RENT_AND_UTILITIES',        'Rent and utilities'),
  ('HOME_IMPROVEMENT',          'Home improvement'),
  ('FOOD_AND_DRINK',            'Groceries and food'),
  ('MERCHANDISE',               'Merchandise'),
  ('PERSONAL_CARE',             'Personal care'),
  ('TRANSPORTATION',            'Transport'),
  ('TRAVEL',                    'Travel'),
  ('MEDICAL',                   'Medical'),
  ('ENTERTAINMENT',             'Entertainment'),
  ('SERVICES',                  'Services'),
  ('GOVERNMENT_AND_NON_PROFIT', 'Community and government'),
  ('BANK_FEES',                 'Bank fees'),
  ('LOAN_PAYMENTS',             'Loan payments'),
  ('TRANSFER_IN',               'Internal transfer'),
  ('TRANSFER_OUT',              'Internal transfer')
) as m(provider_category, category_name)
join categories c on c.name = m.category_name and c.parent_id is not null;
