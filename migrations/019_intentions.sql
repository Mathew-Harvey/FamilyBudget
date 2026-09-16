-- Decisions, with a date and a way to check them.
--
-- "We should spend less on takeaway" changes nothing. The research on this is
-- unusually clear: a goal paired with a specific plan for when and where it
-- applies is followed through far more often than the same goal on its own.
-- So a decision made here is stored as a thing, a trigger, and a date, not as
-- a good feeling at the end of a session with the numbers.
--
-- The important column is merchant_key. A tick box records what someone
-- intended. Checking whether the charges actually stopped records what
-- happened. Those are different, and only the second one is worth reporting,
-- so this table is verified against the transactions rather than trusted.
create table if not exists intentions (
  id               uuid primary key default gen_random_uuid(),
  what             text not null,
  -- The "when" half of an implementation intention: the situation that should
  -- trigger the action. "When the renewal email arrives", "before the weekly
  -- shop". Optional, because some decisions are a single act.
  trigger_text     text,
  -- What to watch to see whether it happened. Null when nothing observable
  -- would change, in which case this stays a self reported decision and is
  -- labelled as one.
  merchant_key     text,
  -- What we expect it to be worth per month, for ranking and for honesty about
  -- whether the effort was worth it.
  target_monthly   numeric(12,2),
  starts_on        date not null default current_date,
  review_on        date,
  status           text not null default 'open' check (status in ('open', 'kept', 'slipped', 'dropped')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists intentions_status_idx on intentions (status, review_on);

-- The household's own goals, so a trade off can be expressed as "this delays
-- the bike by five weeks" rather than as a number of dollars. A dollar is
-- abstract. A date the thing arrives is not.
create table if not exists goals (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  target       numeric(12,2) not null,
  saved        numeric(12,2) not null default 0,
  wanted_by    date,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
