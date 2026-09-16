-- Periodic analysis by Claude, and manual accounts for debts open banking
-- cannot see.

-- A credit card or personal loan we hold elsewhere is still part of the
-- picture, so it gets an account with no Redbark id and a balance entered by
-- hand. The roles list grows to name them.
alter table accounts drop constraint if exists accounts_role_check;
alter table accounts
  add constraint accounts_role_check check (role in (
    'joint_everyday', 'personal_everyday', 'personal_savings',
    'mortgage', 'credit_card', 'personal_loan', 'other'
  ));

-- Where a manually entered balance came from, so it is obvious in the UI that
-- nobody is syncing it.
alter table accounts
  add column notes text,
  add column balance_updated_by text;

create table analyses (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null default 'periodic'
                check (kind in ('periodic', 'on_demand', 'question', 'expense_plan')),
  -- What was asked, when someone asked something specific.
  question      text,
  -- Exactly what was sent, kept so an answer can always be checked against the
  -- figures it was given.
  snapshot      jsonb not null,
  result        jsonb not null,
  model         text,
  input_tokens  integer,
  output_tokens integer,
  created_at    timestamptz not null default now()
);

create index analyses_created_idx on analyses (created_at desc);
create index analyses_kind_idx on analyses (kind, created_at desc);

create table analyst_settings (
  id           boolean primary key default true check (id),
  -- Off until someone turns it on. Analysis sends financial figures to the
  -- Claude API, so it is never on by surprise.
  enabled      boolean not null default false,
  cadence_days integer not null default 7,
  effort       text not null default 'high' check (effort in ('low', 'medium', 'high', 'xhigh', 'max')),
  last_run_at  timestamptz,
  updated_at   timestamptz not null default now()
);

insert into analyst_settings (id) values (true);

alter table sync_runs
  add column analysis_run boolean not null default false;
