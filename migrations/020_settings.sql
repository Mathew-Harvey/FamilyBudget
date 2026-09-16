-- A small key and value store for household choices that do not deserve a
-- table of their own.
--
-- The first one is the change point: the date the household last changed shape,
-- which is what "did the cut stick" measures from. It can be guessed at from
-- the data, and the guess is usually right, but only a person knows why the
-- spending changed. The guess is a suggestion and the stored value wins, for
-- the same reason the pay cycle is configured rather than inferred.
create table if not exists settings (
  key         text primary key,
  value       text,
  updated_at  timestamptz not null default now()
);
