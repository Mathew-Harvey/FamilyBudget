-- Stage 2: categories and rules.

-- A group is a row with parent_id null. A category sits inside a group.
create table categories (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid references categories (id) on delete cascade,
  name        text not null,
  -- How the category behaves in later stages. Transfers and ignored rows are
  -- excluded from spending, income feeds the buckets.
  kind        text not null default 'expense'
              check (kind in ('income', 'expense', 'transfer', 'ignore')),
  colour      text,
  sort_order  integer not null default 0,
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Two groups cannot share a name, and neither can two categories in the same
  -- group. NULLS NOT DISTINCT makes the group level work, which plain unique
  -- would not because every null differs.
  constraint categories_name_unique unique nulls not distinct (parent_id, name)
);

create index categories_parent_idx on categories (parent_id, sort_order);

-- category_id was added in Stage 1 with no table to point at. Wire it up now.
alter table transactions
  add constraint transactions_category_fk
  foreign key (category_id) references categories (id) on delete set null;

alter table transactions
  -- Where the category came from, so recategorising never overwrites a choice
  -- a person made by hand.
  add column category_source text
    check (category_source in ('manual', 'rule', 'provider')),
  add column categorised_by_rule_id uuid,
  -- Rules can rename a transaction for display, and annotate it. The original
  -- description is never touched.
  add column display_description text,
  add column note text;

create index transactions_category_idx on transactions (category_id);

-- Redbark supplies a provider category on most rows. Mapping it gives every
-- transaction a reasonable starting category without writing a rule for each.
create table provider_category_map (
  provider_category text primary key,
  category_id       uuid not null references categories (id) on delete cascade,
  created_at        timestamptz not null default now()
);

-- Ordered rules, evaluated top to bottom, first match wins.
create table rules (
  id          uuid primary key default gen_random_uuid(),
  position    integer not null,
  name        text not null,
  enabled     boolean not null default true,

  -- Conditions. Every condition that is set must match. All null means the rule
  -- matches everything, which is useful only as a catch all at the bottom.
  match_field text not null default 'any'
              check (match_field in ('any', 'description', 'merchant_name', 'reference', 'extended_description')),
  match_type  text not null default 'contains'
              check (match_type in ('contains', 'equals', 'starts_with', 'regex')),
  match_value text,
  account_id  uuid references accounts (id) on delete cascade,
  direction   text check (direction in ('debit', 'credit')),
  min_amount  numeric(12,2),
  max_amount  numeric(12,2),

  -- Actions.
  category_id uuid references categories (id) on delete set null,
  rename_to   text,
  set_note    text,
  mark_ignore boolean not null default false,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index rules_position_idx on rules (position);

alter table transactions
  add constraint transactions_rule_fk
  foreign key (categorised_by_rule_id) references rules (id) on delete set null;

-- Counts for the sync run, so categorising is visible like everything else.
alter table sync_runs
  add column txns_categorised integer not null default 0;
