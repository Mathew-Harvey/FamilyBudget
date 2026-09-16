-- Levers the forecast could not see: things we could sell, and income we expect
-- but that has not started yet.

-- A motorbike or a PC is not cash, but it is a lever, so the planner should
-- know it exists without it ever counting as spendable.
create table assets (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  estimated_value numeric(12,2) not null check (estimated_value >= 0),
  notes           text,
  -- Would we actually sell it. Something we own but would not part with still
  -- belongs on the list, marked so.
  sellable        boolean not null default true,
  sold_on         date,
  sort_order      integer not null default 100,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Income that is coming but is not in the transaction history yet: a job
-- starting, a side income beginning. The forecast counts it from its start
-- date, so a runway is not pessimistic about money we are confident of.
create table expected_income (
  id           uuid primary key default gen_random_uuid(),
  label        text not null,
  amount       numeric(12,2) not null check (amount > 0),
  cadence_days integer not null check (cadence_days > 0),
  starts_on    date,
  ends_on      date,
  -- How sure we are. The planner treats these differently: a confirmed job is
  -- not the same as one we hope for.
  confidence   text not null default 'likely'
               check (confidence in ('confirmed', 'likely', 'possible')),
  notes        text,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index expected_income_active_idx on expected_income (active, starts_on);
