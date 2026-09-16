-- Stage 5: email alerts.

-- One row of settings. Alerts are off until an address is set, so nothing is
-- ever sent by surprise.
create table alert_settings (
  id                        boolean primary key default true check (id),
  enabled                   boolean not null default false,
  email_to                  text,
  runway_days_threshold     integer not null default 21,
  large_transaction_amount  numeric(12,2) not null default 500.00,
  notify_bucket_overspend   boolean not null default true,
  notify_sync_failure       boolean not null default true,
  notify_unreviewed         boolean not null default true,
  updated_at                timestamptz not null default now()
);

insert into alert_settings (id) values (true);

-- Every alert considered, whether or not it was sent. The dedupe key is what
-- stops the same warning arriving twice a day: it only changes when the
-- situation meaningfully changes.
create table alert_log (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,
  dedupe_key  text not null,
  subject     text not null,
  body        text not null,
  status      text not null default 'pending'
              check (status in ('pending', 'sent', 'failed', 'skipped', 'suppressed')),
  error       text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

create index alert_log_dedupe_idx on alert_log (kind, dedupe_key, created_at desc);
create index alert_log_created_idx on alert_log (created_at desc);

alter table sync_runs
  add column alerts_sent integer not null default 0;
