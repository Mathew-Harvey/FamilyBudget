-- Stage 3: zero based buckets, allocated each pay period.

-- One row, holding how often money arrives and a date we know a pay landed.
-- Everything else is derived from those two facts.
create table pay_cycle (
  id           boolean primary key default true check (id),
  cadence      text not null default 'fortnightly'
               check (cadence in ('weekly', 'fortnightly', 'monthly')),
  anchor_date  date not null,
  updated_at   timestamptz not null default now()
);

-- Generated from the cycle, so a period is a stable thing to hang allocations
-- and reports off.
create table pay_periods (
  id         uuid primary key default gen_random_uuid(),
  starts_on  date not null unique,
  ends_on    date not null,
  created_at timestamptz not null default now(),
  constraint pay_periods_ordered check (ends_on >= starts_on)
);

create index pay_periods_range_idx on pay_periods (starts_on, ends_on);

-- A bucket is a job for money: groceries, fuel, the power bill.
create table buckets (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  -- What it is for, shown on the buckets page.
  notes       text,
  -- The usual amount to put in each period. Allocations default to this.
  target      numeric(12,2) not null default 0,
  -- Whether what is left over at the end of a period rolls into the next one.
  -- A bill you save up for wants this, a weekly spending allowance does not.
  carry_over  boolean not null default true,
  sort_order  integer not null default 100,
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Which categories count as spending from a bucket. A bucket can cover several,
-- for example one Everyday bucket over groceries and merchandise.
create table bucket_categories (
  bucket_id   uuid not null references buckets (id) on delete cascade,
  category_id uuid not null references categories (id) on delete cascade,
  primary key (bucket_id, category_id),
  -- A category belongs to at most one bucket, otherwise spending is counted
  -- twice and the totals stop adding up.
  constraint bucket_categories_category_once unique (category_id)
);

-- What was actually put into a bucket for a period.
create table bucket_allocations (
  id            uuid primary key default gen_random_uuid(),
  bucket_id     uuid not null references buckets (id) on delete cascade,
  pay_period_id uuid not null references pay_periods (id) on delete cascade,
  allocated     numeric(12,2) not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (bucket_id, pay_period_id)
);

create index bucket_allocations_period_idx on bucket_allocations (pay_period_id);
