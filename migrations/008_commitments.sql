-- Stage 4: recurring commitments, detected from history, used by the forecast.

create table commitments (
  id             uuid primary key default gen_random_uuid(),
  -- A stable key derived from the description, so re-running detection updates
  -- the same row rather than making a new one.
  match_key      text not null unique,
  label          text not null,
  category_id    uuid references categories (id) on delete set null,
  -- Negative, like every other outflow in this app.
  typical_amount numeric(12,2) not null,
  cadence_days   integer not null,
  occurrences    integer not null default 0,
  -- How regular the gaps are, 0 to 1. Detection only keeps the reliable ones.
  regularity     numeric(4,3) not null default 0,
  last_seen      date,
  next_due       date,
  -- Set by hand in the UI: a commitment we know about that history has not
  -- shown yet, or one we want the forecast to ignore.
  source         text not null default 'detected' check (source in ('detected', 'manual')),
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index commitments_next_due_idx on commitments (next_due) where active;

alter table sync_runs
  add column commitments_found integer not null default 0;
