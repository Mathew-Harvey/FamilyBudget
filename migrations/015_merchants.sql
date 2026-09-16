-- Making a bank statement legible.
--
-- A description is full of processor prefixes, store numbers and truncation.
-- merchant_key reduces it to something stable, and merchants holds what we call
-- that place and what it actually is. The key is computed in JavaScript and
-- stored, never recomputed in SQL: one definition, for the same reason
-- matchKeyFor has one.
create table merchants (
  match_key    text primary key,
  -- What to show. Two keys that are really the same place, "The Little Bakery"
  -- and a truncated "The Little Baker", are merged by sharing a display name,
  -- which needs no alias table.
  display_name text not null,
  -- Plain English: what this place is and why money goes there. Filled in by
  -- hand or worked out by Claude.
  what_it_is   text,
  -- Where spending here usually belongs.
  category_id  uuid references categories (id) on delete set null,
  source       text not null default 'auto' check (source in ('auto', 'manual', 'claude')),
  -- Things we consider essential are marked, so the trimming view can put them
  -- aside rather than suggesting the household stop paying for power.
  essential    boolean,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index merchants_display_idx on merchants (display_name);

alter table transactions add column merchant_key text;

create index transactions_merchant_idx on transactions (merchant_key);
